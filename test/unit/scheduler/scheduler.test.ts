import { afterEach, describe, expect, it } from "vitest";
import type { Capabilities } from "../../../src/adapter/types.js";
import { PinnedDefinitions } from "../../../src/engine/pinned.js";
import {
  recordAdmit,
  recordWait,
  type TxCtx,
} from "../../../src/engine/turns.js";
import type { Definition, ProviderPolicy } from "../../../src/format/types.js";
import {
  type AdmitCtx,
  type AgentSlot,
  admit,
} from "../../../src/scheduler/scheduler.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type {
  LimitRow,
  RunRow,
  StageRunRow,
  StoreTx,
} from "../../../src/store/types.js";
import {
  inline,
  lastToken,
  type Rig,
  rig,
  SwapSource,
} from "../engine/engine-helpers.js";

const CAPS: Capabilities = {
  turnCapMs: 600_000,
  maxConcurrent: 8,
  canAbort: true,
  subscriptionProvider: "included",
};

function run(runId: string, priority = 0): RunRow {
  return {
    runId,
    pipelineId: "p",
    defHash: "h",
    inputs: {},
    status: "working",
    currentStage: "draft",
    priority,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
  };
}

function row(
  stageRunId: string,
  runId: string,
  createdAt: number,
  over: Partial<StageRunRow> = {},
): StageRunRow {
  return {
    stageRunId,
    runId,
    stage: "draft",
    attempt: 1,
    visit: 1,
    retryIndex: 0,
    state: "submitted",
    tokenHash: null,
    idempotencyKey: `${runId}:draft:1`,
    adapterRunId: null,
    sessionKey: null,
    turnsUsed: 0,
    dispatchSeq: 0,
    deadlineAt: null,
    createdAt,
    startedAt: null,
    endedAt: null,
    outcome: null,
    fields: null,
    progressNote: null,
    progressAt: null,
    progressSeq: null,
    dispatchedAt: null,
    heldSince: null,
    runtime: null,
    waitReason: null,
    wakeAt: null,
    abortRunId: null,
    abortAttempts: 0,
    abortNextAt: null,
    observedAt: null,
    startError: null,
    ...over,
  };
}

const working = (r: StageRunRow): StageRunRow => ({ ...r, state: "working" });

/**
 * A context where every stage run is an agent stage of `drafter` on its own
 * run's session, unless `slots` says otherwise (null: not an agent stage).
 */
function ctx(
  runs: RunRow[],
  over: Partial<AdmitCtx> & {
    slots?: Record<string, Partial<AgentSlot> | null>;
  } = {},
): AdmitCtx {
  const { slots = {}, ...rest } = over;
  return {
    working: [],
    limits: [],
    capabilities: CAPS,
    wip: () => 1,
    runs: new Map(runs.map((r) => [r.runId, r])),
    now: 1000,
    stageOf: (r) => {
      const s = slots[r.stageRunId];
      if (s === null) return undefined;
      return {
        agent: "drafter",
        sessionKey: `run:${r.runId}:drafter`,
        providers: "fleet",
        ...s,
      };
    },
    ...rest,
  };
}

const limit = (scope: string, key: string, until: number): LimitRow => ({
  scope,
  key,
  pausedUntil: until,
  reason: "test",
  setAt: 0,
});

describe("admit", () => {
  it("higher priority first, FIFO within a priority", () => {
    const runs = [run("r1", 0), run("r2", 5), run("r3", 5), run("r4", 5)];
    const candidates = [
      row("a", "r1", 1),
      row("b", "r2", 30),
      row("d", "r4", 20),
      row("c", "r3", 20),
    ];
    expect(admit(candidates, ctx(runs))).toEqual({
      admit: ["c", "d", "b", "a"],
      waiting: [],
    });
    const two = { ...CAPS, maxConcurrent: 2 };
    expect(admit(candidates, ctx(runs, { capabilities: two }))).toEqual({
      admit: ["c", "d"],
      waiting: [
        { id: "b", reason: "lane_full" },
        { id: "a", reason: "lane_full" },
      ],
    });
  });

  it("WIP 1 per agent per session key holds the second", () => {
    const runs = [run("r1"), run("r2"), run("r3"), run("r4")];
    const shared = { sessionKey: "project:x:drafter" };
    const slots = { a: shared, b: shared, w: { sessionKey: "run:r4:drafter" } };
    const candidates = [
      row("a", "r1", 1),
      row("b", "r2", 2),
      row("c", "r3", 3),
      row("d", "r4", 4),
    ];
    const busy = [working(row("w", "r4", 0))];
    expect(admit(candidates, ctx(runs, { slots, working: busy }))).toEqual({
      admit: ["a", "c"],
      waiting: [
        { id: "b", reason: "wip:drafter" },
        { id: "d", reason: "wip:drafter" },
      ],
    });
    // Another agent on a session key of the same text is not held.
    const other = { ...slots, b: { ...shared, agent: "checker" } };
    expect(admit(candidates, ctx(runs, { slots: other })).admit).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    // WIP is per agent.
    const two = ctx(runs, { slots, wip: (a) => (a === "drafter" ? 2 : 1) });
    expect(admit(candidates, two).admit).toEqual(["a", "b", "c", "d"]);
  });

  it("lane cap holds the ninth when maxConcurrent is 8", () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(`r${i}`));
    const candidates = runs.map((r, i) => row(`s${i}`, r.runId, i));
    const out = admit(candidates, ctx(runs));
    expect(out.admit).toEqual(candidates.slice(0, 8).map((r) => r.stageRunId));
    expect(out.waiting).toEqual([{ id: "s8", reason: "lane_full" }]);

    // Working agent stage runs take lanes; other stage types take none.
    const busy = [
      working(row("w1", "x1", 0)),
      working(row("w2", "x2", 0)),
      working(row("w3", "x3", 0)),
      working(row("g", "x4", 0)),
    ];
    const some = ctx(runs, { working: busy, slots: { g: null } });
    const held = admit(candidates.slice(0, 6), some);
    expect(held.admit).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(held.waiting).toEqual([{ id: "s5", reason: "lane_full" }]);
  });

  it("paused provider holds dispatch until the limit expires", () => {
    const runs = [run("r1")];
    const candidates = [row("a", "r1", 1)];
    const limits = [limit("provider", "included", 2000)];
    expect(admit(candidates, ctx(runs, { limits, now: 1999 }))).toEqual({
      admit: [],
      waiting: [{ id: "a", reason: "paused:provider:included" }],
    });
    expect(admit(candidates, ctx(runs, { limits, now: 2000 }))).toEqual({
      admit: ["a"],
      waiting: [],
    });
    // A pause holds before WIP or lane would.
    const full = { ...CAPS, maxConcurrent: 0 };
    expect(
      admit(candidates, ctx(runs, { limits, capabilities: full })).waiting,
    ).toEqual([{ id: "a", reason: "paused:provider:included" }]);
  });

  it("holds by provider policy as usage limits rule", () => {
    const runs = [run("f"), run("s"), run("o")];
    const policy = (providers: ProviderPolicy) => ({ providers });
    const slots = {
      f: policy("fleet"),
      s: policy("subscription"),
      o: policy({ allow: ["included", "other"] }),
    };
    const candidates = [row("f", "f", 1), row("s", "s", 2), row("o", "o", 3)];
    const reasons = (limits: LimitRow[]) =>
      admit(candidates, ctx(runs, { slots, limits })).waiting;

    // Fleet is held by any provider limit, never by a policy limit.
    expect(reasons([limit("provider", "metered", 5000)])).toEqual([
      { id: "f", reason: "paused:provider:metered" },
    ]);
    expect(reasons([limit("policy", "included", 5000)])).toEqual([
      { id: "s", reason: "paused:policy:included" },
    ]);
    // A provider in the allowed set holds; the policy key is the set.
    expect(reasons([limit("provider", "other", 5000)])).toEqual([
      { id: "f", reason: "paused:provider:other" },
      { id: "o", reason: "paused:provider:other" },
    ]);
    expect(reasons([limit("policy", "included,other", 5000)])).toEqual([
      { id: "o", reason: "paused:policy:included,other" },
    ]);
  });

  it("a row's own refused provider holds it before a policy limit", () => {
    // Refused on `metered`, which is outside its allowed set: only its own
    // wait reason remembers that provider.
    const runs = [run("r1")];
    const slots = { a: { providers: "subscription" as const } };
    const candidates = [
      row("a", "r1", 1, {
        waitReason: "paused:provider:metered",
        heldSince: 500,
      }),
    ];
    const limits = [
      limit("policy", "included", 2000),
      limit("provider", "metered", 3000),
    ];
    const at = (now: number) =>
      admit(candidates, ctx(runs, { slots, limits, now }));
    expect(at(1000).waiting).toEqual([
      { id: "a", reason: "paused:provider:metered" },
    ]);
    // The policy limit ends first; the row stays held on its own provider.
    expect(at(2500).waiting).toEqual([
      { id: "a", reason: "paused:provider:metered" },
    ]);
    expect(at(3000).admit).toEqual(["a"]);
  });

  it("skips candidates that are not agent stages or whose run is not working", () => {
    const runs = [run("r1"), { ...run("r2"), status: "canceled" as const }];
    const candidates = [
      row("a", "r1", 1),
      row("b", "r2", 2),
      row("c", "gone", 3),
      row("g", "r1", 4),
    ];
    expect(admit(candidates, ctx(runs, { slots: { g: null } }))).toEqual({
      admit: ["a"],
      waiting: [],
    });
  });
});

describe("wait bookkeeping", () => {
  function withRow(
    over: Partial<StageRunRow>,
    fn: (t: StoreTx, seen: StageRunRow, at: (now: number) => TxCtx) => void,
  ): void {
    const store = openSqliteStore(":memory:");
    try {
      store.tx((t) => {
        t.putDefinition({
          pipelineId: "p",
          hash: "h",
          version: 1,
          parsed: { id: "p" } as unknown as Definition,
          briefs: {},
          loadedAt: 0,
        });
        t.insertRun(run("r1"));
        const { idempotencyKey: _key, ...fresh } = row("a", "r1", 0, over);
        t.insertStageRun(fresh);
        const seen = t.getStageRun("a");
        if (!seen) throw new Error("no row");
        const pinned = new PinnedDefinitions();
        fn(t, seen, (now) => ({ t, pinned, now, emit: () => undefined }));
      });
    } finally {
      store.close();
    }
  }

  it("a pause holds the deadline; WIP or lane after it releases the hold", () => {
    withRow({ deadlineAt: 2000 }, (t, seen, at) => {
      recordWait(at(1000), seen, "paused:provider:included", true);
      const held = t.getStageRun("a");
      expect([held?.waitReason, held?.heldSince, held?.deadlineAt]).toEqual([
        "paused:provider:included",
        1000,
        2000,
      ]);
      // Still paused later: the hold keeps its start.
      recordWait(at(1200), seen, "paused:provider:included", true);
      expect(t.getStageRun("a")?.heldSince).toBe(1000);
      // The pause is over but the lane is full: released, deadline moved.
      recordWait(at(1500), seen, "lane_full", false);
      const waits = t.getStageRun("a");
      expect([waits?.waitReason, waits?.heldSince, waits?.deadlineAt]).toEqual([
        "lane_full",
        null,
        2500,
      ]);
    });
  });

  it("an admitted stage run has no wait reason and no hold", () => {
    withRow(
      { deadlineAt: 2000, heldSince: 1000, waitReason: "paused:policy:x" },
      (t, seen, at) => {
        const now = recordAdmit(at(1500), seen);
        expect([now?.waitReason, now?.heldSince, now?.deadlineAt]).toEqual([
          null,
          null,
          2500,
        ]);
        expect(t.getStageRun("a")).toEqual(now);
      },
    );
  });
});

describe("the engine's agent pass", () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      await r.engine.stop();
      r.store.close();
    }
  });

  /** A pipeline whose one agent stage loops back to itself. */
  const looping = (id: string) =>
    inline(
      {
        id,
        start: "draft",
        stages: {
          draft: {
            type: "agent",
            agent: "drafter",
            session: "run",
            brief: "b.md",
            turns: { max: 1 },
            retry: { max: 0, on: [] },
            outcomes: { again: { next: "draft" } },
          },
        },
      },
      { "b.md": "Draft. {{token}}" },
    );

  async function make(
    over: Parameters<typeof rig>[0] = {},
    caps: Partial<Capabilities> = {},
  ): Promise<Rig> {
    const r = await rig({
      definitions: new SwapSource(looping("busy"), looping("quiet")),
      ...over,
    });
    r.adapter.caps = { ...r.adapter.caps, ...caps };
    rigs.push(r);
    return r;
  }

  const live = (r: Rig, runId: string) => r.engine.status(runId).live;

  it("a busy pipeline does not starve another on the same agent", async () => {
    const r = await make({}, { maxConcurrent: 1 });
    const busy = await r.engine.startRun("busy", {});
    r.clock.advance(1000);
    const quiet = await r.engine.startRun("quiet", {});
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      r.clock.advance(1000);
      await r.engine.tick();
      const call = r.adapter.calls.at(-1);
      expect(r.adapter.calls).toHaveLength(i + 1);
      order.push(call?.sessionKey.includes(busy.runId) ? "busy" : "quiet");
      const res = await r.engine.complete({
        token: lastToken(r.adapter),
        outcome: "again",
      });
      expect(res.ok).toBe(true);
    }
    expect(order).toEqual([
      "busy",
      "quiet",
      "busy",
      "quiet",
      "busy",
      "quiet",
      "busy",
      "quiet",
      "busy",
      "quiet",
    ]);
    expect(live(r, quiet.runId)?.state).toBe("submitted");
  });

  it("writes a wait reason once and clears it on admission", async () => {
    const r = await make({}, { maxConcurrent: 1 });
    const first = await r.engine.startRun("busy", {});
    r.clock.advance(1000);
    const second = await r.engine.startRun("quiet", {});
    await r.engine.tick();
    expect(live(r, first.runId)?.state).toBe("working");
    const held = live(r, second.runId);
    expect(held?.waitReason).toBe("lane_full");

    // A refusal that does not change leaves the row as it was.
    const writes: string[] = [];
    const tx = r.store.tx.bind(r.store);
    r.store.tx = (fn) =>
      tx((t) => {
        const update = t.updateStageRunIf.bind(t);
        t.updateStageRunIf = (id, expect, patch) => {
          if (id === held?.stageRunId) writes.push(Object.keys(patch).join());
          return update(id, expect, patch);
        };
        return fn(t);
      });
    await r.engine.tick();
    expect(writes).toEqual([]);

    r.clock.advance(1000);
    await r.engine.complete({ token: lastToken(r.adapter), outcome: "again" });
    await r.engine.tick();
    const admitted = live(r, second.runId);
    expect(admitted?.state).toBe("working");
    expect(admitted?.waitReason).toBeNull();
  });

  it("honours a per-agent WIP limit on a shared project session", async () => {
    const shared = (id: string) => {
      const l = looping(id);
      const stage = l.def.stages.draft;
      if (stage?.type === "agent") stage.session = "project";
      return l;
    };
    const r = await make({
      definitions: new SwapSource(shared("busy"), shared("quiet")),
    });
    const a = await r.engine.startRun("busy", { project: "x" });
    r.clock.advance(1000);
    const b = await r.engine.startRun("quiet", { project: "x" });
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(1);
    expect(live(r, b.runId)?.waitReason).toBe("wip:drafter");

    const two = await make({
      definitions: new SwapSource(shared("busy"), shared("quiet")),
      wip: { drafter: 2 },
    });
    await two.engine.startRun("busy", { project: "x" });
    await two.engine.startRun("quiet", { project: "x" });
    await two.engine.tick();
    expect(two.adapter.calls).toHaveLength(2);
    expect(live(r, a.runId)?.state).toBe("working");
  });

  it("a deep queue of refused stage runs does not hide one that can run", async () => {
    const shared = looping("busy");
    const stage = shared.def.stages.draft;
    if (stage?.type === "agent") stage.session = "project";
    const r = await make({
      definitions: new SwapSource(shared, looping("quiet")),
    });
    // 101 urgent runs on one project session: one runs, a hundred wait.
    for (let i = 0; i < 101; i++) {
      await r.engine.startRun("busy", { project: "x" }, { priority: 5 });
      r.clock.advance(1);
    }
    const quiet = await r.engine.startRun("quiet", {});
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    expect(live(r, quiet.runId)?.state).toBe("working");
  });

  it("refuses a WIP or concurrency that is not a positive integer", async () => {
    await expect(make({ wip: { drafter: 0 } })).rejects.toThrow(
      "wip for drafter must be a positive integer",
    );
    await expect(make({ concurrency: 1.5 })).rejects.toThrow(
      "concurrency must be a positive integer",
    );
  });
});
