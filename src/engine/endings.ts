import { failedEnd } from "../format/rules.js";
import type {
  Definition,
  RetryEnding,
  RetryPolicy,
  Stage,
} from "../format/types.js";
import type { StageRunPatch, StageRunRow } from "../store/types.js";
import {
  actorOf,
  ENGINE_ACTOR,
  enter,
  failRun,
  type RunCtx,
  submit,
  type TransitionDraft,
} from "./advance.js";
import { pausedReason } from "./providers.js";

/**
 * What happens to an attempt once the engine has classified how its turn
 * ended. Each function runs inside the caller's transaction, moves the stage
 * run with a compare-and-set against the row it is given and writes exactly
 * one transition named after the ending.
 */

type Detail = Record<string, unknown>;

/** How a failed attempt of a stage goes on: its retries, then where it exhausts to. */
export interface AttemptPolicy {
  retry: RetryPolicy;
  onExhausted?: string;
}

/** The retry policy of a stage type that declares none. */
export const NO_RETRY: RetryPolicy = { max: 0, on: [] };

/** The attempt policy of any stage: its own for agents and actions, no retry otherwise. */
export function policyOf(stage: Stage): AttemptPolicy {
  return stage.type === "agent" || stage.type === "action"
    ? stage
    : { retry: NO_RETRY };
}

/** Where a stage goes when its retries are used up: `onExhausted`, else the first `failed` end. */
export function exhaustedTarget(
  def: Definition,
  stage: AttemptPolicy,
): string | undefined {
  return stage.onExhausted ?? failedEnd(def);
}

/** True when `ending` may retry the stage once more. */
export function canRetry(
  stage: AttemptPolicy,
  row: StageRunRow,
  ending: RetryEnding | null,
): boolean {
  return (
    ending !== null &&
    stage.retry.on.includes(ending) &&
    row.retryIndex < stage.retry.max
  );
}

/**
 * Ends the attempt `failed` with `ending`, then either submits a retry (a
 * new row in the same visit) or takes the stage's exhaustion edge. An
 * engine-classified ending never picks one of the stage's outcomes. The
 * transition is named after the ending unless `event` names it; a null
 * ending (the stage itself is wrong, not its run) is never retried and
 * must name its event.
 */
export function endAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  stage: AttemptPolicy,
  ending: RetryEnding,
  patch: StageRunPatch,
  detail: Detail,
  event?: string,
): void;
export function endAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  stage: AttemptPolicy,
  ending: null,
  patch: StageRunPatch,
  detail: Detail,
  event: string,
): void;
export function endAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  stage: AttemptPolicy,
  ending: RetryEnding | null,
  patch: StageRunPatch,
  detail: Detail,
  event?: string,
): void {
  const { t, now } = ctx;
  move(ctx, row, "failed", {
    ...patch,
    state: "failed",
    ...(ending === null ? {} : { ending }),
    endedAt: now,
    dispatchedAt: null,
    waitReason: null,
    wakeAt: null,
  });
  const actor = actorOf(ctx);
  const name = event ?? ending;
  if (name === null) {
    throw new Error("an attempt ended without an ending must name its event");
  }
  const draft = transition(row, "failed", name, actor);
  if (canRetry(stage, row, ending)) {
    const attempt = t.maxAttempt(row.runId, row.stage) + 1;
    append(ctx, draft, { ...detail, retry: { attempt } });
    submit(ctx, row.stage, row.visit, row.retryIndex + 1, actor);
    return;
  }
  const target = exhaustedTarget(ctx.pinned.def, stage);
  append(ctx, draft, { ...detail, exhausted: true, next: target ?? null });
  if (target === undefined) {
    failRun(ctx, "exhausted_no_failed_end", actor, { stage: row.stage });
  } else {
    enter(ctx, target, actor);
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
  append(ctx, transition(row, "submitted", "continue", actorOf(ctx)), detail);
}

/** A pause to write, and to hold the attempt on. */
export interface Pause {
  scope: string;
  key: string;
  until: number;
  reason: string;
}

/**
 * Writes `pause` and sends the attempt back to wait for it; it never costs a
 * retry. A turn that did no usable work (refused, or ended without a fresh
 * note) is not counted and the deadline starts again with the next turn. A
 * turn that left a fresh note keeps its count and the attempt continues from
 * the note once released; its deadline moves by the time it is held.
 */
export function pauseAttempt(
  ctx: RunCtx,
  row: StageRunRow,
  pause: Pause,
  keepTurn: boolean,
  patch: StageRunPatch,
  detail: Detail,
): void {
  const { t, now } = ctx;
  t.putLimit({
    scope: pause.scope,
    key: pause.key,
    pausedUntil: pause.until,
    reason: pause.reason,
    setAt: now,
  });
  move(ctx, row, "submitted", {
    ...patch,
    state: "submitted",
    waitReason: pausedReason(pause.scope, pause.key),
    heldSince: now,
    dispatchedAt: null,
    ...(keepTurn
      ? {}
      : { turnsUsed: Math.max(0, row.turnsUsed - 1), deadlineAt: null }),
  });
  append(ctx, transition(row, "submitted", "usage_limited", actorOf(ctx)), {
    ...detail,
    [pause.scope]: pause.key,
    until: pause.until,
  });
}

export function move(
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

export function transition(
  row: StageRunRow,
  to: StageRunRow["state"],
  event: string,
  actor: string = ENGINE_ACTOR,
): TransitionDraft {
  return {
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: to,
    event,
    outcome: null,
    actor,
    detail: null,
  };
}

export function append(
  ctx: RunCtx,
  draft: TransitionDraft,
  detail: Detail,
): void {
  ctx.t.appendTransition({
    ...draft,
    runId: ctx.run.runId,
    at: ctx.now,
    detail,
  });
}
