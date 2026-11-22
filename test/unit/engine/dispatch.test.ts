import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderBrief } from "../../../src/engine/brief.js";
import { Engine } from "../../../src/engine/engine.js";
import { hashToken } from "../../../src/engine/tokens.js";
import type { LoadedDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type { Store } from "../../../src/store/types.js";
import {
  lastToken,
  type Rig,
  reviewLoop,
  rig,
  tokenOf,
} from "./engine-helpers.js";

const rigs: Rig[] = [];
async function make(...args: Parameters<typeof rig>): Promise<Rig> {
  const r = await rig(...args);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const stageRuns = (store: Store, runId: string) =>
  store.tx((t) =>
    t
      .listStageRuns({ limit: 100 })
      .filter((s) => s.runId === runId)
      .map((s) => ({ stage: s.stage, state: s.state, attempt: s.attempt })),
  );

describe("startRun", () => {
  it("startRun creates a submitted first stage and a transition", async () => {
    const { engine, store } = await make();
    const { runId } = await engine.startRun(
      "review-loop",
      { topic: "rust" },
      { actor: "test" },
    );
    expect(runId).toMatch(/^r_/);
    const view = engine.status(runId);
    expect(view.run.status).toBe("working");
    expect(view.run.currentStage).toBe("draft");
    expect(view.live?.stage).toBe("draft");
    expect(view.live?.state).toBe("submitted");
    expect(view.live?.attempt).toBe(1);
    expect(view.live?.visit).toBe(1);
    expect(view.live?.retryIndex).toBe(0);
    expect(view.live?.idempotencyKey).toBe(`${runId}:draft:1`);
    expect(view.transitions.map((t) => [t.event, t.toState, t.actor])).toEqual([
      ["run_created", "working", "test"],
      ["stage_submitted", "submitted", "test"],
    ]);
    // The definition is pinned in the store with its briefs.
    const row = store.tx((t) =>
      t.getDefinition("review-loop", view.run.defHash),
    );
    expect(row?.briefs["briefs/draft.md"]).toContain("Write a short draft");
  });

  it("invalid inputs are rejected by startRun", async () => {
    const { engine, store } = await make();
    await expect(engine.startRun("review-loop", { title: 1 })).rejects.toThrow(
      /invalid inputs.*topic/,
    );
    await expect(engine.startRun("review-loop", "rust")).rejects.toThrow(
      /invalid inputs/,
    );
    await expect(engine.startRun("missing", {})).rejects.toThrow(
      /no definition/,
    );
    expect(store.tx((t) => t.listRuns({ limit: 10 }))).toEqual([]);
  });

  it("refuses a definition with problems, and non-object inputs without a schema", async () => {
    const base = await reviewLoop();
    const broken: LoadedDefinition = { ...base, problems: ["bad"] };
    const { engine, source } = await make();
    source.defs.set("review-loop", broken);
    await expect(
      engine.startRun("review-loop", { topic: "x" }),
    ).rejects.toThrow(/bad/);
    const { inputs: _drop, ...def } = base.def;
    source.defs.set("review-loop", { ...base, hash: "noschema", def });
    await expect(engine.startRun("review-loop", [1])).rejects.toThrow(
      /inputs must be an object/,
    );
    await expect(engine.startRun("review-loop", undefined)).resolves.toEqual({
      runId: expect.stringMatching(/^r_/),
    });
  });
});

describe("dispatch", () => {
  it("tick dispatches with idempotency key r:draft:1 and the rendered brief", async () => {
    const { engine, adapter, clock } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    await engine.tick();
    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.idempotencyKey).toBe(`${runId}:draft:1`);
    expect(call?.agent).toBe("drafter");
    expect(call?.sessionKey).toBe(`run:${runId}:drafter`);
    expect(call?.tools).toEqual(["stage_complete", "stage_progress"]);
    expect(call?.capMs).toBe(600_000);
    expect(adapter.opened).toEqual([
      { agent: "drafter", key: `run:${runId}:drafter` },
    ]);
    const template = readFileSync(
      path.resolve("test/fixtures/defs/review-loop/briefs/draft.md"),
      "utf8",
    );
    const loaded = await reviewLoop();
    const draft = loaded.def.stages.draft;
    if (draft?.type !== "agent") throw new Error("fixture changed");
    const token = tokenOf(call?.message ?? "");
    expect(call?.message).toBe(
      renderBrief(template, {
        inputs: { topic: "rust" },
        runId,
        stages: {},
        outcomes: draft.outcomes,
        token,
      }),
    );

    const live = engine.status(runId).live;
    expect(live?.state).toBe("working");
    expect(live?.adapterRunId).toBe("fr_1");
    expect(live?.sessionKey).toBe(`run:${runId}:drafter`);
    expect(live?.dispatchSeq).toBe(1);
    expect(live?.turnsUsed).toBe(1);
    expect(live?.startedAt).toBe(clock.now());
    expect(live?.deadlineAt).toBe(clock.now() + 1_800_000);
    expect(live?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(live?.tokenHash).not.toContain(token);
    const last = engine.status(runId).transitions.at(-1);
    expect([last?.fromState, last?.toState, last?.event]).toEqual([
      "submitted",
      "working",
      "turn_started",
    ]);

    // A second tick has nothing to dispatch.
    await engine.tick();
    expect(adapter.calls).toHaveLength(1);
  });

  it("a project session key uses the project input", async () => {
    const base = await reviewLoop();
    const def = structuredClone(base.def);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("fixture changed");
    draft.session = "project";
    const { engine, adapter, source } = await make();
    source.defs.set("review-loop", { ...base, hash: "project", def });
    await engine.startRun("review-loop", { topic: "t", project: "site" });
    const { runId } = await engine.startRun("review-loop", { topic: "t" });
    await engine.tick();
    expect(adapter.calls.map((c) => c.sessionKey)).toEqual([
      "project:site:drafter",
      `project:${runId}:drafter`,
    ]);
  });

  it("a refused startTurn is retried with the same key and message", async () => {
    const { engine, adapter } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    adapter.beforeStart = () => {
      throw new Error("harness down");
    };
    await engine.tick();
    expect(engine.status(runId).live?.state).toBe("submitted");
    expect(engine.status(runId).transitions.at(-1)?.event).toBe(
      "turn_start_failed",
    );
    adapter.beforeStart = undefined;
    await engine.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.idempotencyKey).toBe(`${runId}:draft:1`);
    expect(adapter.calls[1]?.message).toBe(adapter.calls[0]?.message);
    const live = engine.status(runId).live;
    expect(live?.state).toBe("working");
    expect(live?.dispatchSeq).toBe(1);
    // The token in the resent message is the live one.
    const done = await engine.complete({
      token: lastToken(adapter),
      outcome: "blocked",
      fields: { reason: "x" },
    });
    expect(done.ok).toBe(true);
  });

  it("an agent that completes before the turn is recorded is not aborted", async () => {
    const { engine, adapter } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    adapter.beforeStart = async (p) => {
      const r = await engine.complete({
        token: tokenOf(p.message),
        outcome: "drafted",
        fields: { pr_url: "u" },
        callerAgent: "drafter",
      });
      expect(r).toEqual({ ok: true, next: "check", applied: "now" });
    };
    await engine.tick();
    adapter.beforeStart = undefined;
    expect(adapter.aborted).toEqual([]);
    const view = engine.status(runId);
    expect(view.live?.stage).toBe("check");
    const events = view.transitions.map((t) => t.event);
    expect(events).toContain("turn_start_superseded");
  });

  it("a turn whose stage run was canceled meanwhile is aborted", async () => {
    const { engine, adapter, store } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    adapter.beforeStart = () => {
      store.tx((t) => {
        const live = t.liveStageRun(runId);
        if (!live) throw new Error("no live row");
        t.updateStageRunIf(
          live.stageRunId,
          { state: "submitted", attempt: 1 },
          { state: "canceled", tokenHash: null },
        );
      });
    };
    await engine.tick();
    expect(adapter.aborted).toEqual(["fr_1"]);
    expect(engine.status(runId).transitions.at(-1)?.event).toBe(
      "turn_start_superseded",
    );
  });

  it("the tick opens the operator gate after the agents", async () => {
    const { engine, adapter, store } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    await engine.tick();
    await engine.complete({
      token: lastToken(adapter),
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    await engine.tick();
    await engine.complete({ token: lastToken(adapter), outcome: "pass" });
    await engine.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(stageRuns(store, runId)).toEqual([
      { stage: "draft", state: "completed", attempt: 1 },
      { stage: "check", state: "completed", attempt: 1 },
      { stage: "publish", state: "input_required", attempt: 1 },
    ]);
    expect(engine.status(runId).run.status).toBe("input_required");
  });

  it("a stage run whose brief cannot be rendered is rejected, not retried", async () => {
    const base = await reviewLoop();
    const { engine, adapter, source } = await make();
    source.defs.set("review-loop", { ...base, hash: "nobrief", briefs: {} });
    const { runId: broken } = await engine.startRun("review-loop", {
      topic: "a",
    });
    source.defs.set("review-loop", base);
    const { runId: fine } = await engine.startRun("review-loop", {
      topic: "b",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.tick();
      await engine.tick();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${fine}:draft:1`,
    ]);
    const view = engine.status(broken);
    expect(view.live).toBeUndefined();
    expect(view.run.status).toBe("failed");
    const rejected = view.transitions.find((x) => x.event === "stage_rejected");
    expect(rejected).toMatchObject({
      fromState: "submitted",
      toState: "rejected",
    });
    expect(rejected?.detail).toEqual({
      reason: "brief briefs/draft.md is missing from the definition",
    });
    expect(view.transitions.at(-1)).toMatchObject({
      event: "stage_rejected",
      toState: "failed",
    });
  });

  it("a store error while rendering the brief is not a rejection", async () => {
    const store = openSqliteStore(":memory:");
    let failing = false;
    // A store whose reads of completed stages fail while `failing` is set.
    const flaky: Store = {
      close: () => store.close(),
      tx: (fn) =>
        store.tx((t) =>
          fn(
            new Proxy(t, {
              get(target, prop) {
                if (prop === "latestCompleted" && failing) {
                  return () => {
                    throw new Error("disk I/O error");
                  };
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === "function" ? v.bind(target) : v;
              },
            }),
          ),
        ),
    };
    const { engine, adapter } = await make({ store: flaky });
    const { runId } = await engine.startRun("review-loop", { topic: "a" });
    failing = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.tick();
      expect(logged).toHaveBeenCalledWith("sekaisen: disk I/O error");
    } finally {
      logged.mockRestore();
    }
    failing = false;
    expect(engine.status(runId).live).toMatchObject({
      state: "submitted",
      dispatchSeq: 0,
    });
    expect(engine.status(runId).run.status).toBe("working");
    await engine.tick();
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:1`,
    ]);
  });

  it("a failed capabilities read is asked again on the next tick", async () => {
    const { engine, adapter } = await make();
    const caps = adapter.caps;
    let fails = 1;
    adapter.capabilities = async () => {
      if (fails-- > 0) throw new Error("not ready");
      return caps;
    };
    await engine.startRun("review-loop", { topic: "rust" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await engine.tick();
      expect(logged).toHaveBeenCalledWith("sekaisen: not ready");
    } finally {
      logged.mockRestore();
    }
    expect(adapter.calls).toHaveLength(0);
    await engine.tick();
    expect(adapter.calls).toHaveLength(1);
  });

  it("with dispatch off, ticks and start never start a turn", async () => {
    const { engine, adapter } = await make({ dispatch: false });
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    await engine.start();
    await engine.tick();
    expect(adapter.calls).toEqual([]);
    expect(engine.status(runId).live?.state).toBe("submitted");
  });

  it("start runs a tick loop until stop", async () => {
    const { engine, adapter } = await make({ tickMs: 10 });
    await engine.startRun("review-loop", { topic: "rust" });
    await engine.start();
    await new Promise((r) => setTimeout(r, 50));
    await engine.stop();
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("status and events", () => {
  it("status returns the run, the live stage run and the last 20 transitions", async () => {
    const { engine, adapter } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    for (let i = 0; i < 12; i++) {
      await engine.tick();
      const outcome = i % 2 === 0 ? "drafted" : "fail";
      const fields = i % 2 === 0 ? { pr_url: "u" } : { findings: "f" };
      await engine.complete({ token: lastToken(adapter), outcome, fields });
      if (engine.status(runId).run.status !== "working") break;
    }
    const view = engine.status(runId);
    expect(view.transitions).toHaveLength(20);
    expect(view.transitions.at(-1)?.event).toBe("run_ended");
    expect(view.run.status).toBe("failed");
    expect(view.live).toBeUndefined();
    expect(view.gate).toBeUndefined();
    expect(() => engine.status("r_nope")).toThrow(/unknown run/);
  });

  it("emits stage and run events after commit; a throwing listener is ignored", async () => {
    const { engine, adapter } = await make();
    const seen: string[] = [];
    engine.on("stage_changed", () => {
      throw new Error("listener bug");
    });
    const sub = engine.on("stage_changed", (e) =>
      seen.push(`${e.stage}:${e.from ?? "-"}>${e.to}`),
    );
    engine.on("run_ended", (e) => seen.push(`end:${e.status}:${e.stage}`));
    await engine.startRun("review-loop", { topic: "rust" });
    await engine.tick();
    await engine.complete({
      token: lastToken(adapter),
      outcome: "blocked",
      fields: { reason: "r" },
    });
    expect(seen).toEqual([
      "draft:->submitted",
      "draft:submitted>working",
      "draft:working>completed",
      "end:failed:failed",
    ]);
    sub.dispose();
    await engine.startRun("review-loop", { topic: "rust" });
    expect(seen).toHaveLength(4);
  });
});

describe("per-attempt tokens", () => {
  const secret = new Uint8Array(32).fill(3);

  it("refuses a token secret shorter than 32 bytes", async () => {
    const r = await make();
    expect(
      () =>
        new Engine({
          store: r.store,
          adapter: r.adapter,
          registry: createRegistry(),
          definitions: r.source,
          tokenSecret: new Uint8Array(31),
        }),
    ).toThrow(/32 bytes/);
    for (const bad of ["x".repeat(64), new ArrayBuffer(64)]) {
      expect(
        () =>
          new Engine({
            store: r.store,
            adapter: r.adapter,
            registry: createRegistry(),
            definitions: r.source,
            tokenSecret: bad as unknown as Uint8Array,
          }),
      ).toThrow("tokenSecret must be at least 32 bytes");
    }
  });

  it("a new engine with the same secret resends a byte-identical brief after a crash between steps", async () => {
    const r = await make({ tokenSecret: secret });
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    // Step 1 commits, then the process dies before the turn is recorded.
    r.adapter.beforeStart = () => {
      throw new Error("crash");
    };
    await r.engine.tick();
    r.adapter.beforeStart = undefined;
    const before = r.engine.status(runId).live;
    expect([before?.state, before?.dispatchSeq, before?.adapterRunId]).toEqual([
      "submitted",
      1,
      null,
    ]);

    const restarted = new Engine({
      store: r.store,
      adapter: r.adapter,
      registry: createRegistry(),
      clock: r.clock,
      definitions: r.source,
      tokenSecret: Uint8Array.from(secret),
    });
    await restarted.tick();
    expect(r.adapter.calls).toHaveLength(2);
    expect(r.adapter.calls[1]?.idempotencyKey).toBe(`${runId}:draft:1`);
    expect(r.adapter.calls[1]?.message).toBe(r.adapter.calls[0]?.message);
    const after = restarted.status(runId).live;
    expect(after?.tokenHash).toBe(before?.tokenHash);
    expect(
      await restarted.complete({
        token: tokenOf(r.adapter.calls[0]?.message ?? ""),
        outcome: "blocked",
        fields: { reason: "r" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("a new engine with another secret re-sends under a new turn key and logs it", async () => {
    const r = await make({ tokenSecret: secret });
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    // Step 1 commits and the harness ACCEPTS the turn, then the engine dies
    // before step 3 records it.
    r.adapter.beforeStart = () => {
      throw new Error("crash");
    };
    await r.engine.tick();
    r.adapter.beforeStart = undefined;
    const sent = r.adapter.calls[0];
    if (!sent) throw new Error("no turn was sent");
    expect(await r.adapter.startTurn(sent)).toEqual({ runId: "fr_1" });
    const oldToken = tokenOf(sent.message);

    const restarted = new Engine({
      store: r.store,
      adapter: r.adapter,
      registry: createRegistry(),
      clock: r.clock,
      definitions: r.source,
      tokenSecret: new Uint8Array(32).fill(9),
    });
    await restarted.tick();
    const resent = r.adapter.calls.at(-1);
    expect(resent?.idempotencyKey).toBe(`${runId}:draft:1:2`);
    const token = tokenOf(resent?.message ?? "");
    expect(token).not.toBe(oldToken);
    const view = restarted.status(runId);
    expect(view.live?.adapterRunId).toBe("fr_2");
    expect(view.live?.dispatchSeq).toBe(2);
    expect(view.live?.tokenHash).toBe(hashToken(token));
    const rederived = view.transitions.find(
      (t) => t.event === "token_rederived",
    );
    expect(rederived?.detail).toEqual({ fromSeq: 1, toSeq: 2 });
    expect(
      await restarted.complete({
        token,
        outcome: "blocked",
        fields: { reason: "r" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("the same secret re-sends under the same key without re-deriving", async () => {
    const r = await make({ tokenSecret: secret });
    const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
    r.adapter.beforeStart = () => {
      throw new Error("crash");
    };
    await r.engine.tick();
    r.adapter.beforeStart = undefined;
    const restarted = new Engine({
      store: r.store,
      adapter: r.adapter,
      registry: createRegistry(),
      clock: r.clock,
      definitions: r.source,
      tokenSecret: Uint8Array.from(secret),
    });
    await restarted.tick();
    expect(r.adapter.calls[1]?.idempotencyKey).toBe(`${runId}:draft:1`);
    const events = restarted.status(runId).transitions.map((t) => t.event);
    expect(events).not.toContain("token_rederived");
  });

  it("a continuation turn carries the same token as the first turn", async () => {
    const { engine, adapter, store } = await make({ tokenSecret: secret });
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    await engine.tick();
    const first = lastToken(adapter);
    await engine.progress({ token: first, note: "outline done" });
    // The turn ended after a checkpoint; the row waits for its next turn.
    store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: live.attempt },
        { state: "submitted" },
      );
    });
    await engine.tick();
    expect(adapter.calls).toHaveLength(2);
    const second = adapter.calls[1];
    expect(second?.idempotencyKey).toBe(`${runId}:draft:1:2`);
    expect(second?.message).toContain("outline done");
    expect(tokenOf(second?.message ?? "")).toBe(first);
    expect(engine.status(runId).live?.dispatchSeq).toBe(2);
  });
});

describe("dispatch edge cases", () => {
  it("a failed turn start records the stage run's real state", async () => {
    const { engine, adapter, store } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    adapter.beforeStart = () => {
      store.tx((t) => {
        const live = t.liveStageRun(runId);
        if (!live) throw new Error("no live row");
        t.updateStageRunIf(
          live.stageRunId,
          { state: "submitted", attempt: 1 },
          { state: "canceled" },
        );
      });
      throw new Error("harness down");
    };
    await engine.tick();
    const last = engine.status(runId).transitions.at(-1);
    expect([last?.event, last?.fromState, last?.toState]).toEqual([
      "turn_start_failed",
      "canceled",
      "canceled",
    ]);
  });

  it("a stage run completed during the turn start gets its start time", async () => {
    const { engine, adapter, store, clock } = await make();
    const { runId } = await engine.startRun("review-loop", { topic: "rust" });
    adapter.beforeStart = async (p) => {
      await engine.complete({
        token: tokenOf(p.message),
        outcome: "blocked",
        fields: { reason: "fast" },
      });
    };
    await engine.tick();
    const row = store.tx((t) =>
      t.listStageRuns({ limit: 10 }).find((s) => s.runId === runId),
    );
    expect(row?.state).toBe("completed");
    expect(row?.adapterRunId).toBe("fr_1");
    expect(row?.startedAt).toBe(clock.now());
  });
});
