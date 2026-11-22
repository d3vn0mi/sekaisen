import type { Capabilities, RunOutcome } from "../adapter/types.js";
import type { AgentStage } from "../format/types.js";
import type {
  RunRow,
  RuntimeInfo,
  StageRunPatch,
  StageRunRow,
  StoreTx,
} from "../store/types.js";
import { actorOf, type RunCtx } from "./advance.js";
import {
  classifyEnding,
  DEFAULT_PAUSE_MS,
  parseReset,
  refusalLine,
} from "./classify.js";
import { continueAttempt, endAttempt, pauseAttempt } from "./endings.js";
import type { EmitFn } from "./events.js";
import { deadlinePassed } from "./lifecycle.js";
import type { PinnedDefinitions } from "./pinned.js";
import {
  degradedPolicy,
  POLICY_SCOPE,
  PROVIDER_SCOPE,
  refusedProvider,
} from "./providers.js";
import { clip } from "./values.js";

/**
 * The tick's decisions about turns, each the body of one transaction. The
 * engine does the harness calls around them; every function re-reads the
 * stage run and does nothing when it moved on since the harness was asked.
 */

/** What every tick transaction needs. */
export interface TxCtx {
  t: StoreTx;
  pinned: PinnedDefinitions;
  now: number;
  emit: EmitFn;
  /** Who the engine's own transitions name; `ENGINE_ACTOR` when unset. */
  actor?: string;
}

/**
 * A harness turn to abort, recorded on its stage run (`abortRunId`) in the
 * transaction that decided it, and cleared once the harness has answered,
 * cannot abort at all, or has failed `MAX_ABORT_ATTEMPTS` calls.
 */
export interface AbortRequest {
  stageRunId: string;
  adapterRunId: string;
}

/** Failed abort calls after which a request is given up. */
export const MAX_ABORT_ATTEMPTS = 5;
const ABORT_BACKOFF_MS = 60_000;
const ABORT_BACKOFF_CAP_MS = 30 * 60_000;

/** The wait before the next abort call after `failed` failed ones. */
export function abortBackoffMs(failed: number): number {
  return Math.min(
    ABORT_BACKOFF_CAP_MS,
    ABORT_BACKOFF_MS * 2 ** Math.max(0, failed - 1),
  );
}

/** The columns that record a new abort request, due at once. */
export function abortRequest(adapterRunId: string, now: number): StageRunPatch {
  return { abortRunId: adapterRunId, abortAttempts: 0, abortNextAt: now };
}

/** Logs an abort event against a stage run in the state it is now in. */
export function logAbort(
  t: StoreTx,
  row: Pick<StageRunRow, "runId" | "stageRunId" | "state">,
  event: "abort_requested" | "abort_settled" | "abort_abandoned",
  actor: string,
  at: number,
  detail: Record<string, unknown>,
): void {
  t.appendTransition({
    runId: row.runId,
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: row.state,
    event,
    outcome: null,
    actor,
    at,
    detail,
  });
}

/** A tick transaction that also needs the harness's capabilities. */
export interface TickCtx extends TxCtx {
  caps: Capabilities;
}

export type EndedOutcome = Extract<RunOutcome, { state: "ended" }>;

/**
 * Records the end of the turn `seen` had in flight. On a completed stage run
 * it only records the provider (and applies the provider policy); on a
 * working one it classifies the ending and continues, pauses, retries or
 * exhausts the attempt.
 */
export function recordTurnEnd(
  c: TickCtx,
  seen: StageRunRow,
  o: EndedOutcome,
): void {
  const found = current(c, seen);
  if (!found) return;
  const { row, run, stage, ctx } = found;
  const runtime: RuntimeInfo | undefined = o.runtime && {
    provider: o.runtime.provider,
    model: o.runtime.model,
  };
  const patch: StageRunPatch = runtime ? { runtime } : {};
  const detail: Record<string, unknown> = {
    adapterRunId: row.adapterRunId,
    ending: o.ending,
    ...(o.error === undefined ? {} : { error: clip(o.error) }),
    ...(runtime ?? {}),
  };

  // A turn outside the pipeline's providers pauses that policy. With
  // `stage_complete` its work stands; without, it is a usage limit.
  const policy =
    o.ending === "ok"
      ? degradedPolicy(ctx.pinned.def.providers, runtime?.provider, c.caps)
      : undefined;
  if (o.ending === "ok" && runtime) detail.degraded = policy !== undefined;
  const policyPause = policy && {
    scope: POLICY_SCOPE,
    key: policy,
    until: c.now + DEFAULT_PAUSE_MS,
    reason: `a turn ran on ${runtime?.provider}, outside the pipeline's providers`,
  };

  if (row.state !== "working" || run.status !== "working") {
    if (policyPause) {
      c.t.putLimit({
        scope: policyPause.scope,
        key: policyPause.key,
        pausedUntil: policyPause.until,
        reason: policyPause.reason,
        setAt: c.now,
      });
      detail.paused = `${POLICY_SCOPE}:${policy}`;
    }
    closeTurn(c, row, patch, "turn_ended", detail);
    return;
  }

  let ending = classifyEnding(o, row, c.now);
  const turns = { used: row.turnsUsed, max: stage.turns.max };
  const canContinue = turns.used < turns.max && !deadlinePassed(row, c.now);
  if (policyPause) {
    const keepTurn = ending === "continue" && canContinue;
    pauseAttempt(ctx, row, policyPause, keepTurn, patch, detail);
    return;
  }
  if (ending === "continue") {
    if (canContinue) {
      continueAttempt(ctx, row, patch, { ...detail, turns });
      return;
    }
    ending = "no_result";
    detail.turns = turns;
  }
  if (ending === "usage_limited") {
    const error = o.error ?? "";
    const pause = {
      scope: PROVIDER_SCOPE,
      key: refusedProvider(o.runtime, c.caps),
      until: parseReset(error, c.now),
      reason: clip(refusalLine(error) ?? error),
    };
    pauseAttempt(ctx, row, pause, false, patch, detail);
    return;
  }
  endAttempt(ctx, row, stage, ending, patch, detail);
}

/**
 * Ends an attempt whose deadline passed. Returns the harness turn to abort
 * when one was in flight. The token keeps its hash, so a late completion is
 * refused as timed out.
 */
export function recordTimeout(
  c: TxCtx,
  seen: StageRunRow,
): AbortRequest | undefined {
  const found = current(c, seen);
  if (!found) return undefined;
  const { row, run, stage, ctx } = found;
  const live = row.state === "working" || row.state === "submitted";
  if (!live || run.status !== "working" || !deadlinePassed(row, c.now)) {
    return undefined;
  }
  const inFlight =
    row.state === "working" && row.dispatchedAt !== null
      ? (row.adapterRunId ?? undefined)
      : undefined;
  endAttempt(
    ctx,
    row,
    stage,
    "timeout",
    inFlight === undefined ? {} : abortRequest(inFlight, c.now),
    {
      deadlineAt: row.deadlineAt,
      ...(inFlight === undefined ? {} : { adapterRunId: inFlight }),
    },
  );
  if (inFlight === undefined) return undefined;
  logAbort(
    c.t,
    { ...row, state: "failed" },
    "abort_requested",
    actorOf(ctx),
    c.now,
    { adapterRunId: inFlight },
  );
  return { stageRunId: row.stageRunId, adapterRunId: inFlight };
}

/**
 * Ends a working attempt whose turn the harness no longer knows, as after a
 * restart that killed it: the attempt is `lost` and the retry policy
 * applies. The token keeps its hash, so a late completion is refused.
 */
export function recordLost(c: TxCtx, seen: StageRunRow): void {
  const found = current(c, seen);
  if (!found) return;
  const { row, run, stage, ctx } = found;
  if (row.state !== "working" || run.status !== "working") return;
  endAttempt(ctx, row, stage, "lost", {}, { adapterRunId: row.adapterRunId });
}

/**
 * Drops an abort request the harness has answered, or one it can never
 * take, and logs how it ended.
 */
export function settleAbort(
  c: TxCtx,
  req: AbortRequest,
  answer: { aborted: boolean; reason?: string },
): void {
  const row = c.t.getStageRun(req.stageRunId);
  if (row?.abortRunId !== req.adapterRunId) return;
  const ok = c.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { abortRunId: null, abortNextAt: null },
  );
  if (!ok) return;
  logAbort(c.t, row, "abort_settled", actorOf(c), c.now, {
    adapterRunId: req.adapterRunId,
    ...answer,
  });
}

/**
 * Counts a failed abort call: the next one waits out a doubling backoff,
 * and after `MAX_ABORT_ATTEMPTS` failures the request is given up and logged.
 */
export function failAbort(c: TxCtx, req: AbortRequest, error: string): void {
  const row = c.t.getStageRun(req.stageRunId);
  if (row?.abortRunId !== req.adapterRunId) return;
  const attempts = row.abortAttempts + 1;
  const abandon = attempts >= MAX_ABORT_ATTEMPTS;
  const ok = c.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    abandon
      ? { abortRunId: null, abortNextAt: null, abortAttempts: attempts }
      : {
          abortAttempts: attempts,
          abortNextAt: c.now + abortBackoffMs(attempts),
        },
  );
  if (!ok || !abandon) return;
  logAbort(c.t, row, "abort_abandoned", actorOf(c), c.now, {
    adapterRunId: req.adapterRunId,
    attempts,
    error: clip(error),
  });
}

/** Stops watching a turn there is nothing more to learn about. */
export function forgetTurn(c: TxCtx, seen: StageRunRow): void {
  const row = c.t.getStageRun(seen.stageRunId);
  if (!row || !sameTurn(row, seen) || row.dispatchedAt === null) return;
  c.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { dispatchedAt: null },
  );
}

/**
 * Records why a submitted stage run the scheduler refused waits. A pause
 * holds it: `heldSince` is set so its deadline does not run down. Any other
 * reason (WIP, lane) releases a hold, moving the deadline by the time held.
 * Writes nothing when nothing changed.
 */
export function recordWait(
  c: TxCtx,
  seen: StageRunRow,
  reason: string,
  paused: boolean,
): void {
  const row = submittedNow(c, seen);
  if (!row) return;
  const patch: StageRunPatch = paused
    ? row.heldSince === null
      ? { heldSince: c.now }
      : {}
    : release(row, c.now);
  if (reason !== row.waitReason) patch.waitReason = reason;
  if (Object.keys(patch).length === 0) return;
  c.t.updateStageRunIf(
    row.stageRunId,
    { state: "submitted", attempt: row.attempt },
    patch,
  );
}

/**
 * Takes an admitted stage run off the wait: clears its reason and releases
 * a hold, moving the deadline by the time held. `paused` is asked first,
 * with the row as it now is: a pause it names holds the row instead (see
 * `recordWait`). Returns the row as it now is, or undefined when it is held
 * or no longer the submitted attempt `seen` was.
 */
export function recordAdmit(
  c: TxCtx,
  seen: StageRunRow,
  paused: (row: StageRunRow) => string | undefined = () => undefined,
): StageRunRow | undefined {
  const row = submittedNow(c, seen);
  if (!row) return undefined;
  const reason = paused(row);
  if (reason !== undefined) {
    recordWait(c, row, reason, true);
    return undefined;
  }
  const patch: StageRunPatch = release(row, c.now);
  if (row.waitReason !== null) patch.waitReason = null;
  if (Object.keys(patch).length === 0) return row;
  const ok = c.t.updateStageRunIf(
    row.stageRunId,
    { state: "submitted", attempt: row.attempt },
    patch,
  );
  return ok ? ({ ...row, ...patch } as StageRunRow) : undefined;
}

/** The columns that end a pause's hold on `row`, if one holds it. */
function release(row: StageRunRow, now: number): StageRunPatch {
  if (row.heldSince === null) return {};
  return {
    heldSince: null,
    deadlineAt:
      row.deadlineAt === null ? null : row.deadlineAt + (now - row.heldSince),
  };
}

/** The stage run as it is now, if it is still the submitted attempt `seen` was. */
function submittedNow(c: TxCtx, seen: StageRunRow): StageRunRow | undefined {
  const row = c.t.getStageRun(seen.stageRunId);
  if (row?.state !== "submitted" || row.attempt !== seen.attempt) {
    return undefined;
  }
  return row;
}

function closeTurn(
  c: TickCtx,
  row: StageRunRow,
  patch: StageRunPatch,
  event: string,
  detail: Record<string, unknown>,
): void {
  const ok = c.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { ...patch, dispatchedAt: null },
  );
  if (!ok) return;
  c.t.appendTransition({
    runId: row.runId,
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: row.state,
    event,
    outcome: null,
    actor: actorOf(c),
    at: c.now,
    detail,
  });
}

function sameTurn(row: StageRunRow, seen: StageRunRow): boolean {
  return (
    row.attempt === seen.attempt &&
    row.dispatchSeq === seen.dispatchSeq &&
    row.adapterRunId === seen.adapterRunId
  );
}

/** The stage run as it is now, if it is still on the turn `seen` saw. */
function current(
  c: TxCtx,
  seen: StageRunRow,
):
  | { row: StageRunRow; run: RunRow; stage: AgentStage; ctx: RunCtx }
  | undefined {
  const row = c.t.getStageRun(seen.stageRunId);
  if (!row || !sameTurn(row, seen)) return undefined;
  if (seen.dispatchedAt !== null && row.dispatchedAt === null) return undefined;
  const run = c.t.getRun(row.runId);
  if (!run) return undefined;
  const pinned = c.pinned.of(c.t, run);
  const stage = pinned.def.stages[row.stage];
  if (stage?.type !== "agent") return undefined;
  return {
    row,
    run,
    stage,
    ctx: {
      t: c.t,
      pinned,
      run,
      now: c.now,
      emit: c.emit,
      ...(c.actor === undefined ? {} : { actor: c.actor }),
    },
  };
}
