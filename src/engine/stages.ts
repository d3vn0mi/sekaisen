import type { ActionStage, CheckStage, WaitStage } from "../format/types.js";
import type { StageRunRow } from "../store/types.js";
import { advance, ENGINE_ACTOR, type RunCtx } from "./advance.js";
import { renderText } from "./brief.js";
import {
  append,
  endAttempt,
  move,
  NO_RETRY,
  policyOf,
  transition,
} from "./endings.js";
import { recordFact, recordFactError, stepGate } from "./gates.js";
import {
  callEnding,
  callError,
  dropResult,
  type HostCall,
  rejectStageRun,
  type StageTickCtx,
  stageCtx,
  textData,
} from "./hostcalls.js";
import type { TxCtx } from "./turns.js";

/**
 * The stages the tick runs itself (check, action, wait, gate), each function
 * the body of one transaction. A stage run is picked up once its `wakeAt`
 * is due. A host function is called between two transactions: one prepares the
 * call, the next records its result if the stage run is still where it was.
 * None of this goes through agent dispatch or counts against its lanes.
 */

const LIVE = ["submitted", "working", "input_required"];

/** The key of the definition's cancel action on `runId`. */
export function cancelKey(runId: string): string {
  return `${runId}:cancel`;
}

/**
 * One due stage run: does what needs no host call, or returns the call to
 * make. Undefined when there is nothing to call.
 */
export function stepStage(
  c: StageTickCtx,
  seen: StageRunRow,
): HostCall | undefined {
  const row = c.t.getStageRun(seen.stageRunId);
  if (!row || row.attempt !== seen.attempt || !LIVE.includes(row.state)) {
    return undefined;
  }
  if (row.wakeAt === null || row.wakeAt > c.now) return undefined;
  const run = c.t.getRun(row.runId);
  if (!run) return undefined;
  const pinned = c.pinned.of(c.t, run);
  const ctx: RunCtx = { t: c.t, pinned, run, now: c.now, emit: c.emit };
  const stage = pinned.def.stages[row.stage];
  const cancel = row.idempotencyKey === cancelKey(run.runId);
  if (cancel) {
    if (stage?.type !== "action") {
      rejectStageRun(ctx, row, `cancel stage ${row.stage} is not an action`);
      return undefined;
    }
    return actionCall(c, ctx, row, stage, true);
  }
  if (run.status !== "working" && run.status !== "input_required") {
    // The run ended under a live stage run (the engine never leaves one so);
    // end it rather than leave it live with nothing to wake it.
    move(ctx, row, "canceled", {
      state: "canceled",
      endedAt: c.now,
      waitReason: null,
      wakeAt: null,
    });
    append(ctx, transition(row, "canceled", "orphaned_stage_run"), {
      run: run.status,
    });
    return undefined;
  }
  switch (stage?.type) {
    case "check":
      return checkCall(c, ctx, row, stage);
    case "action":
      return actionCall(c, ctx, row, stage, false);
    case "wait":
      stepWait(ctx, row, stage);
      return undefined;
    case "gate":
      return stepGate(c, ctx, row, stage);
    default:
      rejectStageRun(
        ctx,
        row,
        `stage ${row.stage} is not one the tick runs (${stage?.type ?? "missing"})`,
      );
      return undefined;
  }
}

/** Records what a host call returned. */
export function recordCallResult(
  c: TxCtx,
  call: HostCall,
  value: unknown,
): void {
  const found = current(c, call);
  if (!found) return;
  const { row, ctx } = found;
  switch (call.kind) {
    case "check": {
      const stage = ctx.pinned.def.stages[row.stage] as CheckStage;
      if (typeof value !== "string" || !Object.hasOwn(stage.outcomes, value)) {
        endAttempt(
          ctx,
          row,
          { retry: NO_RETRY },
          null,
          {},
          {
            check: call.name,
            returned: typeof value === "string" ? value : String(value),
            declared: Object.keys(stage.outcomes),
          },
          "check_invalid_outcome",
        );
        return;
      }
      complete(ctx, row, value, `check:${call.name}`);
      return;
    }
    case "action":
      if (call.cancel) {
        endCancelAction(ctx, row, call, "completed", {});
        return;
      }
      complete(ctx, row, "next", `action:${call.name}`);
      return;
    case "fact": {
      const g = gateOf(c, call);
      if (g) recordFact(ctx, row, g.gate, g.stage, call.name, value);
      return;
    }
  }
}

/** Records a host call that threw or ran past the call timeout. */
export function recordCallError(c: TxCtx, call: HostCall, err: unknown): void {
  const found = current(c, call);
  if (!found) return;
  const { row, ctx } = found;
  const detail = callError(call, err);
  switch (call.kind) {
    case "check":
    case "action": {
      if (call.kind === "action" && call.cancel) {
        endCancelAction(ctx, row, call, "failed", detail, callEnding(err));
        return;
      }
      const stage = ctx.pinned.def.stages[row.stage];
      if (!stage) return;
      endAttempt(ctx, row, policyOf(stage), callEnding(err), {}, detail);
      return;
    }
    case "fact": {
      const g = gateOf(c, call);
      if (g) recordFactError(ctx, row, g.gate, g.stage, call.name, err);
      return;
    }
  }
}

function checkCall(
  c: StageTickCtx,
  ctx: RunCtx,
  row: StageRunRow,
  stage: CheckStage,
): HostCall | undefined {
  const fn = c.registry.checks.get(stage.check);
  if (!fn) {
    rejectStageRun(ctx, row, `check ${stage.check} is not registered`);
    return undefined;
  }
  return { kind: "check", row, name: stage.check, fn, ctx: stageCtx(ctx, row) };
}

function actionCall(
  c: StageTickCtx,
  ctx: RunCtx,
  row: StageRunRow,
  stage: ActionStage,
  cancel: boolean,
): HostCall | undefined {
  const fn = c.registry.actions.get(stage.action);
  if (!fn) {
    rejectStageRun(ctx, row, `action ${stage.action} is not registered`);
    return undefined;
  }
  return {
    kind: "action",
    row,
    name: stage.action,
    fn,
    ctx: { ...stageCtx(ctx, row), idempotencyKey: row.idempotencyKey },
    cancel,
  };
}

/**
 * A wait: on first sight its wake time is fixed (`for` after it was
 * entered, or `until` rendered and read as an ISO 8601 instant) and the
 * stage run moves to `working`; once that time comes it takes `next`.
 */
function stepWait(ctx: RunCtx, seen: StageRunRow, stage: WaitStage): void {
  let row = seen;
  if (row.state === "submitted") {
    const wake = wakeTime(ctx, row, stage);
    if ("error" in wake) {
      endAttempt(
        ctx,
        row,
        { retry: NO_RETRY },
        null,
        {},
        wake,
        "wait_invalid_until",
      );
      return;
    }
    const patch = {
      state: "working",
      startedAt: ctx.now,
      wakeAt: wake.at,
    } as const;
    move(ctx, row, "working", patch);
    append(ctx, transition(row, "working", "wait_started"), {
      until: wake.at,
    });
    row = { ...row, ...patch };
    if (wake.at > ctx.now) return;
  }
  if (row.state !== "working") return;
  move(ctx, row, "completed", {
    state: "completed",
    endedAt: ctx.now,
    wakeAt: null,
  });
  advance(ctx, row, "next", {
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: "completed",
    event: "wait_elapsed",
    outcome: null,
    actor: ENGINE_ACTOR,
    detail: {},
  });
}

/** A full ISO 8601 date and time with a UTC offset, so it means one instant. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function wakeTime(
  ctx: RunCtx,
  row: StageRunRow,
  stage: WaitStage,
):
  | { at: number }
  | { error: string; until?: string | undefined; rendered?: string } {
  if (stage.for !== undefined) return { at: row.createdAt + stage.for };
  if (stage.until === undefined) {
    return { error: "the wait has neither for nor until" };
  }
  const rendered = renderText(stage.until, textData(ctx)).trim();
  const at = ISO_INSTANT.test(rendered) ? Date.parse(rendered) : Number.NaN;
  if (!Number.isFinite(at)) {
    return {
      error: "until is not an ISO 8601 date and time with a UTC offset",
      until: stage.until,
      rendered,
    };
  }
  return { at };
}

function complete(
  ctx: RunCtx,
  row: StageRunRow,
  outcome: string,
  actor: string,
): void {
  // An action has no outcomes; its one edge is `next`.
  const recorded = outcome === "next" ? null : outcome;
  move(ctx, row, "completed", {
    state: "completed",
    outcome: recorded,
    startedAt: row.startedAt ?? ctx.now,
    endedAt: ctx.now,
    wakeAt: null,
  });
  advance(ctx, row, outcome, {
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: "completed",
    event: "stage_completed",
    outcome: recorded,
    actor,
    detail: {},
  });
}

/** The cancel action ran once; it never retries and the run does not move on. */
function endCancelAction(
  ctx: RunCtx,
  row: StageRunRow,
  call: HostCall,
  to: "completed" | "failed",
  detail: Record<string, unknown>,
  ending?: "timeout" | "turn_error",
): void {
  move(ctx, row, to, {
    state: to,
    ...(ending === undefined ? {} : { ending }),
    startedAt: row.startedAt ?? ctx.now,
    endedAt: ctx.now,
    wakeAt: null,
  });
  append(
    ctx,
    transition(
      row,
      to,
      to === "completed" ? "cancel_action_completed" : "cancel_action_failed",
    ),
    { action: call.name, ...detail },
  );
}

/** The stage run of `call` if it is still as the call found it. */
function current(
  c: TxCtx,
  call: HostCall,
): { row: StageRunRow; ctx: RunCtx } | undefined {
  const row = c.t.getStageRun(call.row.stageRunId);
  if (!row) return undefined;
  if (row.attempt !== call.row.attempt || row.state !== call.row.state) {
    dropResult(c, call, `the stage run is now ${row.state}`);
    return undefined;
  }
  const run = c.t.getRun(row.runId);
  if (!run) return undefined;
  const live = run.status === "working" || run.status === "input_required";
  if (!live && !(call.kind === "action" && call.cancel)) {
    dropResult(c, call, `the run is ${run.status}`);
    return undefined;
  }
  const pinned = c.pinned.of(c.t, run);
  return { row, ctx: { t: c.t, pinned, run, now: c.now, emit: c.emit } };
}

function gateOf(c: TxCtx, call: HostCall) {
  const row = c.t.getStageRun(call.row.stageRunId);
  const run = row && c.t.getRun(row.runId);
  const stage = run && row && c.pinned.of(c.t, run).def.stages[row.stage];
  const gate = row && c.t.getGate(row.stageRunId);
  if (stage?.type !== "gate" || !gate || gate.resolvedBy !== null) {
    dropResult(c, call, "the gate is no longer open");
    return undefined;
  }
  return { gate, stage };
}
