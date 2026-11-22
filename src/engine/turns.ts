import type { Capabilities, RunOutcome } from "../adapter/types.js";
import type { AgentStage } from "../format/types.js";
import type {
  RunRow,
  RuntimeInfo,
  StageRunPatch,
  StageRunRow,
  StoreTx,
} from "../store/types.js";
import { ENGINE_ACTOR, type RunCtx } from "./advance.js";
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
  providerPause,
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
 * Ends an attempt whose deadline passed. Returns the harness run to abort
 * when a turn was in flight. The token keeps its hash, so a late completion
 * is refused as timed out.
 */
export function recordTimeout(c: TxCtx, seen: StageRunRow): string | undefined {
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
    {},
    {
      deadlineAt: row.deadlineAt,
      ...(inFlight === undefined ? {} : { adapterRunId: inFlight }),
    },
  );
  return inFlight;
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
 * Whether a submitted agent stage run is held by a pause. A newly held row
 * records `heldSince` with the reason; a row released from a hold has its
 * deadline moved by the time it was held. Returns the row as it now is.
 */
export function admission(
  c: TickCtx,
  seen: StageRunRow,
): { held: string } | { row: StageRunRow } | undefined {
  const row = c.t.getStageRun(seen.stageRunId);
  if (row?.state !== "submitted") return undefined;
  const run = c.t.getRun(row.runId);
  if (run?.status !== "working") return undefined;
  const def = c.pinned.of(c.t, run).def;
  const expect = { state: "submitted" as const, attempt: row.attempt };
  if (def.stages[row.stage]?.type !== "agent") {
    // Every other stage type is the tick's own; a row without a wake time
    // (written before stage runs had one) is handed to it.
    if (row.wakeAt === null) {
      c.t.updateStageRunIf(row.stageRunId, expect, { wakeAt: c.now });
    }
    return undefined;
  }
  const reason = providerPause(
    row,
    def.providers,
    c.t.listLimits(c.now),
    c.caps,
  );
  if (reason !== undefined) {
    if (reason !== row.waitReason || row.heldSince === null) {
      c.t.updateStageRunIf(row.stageRunId, expect, {
        waitReason: reason,
        heldSince: row.heldSince ?? c.now,
      });
    }
    return { held: reason };
  }
  if (row.heldSince === null) return { row };
  const released: StageRunPatch = {
    heldSince: null,
    deadlineAt:
      row.deadlineAt === null ? null : row.deadlineAt + (c.now - row.heldSince),
  };
  c.t.updateStageRunIf(row.stageRunId, expect, released);
  return { row: { ...row, ...released } as StageRunRow };
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
    actor: ENGINE_ACTOR,
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
    ctx: { t: c.t, pinned, run, now: c.now, emit: c.emit },
  };
}
