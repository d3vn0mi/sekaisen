import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../../../src/format/types.js";
import {
  type ActionFn,
  type CheckFn,
  createRegistry,
  type HostRegistry,
  type StageCtx,
} from "../../../src/host/registry.js";
import type { StageRunRow } from "../../../src/store/types.js";
import { inline, lastToken, type Rig, rig } from "./engine-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

const MIN = 60_000;
const NOW = 1_000_000;

const ENDS: Record<string, Stage> = {
  done: { type: "end", status: "completed" },
  failed: { type: "end", status: "failed" },
};

/** A rig with the `flow` pipeline: `stages` plus the two ends. */
async function flow(
  stages: Record<string, Stage>,
  setup: (registry: HostRegistry) => void = () => {},
  over: Parameters<typeof rig>[0] = {},
): Promise<Rig> {
  const registry = createRegistry();
  setup(registry);
  const r = await rig({ registry, ...over });
  rigs.push(r);
  const start = Object.keys(stages)[0] ?? "done";
  r.source.defs.set(
    "flow",
    inline({
      id: "flow",
      start,
      inputs: { type: "object" },
      stages: { ...stages, ...ENDS },
    }),
  );
  return r;
}

const rows = (r: Rig, runId: string): StageRunRow[] =>
  r.store.tx((t) =>
    t.listStageRuns({ limit: 500 }).filter((s) => s.runId === runId),
  );

const events = (r: Rig, runId: string): string[] =>
  r.store.tx((t) => t.transitions(runId).map((x) => x.event));

const runOf = (r: Rig, runId: string) => r.engine.status(runId).run;

describe("check stages", () => {
  it("check stage routes by returned outcome", async () => {
    const seen: StageCtx[] = [];
    let answer = "no";
    const r = await flow(
      {
        c: {
          type: "check",
          check: "demo.ready",
          outcomes: { yes: "done", no: "failed" },
        },
      },
      (reg) =>
        reg.checks.set("demo.ready", async (ctx) => {
          seen.push(ctx);
          return answer;
        }),
    );
    const a = await r.engine.startRun("flow", { pr: 7 });
    answer = "no";
    await r.engine.tick();
    expect(runOf(r, a.runId)).toMatchObject({
      status: "failed",
      currentStage: "failed",
    });
    answer = "yes";
    const b = await r.engine.startRun("flow", { pr: 8 });
    await r.engine.tick();
    expect(runOf(r, b.runId)).toMatchObject({
      status: "completed",
      currentStage: "done",
    });
    expect(seen.map((s) => [s.runId, s.stage, s.inputs, s.now])).toEqual([
      [a.runId, "c", { pr: 7 }, NOW],
      [b.runId, "c", { pr: 8 }, NOW],
    ]);
    const done = r.engine
      .status(b.runId)
      .transitions.find((x) => x.event === "stage_completed");
    expect(done).toMatchObject({
      actor: "check:demo.ready",
      outcome: "yes",
      detail: { next: "done" },
    });
    expect(rows(r, b.runId)[0]).toMatchObject({
      state: "completed",
      outcome: "yes",
      wakeAt: null,
    });
  });

  it("a check sees the fields earlier stages reported", async () => {
    let field: unknown;
    const r = await rig({
      registry: (() => {
        const reg = createRegistry();
        reg.checks.set("demo.ready", async (ctx) => {
          field = ctx.field("draft", "pr_url");
          return "yes";
        });
        return reg;
      })(),
    });
    rigs.push(r);
    r.source.defs.set(
      "flow",
      inline(
        {
          id: "flow",
          start: "draft",
          stages: {
            draft: {
              type: "agent",
              agent: "drafter",
              session: "run",
              brief: "b.md",
              turns: { max: 1 },
              retry: { max: 0, on: [] },
              outcomes: {
                drafted: {
                  fields: {
                    type: "object",
                    properties: { pr_url: { type: "string" } },
                    required: ["pr_url"],
                  },
                  next: "c",
                },
              },
            },
            c: {
              type: "check",
              check: "demo.ready",
              outcomes: { yes: "done" },
            },
            ...ENDS,
          },
        },
        { "b.md": "Draft." },
      ),
    );
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "drafted",
      fields: { pr_url: "https://example.test/pr/1" },
    });
    await r.engine.tick();
    expect(field).toBe("https://example.test/pr/1");
    expect(runOf(r, runId).status).toBe("completed");
  });

  it("an undeclared outcome or a throw fails the stage to the failed end", async () => {
    let behave: () => Promise<string> = async () => "maybe";
    const r = await flow(
      {
        c: {
          type: "check",
          check: "demo.ready",
          outcomes: { yes: "done" },
        },
      },
      (reg) => reg.checks.set("demo.ready", () => behave()),
    );
    const a = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(runOf(r, a.runId)).toMatchObject({
      status: "failed",
      currentStage: "failed",
    });
    const invalid = r.engine
      .status(a.runId)
      .transitions.find((x) => x.event === "check_invalid_outcome");
    expect(invalid).toMatchObject({
      fromState: "submitted",
      toState: "failed",
      detail: {
        check: "demo.ready",
        returned: "maybe",
        declared: ["yes"],
        exhausted: true,
        next: "failed",
      },
    });

    behave = async () => {
      throw new Error("no network");
    };
    const b = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(runOf(r, b.runId).status).toBe("failed");
    expect(rows(r, b.runId)[0]).toMatchObject({
      state: "failed",
      ending: "turn_error",
    });
    expect(
      r.engine.status(b.runId).transitions.find((x) => x.event === "turn_error")
        ?.detail,
    ).toMatchObject({ check: "demo.ready", error: "no network" });
  });

  it("a check that outlives the call timeout ends as a timeout", async () => {
    const r = await flow(
      {
        c: {
          type: "check",
          check: "demo.slow",
          outcomes: { yes: "done" },
        },
      },
      (reg) => reg.checks.set("demo.slow", () => new Promise(() => {})),
      { adapterCallTimeoutMs: 20 },
    );
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "failed",
      ending: "timeout",
    });
    expect(runOf(r, runId).status).toBe("failed");
  });

  it("an unregistered check is rejected once and fails the run", async () => {
    const r = await flow({
      c: { type: "check", check: "demo.missing", outcomes: { yes: "done" } },
    });
    const { runId } = await r.engine.startRun("flow", {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await r.engine.tick();
      await r.engine.tick();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(rows(r, runId)[0]).toMatchObject({ state: "rejected" });
    expect(runOf(r, runId).status).toBe("failed");
    expect(events(r, runId).filter((e) => e === "stage_rejected")).toHaveLength(
      2,
    );
  });
});

describe("action stages", () => {
  it("action gets run:stage:attempt and retries on throw", async () => {
    const keys: string[] = [];
    let throws = 1;
    const notify: ActionFn = async (ctx) => {
      keys.push(ctx.idempotencyKey);
      if (throws-- > 0) throw new Error("smtp down");
    };
    const r = await flow(
      {
        a: {
          type: "action",
          action: "demo.notify",
          next: "done",
          retry: { max: 2, on: ["turn_error"] },
        },
      },
      (reg) => reg.actions.set("demo.notify", notify),
    );
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(keys).toEqual([`${runId}:a:1`]);
    expect(runOf(r, runId).status).toBe("working");
    await r.engine.tick();
    expect(keys).toEqual([`${runId}:a:1`, `${runId}:a:2`]);
    expect(runOf(r, runId)).toMatchObject({
      status: "completed",
      currentStage: "done",
    });
    expect(
      rows(r, runId).map((x) => [x.attempt, x.retryIndex, x.state, x.ending]),
    ).toEqual([
      [1, 0, "failed", "turn_error"],
      [2, 1, "completed", undefined],
    ]);
    const failed = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "turn_error");
    expect(failed?.detail).toEqual({
      action: "demo.notify",
      error: "smtp down",
      retry: { attempt: 2 },
    });
  });

  it("an action that keeps throwing takes on_exhausted", async () => {
    let calls = 0;
    const r = await flow(
      {
        a: {
          type: "action",
          action: "demo.notify",
          next: "done",
          retry: { max: 1, on: ["turn_error"] },
          onExhausted: "fallback",
        },
        fallback: {
          type: "check",
          check: "demo.ok",
          outcomes: { yes: "failed" },
        },
      },
      (reg) => {
        reg.actions.set("demo.notify", async () => {
          calls++;
          throw new Error("nope");
        });
        reg.checks.set("demo.ok", async () => "yes");
      },
    );
    const { runId } = await r.engine.startRun("flow", {});
    for (let i = 0; i < 4; i++) await r.engine.tick();
    expect(calls).toBe(2);
    expect(runOf(r, runId)).toMatchObject({
      status: "failed",
      currentStage: "failed",
    });
    expect(rows(r, runId).map((x) => x.stage)).toEqual(["a", "a", "fallback"]);
  });

  it("a default action retry does not retry", async () => {
    let calls = 0;
    const r = await flow(
      {
        a: {
          type: "action",
          action: "demo.notify",
          next: "done",
          retry: { max: 0, on: [] },
        },
      },
      (reg) =>
        reg.actions.set("demo.notify", async () => {
          calls++;
          throw new Error("nope");
        }),
    );
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    await r.engine.tick();
    expect(calls).toBe(1);
    expect(runOf(r, runId).status).toBe("failed");
  });
});

describe("wait stages", () => {
  it("wait for 10m wakes after 10m", async () => {
    const r = await flow({ w: { type: "wait", for: 10 * MIN, next: "done" } });
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(rows(r, runId)[0]).toMatchObject({
      state: "working",
      wakeAt: NOW + 10 * MIN,
    });
    expect(runOf(r, runId).status).toBe("working");
    r.clock.advance(10 * MIN - 1);
    await r.engine.tick();
    expect(runOf(r, runId).status).toBe("working");
    r.clock.advance(1);
    await r.engine.tick();
    expect(runOf(r, runId)).toMatchObject({
      status: "completed",
      currentStage: "done",
    });
    expect(events(r, runId)).toEqual([
      "run_created",
      "stage_submitted",
      "wait_started",
      "wait_elapsed",
      "run_ended",
    ]);
  });

  it("wait until reads an ISO instant, also from a placeholder", async () => {
    const r = await flow({
      w: { type: "wait", until: "{{inputs.at}}", next: "done" },
    });
    const at = new Date(NOW + 30 * MIN).toISOString();
    const { runId } = await r.engine.startRun("flow", { at });
    await r.engine.tick();
    expect(rows(r, runId)[0]?.wakeAt).toBe(NOW + 30 * MIN);
    r.clock.advance(30 * MIN);
    await r.engine.tick();
    expect(runOf(r, runId).status).toBe("completed");
  });

  it("a wait until already past takes next at once", async () => {
    const r = await flow({
      w: { type: "wait", until: "1970-01-01T00:00:00Z", next: "done" },
    });
    const { runId } = await r.engine.startRun("flow", {});
    await r.engine.tick();
    expect(runOf(r, runId).status).toBe("completed");
  });

  it.each([
    ["{{inputs.missing}}"],
    ["{{inputs.year}}"],
    ["tomorrow"],
    ["2026-11-22T10:00:00"],
  ])("an unparseable until (%s) fails the stage", async (until) => {
    const r = await flow({ w: { type: "wait", until, next: "done" } });
    const { runId } = await r.engine.startRun("flow", { year: 2027 });
    await r.engine.tick();
    expect(runOf(r, runId)).toMatchObject({
      status: "failed",
      currentStage: "failed",
    });
    const failed = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "wait_invalid_until");
    expect(failed).toMatchObject({ fromState: "submitted", toState: "failed" });
    expect(failed?.detail).toMatchObject({ until });
  });
});

describe("the tick", () => {
  it("waiting stages never crowd agent stage runs out of a tick", async () => {
    const r = await flow({ w: { type: "wait", for: 60 * MIN, next: "done" } });
    for (let i = 0; i < 120; i++) await r.engine.startRun("flow", {});
    await r.engine.tick();
    r.clock.advance(1000);
    const { runId } = await r.engine.startRun("review-loop", { topic: "x" });
    await r.engine.tick();
    expect(r.adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:1`,
    ]);
  });

  it("a live stage run under an ended run is ended as orphaned", async () => {
    const r = await flow({ w: { type: "wait", for: 10 * MIN, next: "done" } });
    const { runId } = await r.engine.startRun("flow", {});
    // The run ends without its live stage run (not something the engine does).
    r.store.tx((t) =>
      t.updateRunIf(
        runId,
        { status: "working", currentStage: "w" },
        { status: "failed", endedAt: NOW },
      ),
    );
    await r.engine.tick();
    const row = rows(r, runId)[0];
    expect(row).toMatchObject({ state: "canceled", wakeAt: null });
    expect(
      r.store.tx((t) =>
        t.transitions(runId).find((x) => x.event === "orphaned_stage_run"),
      ),
    ).toMatchObject({
      stageRunId: row?.stageRunId,
      fromState: "submitted",
      toState: "canceled",
      detail: { run: "failed" },
    });
  });

  it("host stages run without the harness's capabilities", async () => {
    const checked: string[] = [];
    const ready: CheckFn = async (ctx) => {
      checked.push(ctx.runId);
      return "yes";
    };
    const r = await flow(
      { c: { type: "check", check: "demo.ready", outcomes: { yes: "done" } } },
      (reg) => reg.checks.set("demo.ready", ready),
    );
    r.adapter.capabilities = async () => {
      throw new Error("not ready");
    };
    const { runId } = await r.engine.startRun("flow", {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await r.engine.tick();
    } finally {
      logged.mockRestore();
    }
    expect(checked).toEqual([runId]);
    expect(runOf(r, runId).status).toBe("completed");
  });
});

describe("the stages pass at scale", () => {
  it("calls host functions at most `concurrency` at a time", async () => {
    let open = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const r = await flow(
      {
        c: {
          type: "check",
          check: "demo.ready",
          outcomes: { yes: "done" },
        },
      },
      (reg) =>
        reg.checks.set("demo.ready", () => {
          open += 1;
          most = Math.max(most, open);
          return new Promise<string>((resolve) =>
            waiting.push(() => {
              open -= 1;
              resolve("yes");
            }),
          );
        }),
      { concurrency: 2 },
    );
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push((await r.engine.startRun("flow", {})).runId);
    }
    let done = false;
    const tick = r.engine.tick().finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((res) => setImmediate(res));
      waiting.shift()?.();
    }
    await tick;
    expect(most).toBe(2);
    expect(runs.map((id) => runOf(r, id).status)).toEqual(
      new Array(5).fill("completed"),
    );
  });
});
