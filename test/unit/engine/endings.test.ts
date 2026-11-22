import { afterEach, describe, expect, it } from "vitest";
import type { RunOutcome } from "../../../src/adapter/types.js";
import { classifyEnding } from "../../../src/engine/classify.js";
import type { AgentStage, Definition } from "../../../src/format/types.js";
import type { StageRunRow, Store } from "../../../src/store/types.js";
import {
  lastToken,
  type Rig,
  rig,
  tokenOf,
  variant,
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

const MIN = 60_000;
const OK: RunOutcome = { state: "ended", ending: "ok" };

function agent(def: Definition, id: string): AgentStage {
  const stage = def.stages[id];
  if (stage?.type !== "agent") throw new Error("fixture changed");
  return stage;
}

/** A rig whose review-loop definition is edited by `edit`. */
async function edited(
  edit: (def: Definition) => void,
  over: Parameters<typeof rig>[0] = {},
): Promise<Rig> {
  const r = await make(over);
  r.source.defs.set("review-loop", await variant("edited", edit));
  return r;
}

async function started(r: Rig): Promise<{ runId: string; token: string }> {
  const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
  await r.engine.tick();
  return { runId, token: lastToken(r.adapter) };
}

const rows = (store: Store, runId: string): StageRunRow[] =>
  store.tx((t) =>
    t.listStageRuns({ limit: 100 }).filter((s) => s.runId === runId),
  );

const events = (r: Rig, runId: string) =>
  r.store.tx((t) => t.transitions(runId).map((x) => x.event));

const lastRunId = (r: Rig) => `fr_${r.adapter.calls.length}`;

describe("classifyEnding", () => {
  const row = (over: Partial<StageRunRow> = {}): StageRunRow =>
    ({
      dispatchSeq: 2,
      progressSeq: null,
      progressAt: null,
      dispatchedAt: 100,
      ...over,
    }) as StageRunRow;

  it("tells a fresh note from an old one by the turn it was written in", () => {
    expect(
      classifyEnding(OK, row({ progressSeq: 2, progressAt: 100 }), 200),
    ).toBe("continue");
    expect(
      classifyEnding(OK, row({ progressSeq: 1, progressAt: 100 }), 200),
    ).toBe("no_result");
    expect(classifyEnding(OK, row(), 200)).toBe("no_result");
  });

  it("errors are turn errors unless they carry a usage-limit refusal", () => {
    for (const ending of ["error", "timeout", "killed"] as const) {
      expect(
        classifyEnding({ state: "ended", ending, error: "boom" }, row(), 0),
      ).toBe("turn_error");
      expect(
        classifyEnding(
          {
            state: "ended",
            ending,
            error: "You've hit your session limit · resets 7pm",
          },
          row(),
          0,
        ),
      ).toBe("usage_limited");
    }
    expect(classifyEnding({ state: "ended", ending: "error" }, row(), 0)).toBe(
      "turn_error",
    );
  });

  it("refuses an outcome that has not ended", () => {
    expect(() => classifyEnding({ state: "running" }, row(), 0)).toThrow(
      /not ended/,
    );
  });
});

describe("turn endings", () => {
  it("no_result retries when listed, then fails", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.adapter.setOutcome("fr_1", OK);
    await r.engine.tick();

    let [first, second] = rows(r.store, runId);
    expect(first).toMatchObject({
      attempt: 1,
      state: "failed",
      ending: "no_result",
    });
    expect(first?.endedAt).not.toBeNull();
    // The retry is a new row: same visit, next retry index, fresh token.
    expect(second).toMatchObject({
      attempt: 2,
      visit: 1,
      retryIndex: 1,
      state: "working",
      idempotencyKey: `${runId}:draft:2`,
    });
    expect(lastToken(r.adapter)).not.toBe(token);
    expect(r.adapter.calls[1]?.message).toContain("Write a short draft");

    r.adapter.setOutcome("fr_2", OK);
    await r.engine.tick();
    [first, second] = rows(r.store, runId);
    expect(second).toMatchObject({ state: "failed", ending: "no_result" });
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("failed");
    expect(view.run.currentStage).toBe("failed");
    expect(events(r, runId)).toEqual([
      "run_created",
      "stage_submitted",
      "turn_started",
      "no_result",
      "stage_submitted",
      "turn_started",
      "no_result",
      "run_ended",
    ]);
    const endings = view.transitions.filter((x) => x.event === "no_result");
    expect(endings.map((x) => [x.fromState, x.toState])).toEqual([
      ["working", "failed"],
      ["working", "failed"],
    ]);
    expect(endings[0]?.detail).toMatchObject({ retry: { attempt: 2 } });
    expect(endings[1]?.detail).toMatchObject({
      exhausted: true,
      next: "failed",
    });
    expect(r.adapter.calls).toHaveLength(2);
  });

  it("deadline retires the token and a late stage_complete is refused", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const [live] = rows(r.store, runId);
    expect(live?.deadlineAt).toBe(1_000_000 + 30 * MIN);

    r.adapter.setOutcome("fr_1", OK);
    r.clock.advance(30 * MIN);
    await r.engine.tick();

    const [row] = rows(r.store, runId);
    expect(row).toMatchObject({ state: "failed", ending: "timeout" });
    // The hash stays so a late call is recognised and refused, not unknown.
    expect(row?.tokenHash).not.toBeNull();
    expect(r.adapter.aborted).toEqual(["fr_1"]);
    // timeout is not in the review loop's retry list: the failed end.
    expect(r.engine.status(runId).run.status).toBe("failed");
    expect(events(r, runId).filter((e) => e === "timeout")).toHaveLength(1);

    const late = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    expect(late).toEqual({
      ok: false,
      error: expect.stringMatching(/timed out/),
    });
    const refused = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "completion_refused");
    expect(refused?.detail).toEqual({ reason: "attempt timed out" });
  });

  it("a retried attempt gets a fresh deadline and no abort when the harness cannot", async () => {
    const r = await edited((def) => {
      agent(def, "draft").retry = { max: 1, on: ["timeout"] };
    });
    r.adapter.caps = { ...r.adapter.caps, canAbort: false };
    const { runId } = await started(r);
    r.clock.advance(30 * MIN);
    await r.engine.tick();
    expect(r.adapter.aborted).toEqual([]);
    const [, retry] = rows(r.store, runId);
    expect(retry).toMatchObject({ retryIndex: 1, state: "working" });
    expect(retry?.deadlineAt).toBe(r.clock.now() + 30 * MIN);
  });

  it("stage_progress then turn end dispatches a continuation with the note", async () => {
    const r = await edited((def) => {
      agent(def, "draft").turns.max = 3;
    });
    const { runId, token } = await started(r);
    const deadline = rows(r.store, runId)[0]?.deadlineAt;
    expect(
      await r.engine.progress({ token, note: "outline done; next: prose" }),
    ).toMatchObject({ ok: true });
    r.adapter.setOutcome("fr_1", OK);
    r.clock.advance(MIN);
    await r.engine.tick();

    expect(r.adapter.calls).toHaveLength(2);
    const next = r.adapter.calls[1];
    expect(next?.idempotencyKey).toBe(`${runId}:draft:1:2`);
    expect(next?.sessionKey).toBe(r.adapter.calls[0]?.sessionKey);
    expect(next?.message).toContain("outline done; next: prose");
    expect(next?.message).not.toContain("Write a short draft");
    expect(tokenOf(next?.message ?? "")).toBe(token);
    const [row] = rows(r.store, runId);
    expect(row).toMatchObject({
      state: "working",
      attempt: 1,
      turnsUsed: 2,
      dispatchSeq: 2,
      adapterRunId: "fr_2",
    });
    // Continuation turns do not reset the attempt's deadline.
    expect(row?.deadlineAt).toBe(deadline);
    const cont = r.engine
      .status(runId)
      .transitions.filter((x) => x.event === "continue");
    expect(cont.map((x) => [x.fromState, x.toState])).toEqual([
      ["working", "submitted"],
    ]);

    // The same token completes the stage from the continuation turn.
    expect(
      await r.engine.complete({
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
      }),
    ).toMatchObject({ ok: true, next: "check" });
  });

  it("a turn that ends without a fresh note is no_result even after an earlier note", async () => {
    const r = await edited((def) => {
      agent(def, "draft").turns.max = 3;
    });
    const { runId, token } = await started(r);
    await r.engine.progress({ token, note: "step one" });
    r.adapter.setOutcome("fr_1", OK);
    // The virtual clock does not move: freshness cannot rest on timestamps.
    await r.engine.tick();
    expect(r.adapter.calls).toHaveLength(2);
    r.adapter.setOutcome("fr_2", OK);
    await r.engine.tick();
    const [first] = rows(r.store, runId);
    expect(first).toMatchObject({ state: "failed", ending: "no_result" });
  });

  it("turns.max reached without completion ends as no_result", async () => {
    const r = await edited((def) => {
      agent(def, "draft").turns.max = 2;
    });
    const { runId, token } = await started(r);
    await r.engine.progress({ token, note: "first half" });
    r.adapter.setOutcome("fr_1", OK);
    await r.engine.tick();
    await r.engine.progress({ token, note: "second half" });
    r.adapter.setOutcome("fr_2", OK);
    await r.engine.tick();

    const [first, retry] = rows(r.store, runId);
    expect(first).toMatchObject({
      state: "failed",
      ending: "no_result",
      turnsUsed: 2,
    });
    // One transition for the ending: no_result, not a continue as well.
    expect(events(r, runId)).toEqual([
      "run_created",
      "stage_submitted",
      "turn_started",
      "progress",
      "continue",
      "turn_started",
      "progress",
      "no_result",
      "stage_submitted",
      "turn_started",
    ]);
    const ending = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "no_result");
    expect(ending?.detail).toMatchObject({ turns: { used: 2, max: 2 } });
    // no_result is in the review loop's retry list.
    expect(retry).toMatchObject({ attempt: 2, retryIndex: 1 });
    expect(r.adapter.calls[2]?.message).toContain("Write a short draft");
  });

  it("a turn error not listed for retry takes on_exhausted", async () => {
    const r = await edited((def) => {
      agent(def, "draft").onExhausted = "done";
    });
    const { runId } = await started(r);
    r.adapter.setOutcome("fr_1", {
      state: "ended",
      ending: "killed",
      error: "cap reached",
    });
    await r.engine.tick();
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("completed");
    const ending = view.transitions.find((x) => x.event === "turn_error");
    expect(ending?.detail).toMatchObject({
      error: "cap reached",
      exhausted: true,
      next: "done",
    });
  });

  it("an exhausted stage with no failed end fails the run", async () => {
    const r = await edited((def) => {
      const draft = agent(def, "draft");
      draft.outcomes.blocked = { ...draft.outcomes.blocked, next: "done" };
      const check = agent(def, "check");
      check.outcomes.fail = { ...check.outcomes.fail, next: "draft" };
      const publish = def.stages.publish;
      if (publish?.type !== "gate") throw new Error("fixture changed");
      publish.outcomes.reject = { next: "done" };
      delete def.stages.failed;
    });
    const { runId } = await started(r);
    r.adapter.setOutcome("fr_1", { state: "ended", ending: "error" });
    await r.engine.tick();
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("failed");
    expect(view.transitions.slice(-2).map((x) => x.event)).toEqual([
      "turn_error",
      "exhausted_no_failed_end",
    ]);
    expect(view.transitions.at(-2)?.detail).toMatchObject({
      exhausted: true,
      next: null,
    });
  });

  it("a completion that lands while the turn's end is read wins", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.adapter.setOutcome("fr_1", OK);
    r.adapter.beforeRead = async () => {
      r.adapter.beforeRead = undefined;
      await r.engine.complete({
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
      });
    };
    await r.engine.tick();
    const [draft] = rows(r.store, runId);
    expect(draft).toMatchObject({ state: "completed", outcome: "drafted" });
    expect(draft?.ending).toBeUndefined();
    expect(events(r, runId)).not.toContain("no_result");
  });

  it("a running turn is left alone and unknown waits for reconciliation", async () => {
    const r = await make();
    const { runId } = await started(r);
    await r.engine.tick();
    r.adapter.setOutcome("fr_1", { state: "unknown" });
    await r.engine.tick();
    expect(rows(r.store, runId)[0]?.state).toBe("working");
    expect(r.adapter.calls).toHaveLength(1);
  });
});

describe("adapter call timeouts", () => {
  it("a hung startTurn leaves the row submitted under the same key", async () => {
    const r = await make({ adapterCallTimeoutMs: 20 });
    r.adapter.beforeStart = () => new Promise(() => {});
    const { runId } = await r.engine.startRun("review-loop", { topic: "t" });
    await r.engine.tick();
    let [row] = rows(r.store, runId);
    expect(row).toMatchObject({ state: "submitted", dispatchSeq: 1 });
    expect(events(r, runId)).toContain("turn_start_failed");
    const failed = r.engine
      .status(runId)
      .transitions.find((x) => x.event === "turn_start_failed");
    expect(failed?.detail).toMatchObject({
      error: expect.stringMatching(/startTurn timed out after 20 ms/),
    });

    r.adapter.beforeStart = undefined;
    await r.engine.tick();
    [row] = rows(r.store, runId);
    expect(row).toMatchObject({ state: "working", dispatchSeq: 1 });
    expect(r.adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:1`,
      `${runId}:draft:1`,
    ]);
  });

  it("a hung readRunOutcome is read again on the next tick", async () => {
    const r = await make({ adapterCallTimeoutMs: 20 });
    const { runId } = await started(r);
    r.adapter.setOutcome(lastRunId(r), OK);
    r.adapter.beforeRead = () => new Promise(() => {});
    await r.engine.tick();
    expect(rows(r.store, runId)[0]?.state).toBe("working");
    r.adapter.beforeRead = undefined;
    await r.engine.tick();
    expect(rows(r.store, runId)[0]).toMatchObject({
      state: "failed",
      ending: "no_result",
    });
  });
});
