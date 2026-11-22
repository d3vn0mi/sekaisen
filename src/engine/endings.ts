import type { AgentStage, Definition, RetryEnding } from "../format/types.js";
import type { StageRunPatch, StageRunRow } from "../store/types.js";
import {
  ENGINE_ACTOR,
  enter,
  failRun,
  type RunCtx,
  submit,
  type TransitionDraft,
} from "./advance.js";
import { PROVIDER_SCOPE, pausedReason } from "./providers.js";

/**
 * What happens to an attempt once the engine has classified how its turn
 * ended. Each function runs inside the caller's transaction, moves the stage
 * run with a compare-and-set against the row it is given and writes exactly
 * one transition named after the ending.
 */

type Detail = Record<string, unknown>;

/** Where a stage goes when its retries are used up: `onExhausted`, else the first `failed` end. */
export function exhaustedTarget(
  def: Definition,
  stage: AgentStage,
): string | undefined {
  if (stage.onExhausted !== undefined) return stage.onExhausted;
  return Object.entries(def.stages).find(
    ([, s]) => s.type === "end" && s.status === "failed",
  )?.[0];
}

/** True when `ending` may retry the stage once more. */
export function canRetry(
  stage: AgentStage,
  row: StageRunRow,
  ending: RetryEnding,
): boolean {
  return stage.retry.on.includes(ending) && row.retryIndex < stage.retry.max;
}

/**
 * Ends the attempt `failed` with `ending`, then either submits a retry (a
 * new row in the same visit) or takes the stage's exhaustion edge. An
 * engine-classified ending never picks one of the agent's outcomes.
 */
export function endAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  stage: AgentStage,
  ending: RetryEnding,
  patch: StageRunPatch,
  detail: Detail,
): void {
  const { t, now } = ctx;
  move(ctx, row, "failed", {
    ...patch,
    state: "failed",
    ending,
    endedAt: now,
    dispatchedAt: null,
    waitReason: null,
  });
  const draft = transition(row, "failed", ending);
  if (canRetry(stage, row, ending)) {
    const attempt = t.maxAttempt(row.runId, row.stage) + 1;
    append(ctx, draft, { ...detail, retry: { attempt } });
    submit(ctx, row.stage, row.visit, row.retryIndex + 1, ENGINE_ACTOR);
    return;
  }
  const target = exhaustedTarget(ctx.pinned.def, stage);
  append(ctx, draft, { ...detail, exhausted: true, next: target ?? null });
  if (target === undefined) {
    failRun(ctx, "exhausted_no_failed_end", ENGINE_ACTOR, { stage: row.stage });
  } else {
    enter(ctx, target, ENGINE_ACTOR);
  }
}

/** Sends the attempt back for a continuation turn in the same session. */
export function continueAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  patch: StageRunPatch,
  detail: Detail,
): void {
  move(ctx, row, "submitted", {
    ...patch,
    state: "submitted",
    dispatchedAt: null,
  });
  append(ctx, transition(row, "submitted", "continue"), detail);
}

/**
 * Pauses `provider` until `until` and sends the attempt back to wait for it.
 * The refused turn costs neither a retry nor one of the attempt's turns,
 * and the deadline starts again with the next turn: time spent paused is
 * not the agent's.
 */
export function pauseAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  provider: string,
  until: number,
  reason: string,
  patch: StageRunPatch,
  detail: Detail,
): void {
  const { t, now } = ctx;
  t.putLimit({
    scope: PROVIDER_SCOPE,
    key: provider,
    pausedUntil: until,
    reason,
    setAt: now,
  });
  move(ctx, row, "submitted", {
    ...patch,
    state: "submitted",
    waitReason: pausedReason(provider),
    turnsUsed: Math.max(0, row.turnsUsed - 1),
    deadlineAt: null,
    dispatchedAt: null,
  });
  append(ctx, transition(row, "submitted", "usage_limited"), {
    ...detail,
    provider,
    until,
  });
}

function move(
  ctx: RunCtx,
  row: StageRunRow,
  to: StageRunRow["state"],
  patch: StageRunPatch,
): void {
  const ok = ctx.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    patch,
  );
  if (!ok) {
    throw new Error(
      `stage run ${row.stageRunId} changed during the transaction`,
    );
  }
  ctx.emit("stage_changed", {
    runId: row.runId,
    stageRunId: row.stageRunId,
    stage: row.stage,
    from: row.state,
    to,
  });
}

function transition(
  row: StageRunRow,
  to: StageRunRow["state"],
  event: string,
): TransitionDraft {
  return {
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: to,
    event,
    outcome: null,
    actor: ENGINE_ACTOR,
    detail: null,
  };
}

function append(ctx: RunCtx, draft: TransitionDraft, detail: Detail): void {
  ctx.t.appendTransition({
    ...draft,
    runId: ctx.run.runId,
    at: ctx.now,
    detail,
  });
}
