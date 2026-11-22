import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import type { RunOutcome } from "../../../src/adapter/types.js";
import {
  Engine,
  type EngineEvents,
  type EngineOptions,
} from "../../../src/engine/engine.js";
import { loadDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";
import type {
  GateRow,
  StageRunRow,
  TransitionRow,
} from "../../../src/store/types.js";
import { inline, lastToken, type Rig, rig } from "./engine-helpers.js";

const rigs: Rig[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const RECONCILE = "engine:reconcile";

async function make(...args: Parameters<typeof rig>): Promise<Rig> {
  const r = await rig(...args);
  rigs.push(r);
  return r;
}

/** A run whose first draft turn the rig's engine dispatched (`fr_1`). */
async function started(r: Rig): Promise<{ runId: string; token: string }> {
  const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
  await r.engine.tick();
  return { runId, token: lastToken(r.adapter) };
}

/** A second engine on the rig's store, as after a restart of the process. */
function restarted(
  r: Rig,
  adapter: FakeAdapter = new FakeAdapter(),
  over: Partial<EngineOptions> = {},
): Engine {
  const engine = new Engine({
    store: r.store,
    adapter,
    registry: createRegistry(),
    clock: r.clock,
    definitions: r.source,
    ...over,
  });
  engines.push(engine);
  return engine;
}

const rows = (r: Rig, runId: string): StageRunRow[] =>
  r.store.tx((t) =>
    t.listStageRuns({ limit: 1000 }).filter((s) => s.runId === runId),
  );

const log = (r: Rig, runId: string): TransitionRow[] =>
  r.store.tx((t) => t.transitions(runId));

const by = (r: Rig, runId: string) =>
  log(r, runId).map((x) => [x.event, x.actor]);

describe("restart reconciliation", () => {
  it("unknown adapter run becomes lost and retries", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const before = log(r, runId).length;
    // The harness restarted too: it no longer knows fr_1.
    const adapter = new FakeAdapter();
    const engine = restarted(r, adapter);
    await engine.reconcile();

    const [lost, retry] = rows(r, runId);
    expect(lost).toMatchObject({
      state: "failed",
      ending: "lost",
      attempt: 1,
      adapterRunId: "fr_1",
      dispatchedAt: null,
    });
    // The hash stays, so a late completion is recognised and refused.
    expect(lost?.tokenHash).not.toBeNull();
    expect(retry).toMatchObject({
      state: "submitted",
      attempt: 2,
      retryIndex: 1,
      idempotencyKey: `${runId}:draft:2`,
    });
    const written = log(r, runId).slice(before);
    expect(written.map((x) => [x.event, x.actor])).toEqual([
      ["lost", RECONCILE],
      ["stage_submitted", RECONCILE],
    ]);
    expect(written[0]?.detail).toMatchObject({
      adapterRunId: "fr_1",
      retry: { attempt: 2 },
    });

    const late = await engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    expect(late).toEqual({
      ok: false,
      error: expect.stringMatching(/has ended/),
    });
    const refused = log(r, runId).find((x) => x.event === "completion_refused");
    expect(refused?.detail).toEqual({ reason: "attempt ended" });

    await engine.tick();
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:2`,
    ]);
    expect(rows(r, runId)[1]).toMatchObject({ state: "working" });
  });

  it("a lost attempt with no retry left takes the failed end", async () => {
    const r = await make();
    const { runId } = await started(r);
    // The first restart loses attempt 1 and retries it.
    const first = restarted(r);
    await first.reconcile();
    await first.tick();
    // The second loses attempt 2: the review loop retries once.
    await restarted(r).reconcile();
    expect(rows(r, runId).map((s) => [s.attempt, s.ending])).toEqual([
      [1, "lost"],
      [2, "lost"],
    ]);
    expect(r.engine.status(runId).run).toMatchObject({
      status: "failed",
      currentStage: "failed",
    });
    expect(by(r, runId).slice(-2)).toEqual([
      ["lost", RECONCILE],
      ["run_ended", RECONCILE],
    ]);
  });

  it("ended adapter run is classified on start", async () => {
    const r = await make();
    const { runId } = await started(r);
    const before = log(r, runId).length;
    const adapter = new FakeAdapter();
    const ended: RunOutcome = {
      state: "ended",
      ending: "ok",
      runtime: { provider: "p1", model: "m1" },
    };
    adapter.setOutcome("fr_1", ended);
    const engine = restarted(r, adapter);
    await engine.start();
    await engine.stop();

    // Ended without stage_complete or a note: no_result, retried, and the
    // retry dispatched by the first tick after reconciliation.
    const [first, retry] = rows(r, runId);
    expect(first).toMatchObject({
      state: "failed",
      ending: "no_result",
      runtime: { provider: "p1", model: "m1" },
    });
    expect(retry).toMatchObject({ attempt: 2, state: "working" });
    expect(by(r, runId).slice(before, before + 2)).toEqual([
      ["no_result", RECONCILE],
      ["stage_submitted", RECONCILE],
    ]);
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:2`,
    ]);
  });

  it("an ended turn is classified with its note and turn count, as on any tick", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    await r.engine.progress({ token, note: "half done; next: the rest" });
    const before = log(r, runId).length;
    const adapter = new FakeAdapter();
    adapter.setOutcome("fr_1", { state: "ended", ending: "ok" });
    // The draft stage allows one turn, so the continuation ends no_result.
    await restarted(r, adapter).reconcile();
    expect(by(r, runId).slice(before, before + 1)).toEqual([
      ["no_result", RECONCILE],
    ]);
    expect(log(r, runId)[before]?.detail).toMatchObject({
      turns: { used: 1, max: 1 },
    });
  });

  it("running adapter run is kept", async () => {
    const r = await make();
    const { runId } = await started(r);
    const before = log(r, runId);
    // The harness outlived the engine and still runs fr_1.
    await restarted(r, r.adapter).reconcile();
    expect(log(r, runId)).toEqual(before);
    expect(rows(r, runId)).toHaveLength(1);
    expect(rows(r, runId)[0]).toMatchObject({
      state: "working",
      adapterRunId: "fr_1",
    });
  });

  it("a transport error keeps the row; the next tick settles it", async () => {
    const r = await make();
    const { runId } = await started(r);
    const before = log(r, runId);
    const adapter = new FakeAdapter();
    let down = true;
    adapter.beforeRead = () => {
      if (down) throw new Error("harness unreachable");
    };
    const engine = restarted(r, adapter);
    await engine.reconcile();
    expect(log(r, runId)).toEqual(before);
    expect(rows(r, runId)[0]).toMatchObject({ state: "working" });

    // The harness answers now, and does not know the turn: it was lost in
    // the restart even though reconciliation could not tell at first.
    down = false;
    await engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "lost",
    });
    expect(by(r, runId).slice(before.length, before.length + 2)).toEqual([
      ["lost", RECONCILE],
      ["stage_submitted", RECONCILE],
    ]);
  });

  it("capabilities unreadable at start: the turn is settled once they are", async () => {
    const r = await make();
    const { runId } = await started(r);
    const adapter = new FakeAdapter();
    const caps = adapter.caps;
    let ready = false;
    adapter.capabilities = async () => {
      if (!ready) throw new Error("not ready");
      return caps;
    };
    adapter.setOutcome("fr_1", { state: "ended", ending: "error" });
    const engine = restarted(r, adapter);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.reconcile();
      await engine.tick();
      expect(logged).toHaveBeenCalledWith("sekaisen: not ready");
    } finally {
      logged.mockRestore();
    }
    expect(rows(r, runId)[0]).toMatchObject({ state: "working" });
    ready = true;
    await engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "turn_error",
    });
    expect(log(r, runId).find((x) => x.event === "turn_error")?.actor).toBe(
      RECONCILE,
    );
  });

  it("a turn the harness forgets after reconciliation is left to its deadline", async () => {
    const r = await make();
    const { runId } = await started(r);
    const engine = restarted(r, r.adapter);
    await engine.reconcile();
    // Reconciled as running; a later unknown is not a restart's doing.
    const forgetful = new FakeAdapter();
    r.adapter.readRunOutcome = (id) => forgetful.readRunOutcome(id);
    await engine.tick();
    expect(rows(r, runId)).toHaveLength(1);
    expect(rows(r, runId)[0]).toMatchObject({ state: "working" });
  });

  it("a turn lost in the restart is lost even past its deadline", async () => {
    const r = await make();
    const { runId } = await started(r);
    r.clock.advance(30 * MIN);
    const adapter = new FakeAdapter();
    await restarted(r, adapter).reconcile();
    const [lost, retry] = rows(r, runId);
    expect(lost).toMatchObject({ state: "failed", ending: "lost" });
    expect(retry).toMatchObject({
      state: "submitted",
      idempotencyKey: `${runId}:draft:2`,
    });
    expect(log(r, runId).find((x) => x.event === "lost")?.actor).toBe(
      RECONCILE,
    );
    // The harness does not know the turn: nothing to abort.
    expect(adapter.aborted).toEqual([]);
  });

  it("a turn still running past its deadline times out", async () => {
    const r = await make();
    const { runId } = await started(r);
    r.clock.advance(30 * MIN);
    await restarted(r, r.adapter).reconcile();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "timeout",
      abortRunId: null,
    });
    expect(log(r, runId).find((x) => x.event === "timeout")?.actor).toBe(
      RECONCILE,
    );
    // timeout is not in the review loop's retry list.
    expect(r.engine.status(runId).run.status).toBe("failed");
    expect(r.adapter.aborted).toEqual(["fr_1"]);
  });

  it("an overdue turn the harness cannot be asked about waits for it", async () => {
    const r = await make();
    const { runId } = await started(r);
    r.clock.advance(30 * MIN);
    const adapter = new FakeAdapter();
    let down = true;
    adapter.beforeRead = () => {
      if (down) throw new Error("harness unreachable");
    };
    const engine = restarted(r, adapter);
    await engine.reconcile();
    await engine.tick();
    expect(rows(r, runId)).toHaveLength(1);
    expect(rows(r, runId)[0]).toMatchObject({ state: "working" });
    down = false;
    await engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({ ending: "lost" });
  });

  it("a second reconcile writes nothing new", async () => {
    const r = await make();
    const lostRun = await started(r);
    const keptRun = await started(r);
    // fr_1 was lost in the restart; fr_2 still runs.
    const adapter = new FakeAdapter();
    const known = r.adapter;
    adapter.readRunOutcome = async (id) =>
      id === "fr_2" ? known.readRunOutcome(id) : { state: "unknown" };
    const engine = restarted(r, adapter);
    await engine.reconcile();
    expect(rows(r, lostRun.runId).map((s) => s.state)).toEqual([
      "failed",
      "submitted",
    ]);
    const snapshot = () =>
      [lostRun.runId, keptRun.runId].map((id) => ({
        rows: rows(r, id),
        log: log(r, id),
      }));
    const once = snapshot();
    await engine.reconcile();
    await restarted(r, adapter).reconcile();
    expect(snapshot()).toEqual(once);
  });

  it("does nothing when the engine only takes completions", async () => {
    const r = await make();
    const { runId } = await started(r);
    const before = log(r, runId);
    const adapter = new FakeAdapter();
    const engine = restarted(r, adapter, { dispatch: false });
    await engine.start();
    expect(log(r, runId)).toEqual(before);
    expect(rows(r, runId)[0]).toMatchObject({ state: "working" });
  });
});

describe("gates and waits across a restart", () => {
  it("gates and waits keep their stored deadlines across restart", async () => {
    const r = await make();
    r.source.defs.set(
      "paced",
      inline({
        id: "paced",
        start: "w",
        inputs: { type: "object" },
        stages: {
          w: { type: "wait", for: 10 * MIN, next: "done" },
          done: { type: "end", status: "completed" },
        },
      }),
    );
    r.source.defs.set(
      "held",
      inline({
        id: "held",
        start: "g",
        inputs: { type: "object" },
        stages: {
          g: {
            type: "gate",
            who: "operator",
            timeout: HOUR,
            onTimeout: { remind: 10 * MIN },
            outcomes: { go: { next: "done" } },
          },
          done: { type: "end", status: "completed" },
        },
      }),
    );
    const paced = await r.engine.startRun("paced", {});
    const held = await r.engine.startRun("held", {});
    await r.engine.tick();
    const t0 = r.clock.now();
    const gateId = rows(r, held.runId)[0]?.stageRunId ?? "";
    const gate = (): GateRow | undefined =>
      r.store.tx((t) => t.getGate(gateId));
    expect(rows(r, paced.runId)[0]).toMatchObject({
      state: "working",
      wakeAt: t0 + 10 * MIN,
    });
    expect(gate()?.remindAt).toBe(t0 + HOUR);
    const snapshot = () =>
      [paced.runId, held.runId].map((id) => ({
        rows: rows(r, id),
        log: log(r, id),
        gate: gate(),
      }));

    // Down for five minutes, then a restart on a harness that knows nothing.
    r.clock.advance(5 * MIN);
    const before = snapshot();
    const engine = restarted(r);
    const reminders: Array<EngineEvents["gate"]> = [];
    engine.on("gate", (e) => reminders.push(e));
    await engine.start();
    await engine.stop();
    expect(snapshot()).toEqual(before);

    // The wait wakes at its stored time, not ten minutes after the restart.
    r.clock.advance(5 * MIN - 1);
    await engine.tick();
    expect(engine.status(paced.runId).run.status).toBe("working");
    r.clock.advance(1);
    await engine.tick();
    expect(engine.status(paced.runId).run.status).toBe("completed");

    // The gate reminds at its stored time too.
    r.clock.advance(HOUR - 10 * MIN - 1);
    await engine.tick();
    expect(reminders).toHaveLength(0);
    r.clock.advance(1);
    await engine.tick();
    expect(reminders).toHaveLength(1);
    expect(gate()?.remindAt).toBe(t0 + HOUR + 10 * MIN);
  });
});

describe("poll gates across a restart", () => {
  it("a poll gate polls at its stored time after a restart", async () => {
    const polls: number[] = [];
    let ready = false;
    let now = () => 0;
    const registry = createRegistry();
    registry.facts.set("demo.ready", async () => {
      polls.push(now());
      return ready;
    });
    const r = await make({ registry });
    now = () => r.clock.now();
    r.source.defs.set(
      "polled",
      inline({
        id: "polled",
        start: "g",
        inputs: { type: "object" },
        stages: {
          g: {
            type: "gate",
            poll: { fact: "demo.ready", every: 10 * MIN },
            timeout: 24 * HOUR,
            onTimeout: { remind: 24 * HOUR },
            outcomes: { go: { next: "done" } },
          },
          done: { type: "end", status: "completed" },
        },
      }),
    );
    const { runId } = await r.engine.startRun("polled", {});
    await r.engine.tick();
    const t0 = r.clock.now();
    const gateId = rows(r, runId)[0]?.stageRunId ?? "";
    const gate = (): GateRow | undefined =>
      r.store.tx((t) => t.getGate(gateId));
    expect(polls).toEqual([t0]);
    expect(gate()?.pollAt).toBe(t0 + 10 * MIN);

    r.clock.advance(5 * MIN);
    const before = { rows: rows(r, runId), log: log(r, runId), gate: gate() };
    const engine = restarted(r, new FakeAdapter(), { registry });
    await engine.start();
    await engine.stop();
    expect({ rows: rows(r, runId), log: log(r, runId), gate: gate() }).toEqual(
      before,
    );

    ready = true;
    r.clock.advance(5 * MIN - 1);
    await engine.tick();
    expect(polls).toEqual([t0]);
    r.clock.advance(1);
    await engine.tick();
    expect(polls).toEqual([t0, t0 + 10 * MIN]);
    expect(engine.status(runId).run.status).toBe("completed");
  });
});

describe("reconciliation bounds", () => {
  it("covers every turn in flight, past one tick's batch, and says so", async () => {
    const r = await make();
    r.adapter.caps = { ...r.adapter.caps, maxConcurrent: 500 };
    const runIds: string[] = [];
    for (let i = 0; i < 120; i++) {
      runIds.push(
        (await r.engine.startRun("review-loop", { topic: `t${i}` })).runId,
      );
    }
    await r.engine.tick();
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(120);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await restarted(r).reconcile();
      expect(logged).toHaveBeenCalledWith(
        expect.stringMatching(/reconciling 120 turns in flight/),
      );
    } finally {
      logged.mockRestore();
    }
    for (const runId of runIds) {
      expect(rows(r, runId)[0]?.ending).toBe("lost");
    }
  });

  it("a stage with no retry of its own retries a lost attempt and the run goes on", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-reconcile-"));
    try {
      mkdirSync(path.join(dir, "briefs"));
      writeFileSync(
        path.join(dir, "briefs/solo.md"),
        "Write {{inputs.topic}}.\n",
      );
      writeFileSync(
        path.join(dir, "pipeline.yaml"),
        [
          "format: 1",
          "id: solo",
          "version: 1",
          "start: solo",
          "stages:",
          "  solo:",
          "    type: agent",
          "    agent: drafter",
          "    session: run",
          "    brief: briefs/solo.md",
          "    outcomes:",
          "      done: { next: done }",
          "  done: { type: end, status: completed }",
          "  failed: { type: end, status: failed }",
          "",
        ].join("\n"),
      );
      const loaded = await loadDefinition(path.join(dir, "pipeline.yaml"));
      expect(loaded.problems).toEqual([]);
      const stage = loaded.def.stages.solo;
      expect(stage?.type === "agent" && stage.retry).toEqual({
        max: 1,
        on: ["lost"],
      });
      const r = await make();
      r.source.defs.set("solo", loaded);
      const { runId } = await r.engine.startRun("solo", { topic: "x" });
      await r.engine.tick();

      const adapter = new FakeAdapter();
      const engine = restarted(r, adapter);
      await engine.start();
      await engine.stop();
      const [lost, retry] = rows(r, runId);
      expect(lost).toMatchObject({ ending: "lost" });
      expect(retry).toMatchObject({
        state: "working",
        idempotencyKey: `${runId}:solo:2`,
      });
      expect(engine.status(runId).run.status).toBe("working");
      const token = /Your completion token is: (\S+)/.exec(
        adapter.calls[0]?.message ?? "",
      )?.[1];
      expect(
        await engine.complete({ token: token ?? "", outcome: "done" }),
      ).toMatchObject({ ok: true, next: "done" });
      expect(engine.status(runId).run.status).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an overdue turn the harness never answers about times out after a grace", async () => {
    const r = await make();
    const { runId } = await started(r);
    r.clock.advance(30 * MIN);
    const adapter = new FakeAdapter();
    adapter.beforeRead = () => {
      throw new Error("harness unreachable");
    };
    const engine = restarted(r, adapter, { adapterCallTimeoutMs: 1000 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.reconcile();
      // Ten call timeouts past the deadline at most.
      r.clock.advance(10 * 1000);
      await engine.tick();
      expect(rows(r, runId)[0]).toMatchObject({ state: "working" });
      // Each failed read is reported.
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("harness unreachable"),
      );
      r.clock.advance(1);
      await engine.tick();
    } finally {
      logged.mockRestore();
    }
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "timeout",
    });
    expect(log(r, runId).find((x) => x.event === "timeout")?.actor).toBe(
      RECONCILE,
    );
  });

  it("a tick waits for a reconciliation in progress", async () => {
    const r = await make();
    const { runId } = await started(r);
    const adapter = new FakeAdapter();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    adapter.beforeRead = async () => {
      reads++;
      await gate;
    };
    const engine = restarted(r, adapter);
    const reconciling = engine.reconcile();
    const ticking = engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const whileBlocked = reads;
    release();
    await reconciling;
    await ticking;
    // Only reconciliation read the turn; the tick waited for it.
    expect(whileBlocked).toBe(1);
    expect(reads).toBe(1);
    expect(log(r, runId).filter((x) => x.event === "lost")).toHaveLength(1);
    // The tick ran after reconciliation and dispatched the retry.
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:2`,
    ]);
  });

  it("a later reconcile only re-checks; it does not hold new turns past their deadline", async () => {
    const r = await make();
    const engine = r.engine;
    await engine.start();
    await engine.stop();
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await engine.tick();
    r.clock.advance(30 * MIN);
    r.adapter.beforeRead = () => {
      throw new Error("harness unreachable");
    };
    const before = log(r, runId);
    await engine.reconcile();
    expect(log(r, runId)).toEqual(before);
    // Not one the start-up found: its deadline applies as on any tick.
    await engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "timeout",
    });
    expect(log(r, runId).find((x) => x.event === "timeout")?.actor).toBe(
      "engine",
    );
  });

  it("drops a stage run from reconciliation once it is no longer working", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const adapter = new FakeAdapter();
    adapter.beforeRead = () => {
      throw new Error("harness unreachable");
    };
    const engine = restarted(r, adapter);
    const pending = () =>
      (engine as unknown as { unreconciled: Set<string> }).unreconciled.size;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.reconcile();
      expect(pending()).toBe(1);
      expect(
        await engine.complete({
          token,
          outcome: "drafted",
          fields: { pr_url: "u" },
        }),
      ).toMatchObject({ ok: true });
      await engine.tick();
    } finally {
      logged.mockRestore();
    }
    expect(pending()).toBe(0);
    expect(rows(r, runId)[0]?.state).toBe("completed");
  });
});

describe("FakeAdapter.adopt", () => {
  it("hands out later ids after the adopted one", async () => {
    const adapter = new FakeAdapter();
    adapter.adopt("k1", "fr_7");
    const base = {
      agent: "a",
      sessionKey: "s",
      message: "m",
      capMs: 1,
      tools: [],
    };
    expect(await adapter.startTurn({ ...base, idempotencyKey: "k1" })).toEqual({
      runId: "fr_7",
    });
    expect(await adapter.startTurn({ ...base, idempotencyKey: "k2" })).toEqual({
      runId: "fr_8",
    });
    adapter.adopt("k3", "fr_2");
    adapter.adopt("k4", "harness-run");
    expect(await adapter.startTurn({ ...base, idempotencyKey: "k5" })).toEqual({
      runId: "fr_9",
    });
  });
});
