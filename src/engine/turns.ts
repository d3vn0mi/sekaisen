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
import type { PinnedDefinitions } from "./pinned.js";
import {
  isDegraded,
  PROVIDER_SCOPE,
  preferredProvider,
  providerPause,
  refusedProvider,
} from "./providers.js";

/**
 * The tick's decisions about turns, each the body of one transaction. The
 * engine does the harness calls around them; every function re-reads the
 * stage run and does nothing when it moved on since the harness was asked.
 */

export interface TickCtx {
  t: StoreTx;
  pinned: PinnedDefinitions;
  now: number;
  emit: EmitFn;
  caps: Capabilities;
}

export type EndedOutcome = Extract<RunOutcome, { state: "ended" }>;

/** Longest error text kept in a transition or a limit's reason. */
const MAX_ERROR_CHARS = 1000;

export function deadlinePassed(row: StageRunRow, now: number): boolean {
  return row.deadlineAt !== null && now >= row.deadlineAt;
}

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

  if (o.ending === "ok" && runtime) {
    const degraded = isDegraded(
      ctx.pinned.def.providers,
      runtime.provider,
      c.caps,
    );
    detail.degraded = degraded;
    if (degraded) {
      // The turn's work is paid for and stands; later turns wait for the
      // provider the policy wants.
      const p = preferredProvider(c.caps);
      c.t.putLimit({
        scope: PROVIDER_SCOPE,
        key: p,
        pausedUntil: c.now + DEFAULT_PAUSE_MS,
        reason: `a turn ran on ${runtime.provider}, outside the pipeline's providers`,
        setAt: c.now,
      });
      detail.paused = `${PROVIDER_SCOPE}:${p}`;
    }
  }

  if (row.state !== "working" || run.status !== "working") {
    closeTurn(c, row, patch, "turn_ended", detail);
    return;
  }

  let ending = classifyEnding(o, row, c.now);
  if (ending === "continue") {
    const turns = { used: row.turnsUsed, max: stage.turns.max };
    if (turns.used < turns.max && !deadlinePassed(row, c.now)) {
      continueAttempt(ctx, row, patch, { ...detail, turns });
      return;
    }
    ending = "no_result";
    detail.turns = turns;
  }
  if (ending === "usage_limited") {
    const error = o.error ?? "";
    pauseAttempt(
      ctx,
      row,
      refusedProvider(o.runtime, c.caps),
      parseReset(error, c.now),
      clip(refusalLine(error) ?? error),
      patch,
      detail,
    );
    return;
  }
  endAttempt(ctx, row, stage, ending, patch, detail);
}

/**
 * Ends an attempt whose deadline passed. Returns the harness run to abort
 * when a turn was in flight. The token keeps its hash, so a late completion
 * is refused as timed out.
 */
export function recordTimeout(
  c: TickCtx,
  seen: StageRunRow,
): string | undefined {
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
export function forgetTurn(c: TickCtx, seen: StageRunRow): void {
  const row = c.t.getStageRun(seen.stageRunId);
  if (!row || !sameTurn(row, seen) || row.dispatchedAt === null) return;
  c.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { dispatchedAt: null },
  );
}

/**
 * Why a submitted agent stage run must wait for a provider, recording the
 * reason on the row; undefined when it may be dispatched.
 */
export function holdForProvider(
  c: TickCtx,
  seen: StageRunRow,
): string | undefined {
  const row = c.t.getStageRun(seen.stageRunId);
  if (row?.state !== "submitted") return undefined;
  const run = c.t.getRun(row.runId);
  if (run?.status !== "working") return undefined;
  const def = c.pinned.of(c.t, run).def;
  if (def.stages[row.stage]?.type !== "agent") return undefined;
  const reason = providerPause(
    row,
    def.providers,
    c.t.listLimits(c.now),
    c.caps,
  );
  if (reason !== undefined && reason !== row.waitReason) {
    c.t.updateStageRunIf(
      row.stageRunId,
      { state: "submitted", attempt: row.attempt },
      { waitReason: reason },
    );
  }
  return reason;
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
  c: TickCtx,
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

function clip(text: string): string {
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}…`
    : text;
}
