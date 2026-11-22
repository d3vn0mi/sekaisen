import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import {
  abortBackoffMs,
  Engine,
  type EngineOptions,
} from "../../../src/engine/engine.js";
import { createRegistry } from "../../../src/host/registry.js";
import type { StageRunRow, TransitionRow } from "../../../src/store/types.js";
import { type Rig, rig } from "./engine-helpers.js";

const rigs: Rig[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const e of engines.splice(0)) await e.stop();
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const SEC = 1000;
const MIN = 60 * SEC;

async function make(...args: Parameters<typeof rig>): Promise<Rig> {
  const r = await rig(...args);
  rigs.push(r);
  return r;
}

/** A run whose first draft turn the rig's engine dispatched. */
async function started(r: Rig): Promise<string> {
  const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
  await r.engine.tick();
  return runId;
}

/** Another engine on the rig's store, as after a restart. */
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

/** An engine on `r`'s store whose harness cannot report capabilities. */
function blind(r: Rig): Engine {
  const adapter = new FakeAdapter();
  adapter.capabilities = async () => {
    throw new Error("not ready");
  };
  return restarted(r, adapter);
}

/** Cancels `runId` through an engine that cannot reach the harness. */
async function cancelBlind(r: Rig, runId: string): Promise<void> {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await blind(r).cancel(runId, "operator:a");
  } finally {
    logged.mockRestore();
  }
}

const row = (r: Rig, runId: string): StageRunRow => {
  const found = r.store.tx((t) =>
    t.listStageRuns({ limit: 100 }).find((s) => s.runId === runId),
  );
  if (!found) throw new Error("no stage run");
  return found;
};

const aborts = (r: Rig, runId: string): TransitionRow[] =>
  r.store.tx((t) =>
    t.transitions(runId).filter((x) => x.event.startsWith("abort_")),
  );

describe("abort requests", () => {
  it("an abort requested while capabilities fail survives a restart and is flushed", async () => {
    const r = await make();
    const runId = await started(r);
    await cancelBlind(r, runId);
    expect(row(r, runId)).toMatchObject({
      state: "canceled",
      abortRunId: "fr_1",
      abortAttempts: 0,
      abortNextAt: r.clock.now(),
    });

    const adapter = new FakeAdapter();
    const engine = restarted(r, adapter);
    await engine.reconcile();
    expect(adapter.aborted).toEqual(["fr_1"]);
    expect(row(r, runId)).toMatchObject({
      abortRunId: null,
      abortNextAt: null,
    });
    await engine.reconcile();
    await engine.tick();
    expect(adapter.aborted).toEqual(["fr_1"]);
  });

  it("logs the request and how the harness answered", async () => {
    const r = await make();
    const runId = await started(r);
    await r.engine.cancel(runId, "operator:a");
    expect(aborts(r, runId).map((x) => [x.event, x.actor, x.detail])).toEqual([
      ["abort_requested", "operator:a", { adapterRunId: "fr_1" }],
      ["abort_settled", "engine", { adapterRunId: "fr_1", aborted: true }],
    ]);

    const declined = await make();
    const declinedRun = await started(declined);
    declined.adapter.abortTurn = async () => false;
    await declined.engine.cancel(declinedRun, "operator:a");
    expect(row(declined, declinedRun).abortRunId).toBeNull();
    expect(aborts(declined, declinedRun).at(-1)?.detail).toEqual({
      adapterRunId: "fr_1",
      aborted: false,
    });

    const unable = await make();
    unable.adapter.caps = { ...unable.adapter.caps, canAbort: false };
    const unableRun = await started(unable);
    await unable.engine.cancel(unableRun, "operator:a");
    expect(row(unable, unableRun).abortRunId).toBeNull();
    expect(unable.adapter.aborted).toEqual([]);
    expect(aborts(unable, unableRun).at(-1)?.detail).toEqual({
      adapterRunId: "fr_1",
      aborted: false,
      reason: "the harness cannot abort turns",
    });
  });

  it("a failing abort is reported, backs off and is abandoned after five attempts", async () => {
    const r = await make();
    const runId = await started(r);
    let calls = 0;
    r.adapter.abortTurn = async () => {
      calls++;
      throw new Error(`abort failed ${calls}`);
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = r.clock.now();
    await r.engine.cancel(runId, "operator:a");
    expect(calls).toBe(1);
    expect(row(r, runId)).toMatchObject({
      abortRunId: "fr_1",
      abortAttempts: 1,
      abortNextAt: t0 + MIN,
    });
    // Not due yet: nothing is asked.
    await r.engine.tick();
    expect(calls).toBe(1);

    // 1, 2, 4 and 8 minutes apart.
    let at = t0;
    for (const [i, wait] of [MIN, 2 * MIN, 4 * MIN].entries()) {
      at += wait;
      r.clock.set(at - 1);
      await r.engine.tick();
      expect(calls).toBe(i + 1);
      r.clock.set(at);
      await r.engine.tick();
      expect(calls).toBe(i + 2);
      expect(row(r, runId)).toMatchObject({ abortAttempts: i + 2 });
    }
    expect(row(r, runId).abortNextAt).toBe(at + 8 * MIN);
    r.clock.set(at + 8 * MIN);
    await r.engine.tick();
    expect(calls).toBe(5);
    expect(row(r, runId)).toMatchObject({
      abortRunId: null,
      abortAttempts: 5,
      abortNextAt: null,
    });
    const last = aborts(r, runId).at(-1);
    expect(last).toMatchObject({
      event: "abort_abandoned",
      actor: "engine",
      detail: { adapterRunId: "fr_1", attempts: 5, error: "abort failed 5" },
    });
    // Every failed call was reported.
    for (let i = 1; i <= 5; i++) {
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(`abort failed ${i}`),
      );
    }
    r.clock.advance(60 * MIN);
    await r.engine.tick();
    expect(calls).toBe(5);
  });

  it("the wait between attempts doubles from a minute up to 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(abortBackoffMs)).toEqual(
      [1, 2, 4, 8, 16, 30, 30, 30].map((m) => m * MIN),
    );
  });

  it("aborts are asked after the tick's other work, within a time budget", async () => {
    const r = await make();
    const runs = [await started(r), await started(r), await started(r)];
    for (const runId of runs) await cancelBlind(r, runId);
    const { runId: waiting } = await r.engine.startRun("review-loop", {
      topic: "next",
    });

    const order: string[] = [];
    const adapter = new FakeAdapter();
    const start = adapter.startTurn.bind(adapter);
    adapter.startTurn = async (p) => {
      order.push("startTurn");
      return start(p);
    };
    adapter.abortTurn = async (id) => {
      order.push(`abort ${id}`);
      // Each abort takes eleven seconds: past the budget after the first.
      r.clock.advance(11 * SEC);
      return true;
    };
    const engine = restarted(r, adapter);
    await engine.tick();
    expect(order).toEqual(["startTurn", "abort fr_1"]);
    expect(row(r, waiting).state).toBe("working");
    await engine.tick();
    expect(order.slice(2)).toEqual(["abort fr_2"]);
    await engine.tick();
    expect(order.slice(3)).toEqual(["abort fr_3"]);
  });

  it("a failing abort does not hold up the others", async () => {
    const r = await make();
    const first = await started(r);
    const second = await started(r);
    await cancelBlind(r, first);
    await cancelBlind(r, second);
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    adapter.abortTurn = async (id) => {
      asked.push(id);
      if (id === "fr_1") throw new Error("stuck");
      return true;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = restarted(r, adapter);
    await engine.tick();
    expect(asked).toEqual(["fr_1", "fr_2"]);
    expect(row(r, second).abortRunId).toBeNull();
    // fr_1 waits out its backoff; nothing is asked until it is due.
    await engine.tick();
    expect(asked).toEqual(["fr_1", "fr_2"]);
    r.clock.advance(MIN);
    await engine.tick();
    expect(asked).toEqual(["fr_1", "fr_2", "fr_1"]);
  });
});
