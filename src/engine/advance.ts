import type { Next, Stage } from "../format/types.js";
import { evalGuard, type GuardContext } from "../guard/eval.js";
import { type GuardAst, parseGuard } from "../guard/parse.js";
import type {
  RunPatch,
  RunRow,
  RunStatus,
  StageRunRow,
  StoreTx,
  TransitionRow,
} from "../store/types.js";
import type { EmitFn } from "./events.js";
import { newStageRunId } from "./ids.js";
import type { Pinned } from "./pinned.js";
import { descend, errorMessage } from "./values.js";

/** The actor of transitions the engine makes on its own. */
export const ENGINE_ACTOR = "engine";

/** Everything advancing a run needs, inside one transaction. */
export interface RunCtx {
  t: StoreTx;
  /** The definition version the run is pinned to. */
  pinned: Pinned;
  run: RunRow;
  now: number;
  emit: EmitFn;
}

/** A transition the caller describes; advancing adds the run, time and next stage. */
export type TransitionDraft = Omit<TransitionRow, "id" | "runId" | "at">;

/** The `next` an outcome of a stage leads to, whatever the stage type. */
export function nextOf(stage: Stage, outcome: string): Next | undefined {
  switch (stage.type) {
    case "agent":
    case "gate":
      return Object.hasOwn(stage.outcomes, outcome)
        ? stage.outcomes[outcome]?.next
        : undefined;
    case "check":
      return Object.hasOwn(stage.outcomes, outcome)
        ? stage.outcomes[outcome]
        : undefined;
    case "action":
    case "wait":
      return stage.next;
    case "end":
      return undefined;
  }
}

/**
 * Records `done` (the transition that ended `from`) with the stage chosen
 * by `outcome`, then enters that stage or ends the run. Returns the stage
 * entered, or null when the run failed without reaching one. Never throws
 * for a guard; a guard that cannot be evaluated fails the run.
 */
export function advance(
  ctx: RunCtx,
  from: StageRunRow,
  outcome: string,
  done: TransitionDraft,
): string | null {
  const stage = ctx.pinned.def.stages[from.stage];
  const next = stage && nextOf(stage, outcome);
  const chosen =
    next === undefined
      ? { error: `stage ${from.stage} has no next for outcome ${outcome}` }
      : choose(ctx, from.stage, outcome, next);
  const target = "to" in chosen ? chosen.to : null;
  ctx.t.appendTransition({
    ...done,
    runId: ctx.run.runId,
    at: ctx.now,
    detail: { ...(done.detail as object), next: target },
  });
  if ("error" in chosen) {
    failRun(ctx, "guard_error", ENGINE_ACTOR, {
      ...(chosen.branch === undefined ? {} : { branch: chosen.branch }),
      error: chosen.error,
    });
    return null;
  }
  enter(ctx, chosen.to, ENGINE_ACTOR);
  return chosen.to;
}

/** The first branch whose guard holds. */
export function choose(
  ctx: RunCtx,
  stage: string,
  outcome: string,
  next: Next,
): { to: string } | { error: string; branch?: string } {
  if (typeof next === "string") return { to: next };
  const gc = guardContext(ctx.t, ctx.run);
  for (const [i, b] of next.entries()) {
    if (b.if === undefined) return { to: b.to };
    const branch = `${stage}.${outcome}[${i}]`;
    try {
      if (evalGuard(guard(ctx.pinned, b.if), gc)) return { to: b.to };
    } catch (err) {
      return { error: errorMessage(err), branch };
    }
  }
  return { error: `no branch of ${stage}.${outcome} matched` };
}

/** A parsed guard, cached on the pinned version; a syntax error is cached and rethrown. */
export function guard(pinned: Pinned, source: string): GuardAst {
  let ast = pinned.guards.get(source);
  if (ast === undefined) {
    try {
      ast = parseGuard(source);
    } catch (err) {
      ast = err instanceof Error ? err : new Error(String(err));
    }
    pinned.guards.set(source, ast);
  }
  if (ast instanceof Error) throw ast;
  return ast;
}

export function guardContext(t: StoreTx, run: RunRow): GuardContext {
  return {
    count: (stage, outcome) => t.countOutcome(run.runId, stage, outcome),
    attempts: (stage) => t.countAttempts(run.runId, stage),
    field: (stage, name) =>
      descend(t.latestCompleted(run.runId, stage)?.fields, name),
    input: (path) => descend(run.inputs, path),
  };
}

/** Creates the stage's submitted stage run, or ends the run on an `end` stage. */
export function enter(ctx: RunCtx, stageId: string, actor: string): void {
  const { t, run } = ctx;
  const stage = ctx.pinned.def.stages[stageId];
  if (!stage) {
    failRun(ctx, "unknown_stage", actor, { stage: stageId });
    return;
  }
  if (stage.type === "end") {
    endRun(ctx, stageId, stage.status, actor);
    return;
  }
  submit(ctx, stageId, t.countVisits(run.runId, stageId) + 1, 0, actor);
}

/**
 * Inserts the next attempt of `stageId` as a submitted stage run: a new
 * visit with retry index 0, or a retry within `visit`.
 */
export function submit(
  ctx: RunCtx,
  stageId: string,
  visit: number,
  retryIndex: number,
  actor: string,
): void {
  const { t, run, now } = ctx;
  const stageRunId = newStageRunId();
  t.insertStageRun({
    stageRunId,
    runId: run.runId,
    stage: stageId,
    attempt: t.maxAttempt(run.runId, stageId) + 1,
    visit,
    retryIndex,
    state: "submitted",
    tokenHash: null,
    adapterRunId: null,
    sessionKey: null,
    turnsUsed: 0,
    dispatchSeq: 0,
    deadlineAt: null,
    createdAt: now,
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
  });
  t.appendTransition({
    runId: run.runId,
    stageRunId,
    fromState: null,
    toState: "submitted",
    event: "stage_submitted",
    outcome: null,
    actor,
    at: now,
    detail: null,
  });
  moveRun(t, run, { currentStage: stageId, updatedAt: now });
  ctx.emit("stage_changed", {
    runId: run.runId,
    stageRunId,
    stage: stageId,
    from: null,
    to: "submitted",
  });
}

export function endRun(
  ctx: RunCtx,
  stageId: string,
  status: RunStatus,
  actor: string,
  event = "run_ended",
  detail: unknown = { stage: stageId },
): void {
  const { t, run, now } = ctx;
  moveRun(t, run, {
    status,
    currentStage: stageId,
    updatedAt: now,
    endedAt: now,
  });
  t.appendTransition({
    runId: run.runId,
    stageRunId: null,
    fromState: run.status,
    toState: status,
    event,
    outcome: null,
    actor,
    at: now,
    detail,
  });
  ctx.emit("run_ended", { runId: run.runId, status, stage: stageId });
}

/** Ends the run `failed` where it stands, with `event` saying why. */
export function failRun(
  ctx: RunCtx,
  event: string,
  actor: string,
  detail: Record<string, unknown>,
): void {
  const current = ctx.t.getRun(ctx.run.runId) ?? ctx.run;
  endRun(ctx, current.currentStage, "failed", actor, event, detail);
}

/** Compare-and-set on the run; it cannot lose inside the transaction that read it. */
export function moveRun(t: StoreTx, run: RunRow, patch: RunPatch): void {
  const current = t.getRun(run.runId);
  if (!current || current.status !== run.status) {
    throw new Error(`run ${run.runId} changed state during the transaction`);
  }
  const ok = t.updateRunIf(
    run.runId,
    { status: current.status, currentStage: current.currentStage },
    patch,
  );
  if (!ok) throw new Error(`run ${run.runId} could not be updated`);
}
