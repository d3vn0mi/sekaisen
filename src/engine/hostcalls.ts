import type { Definition } from "../format/types.js";
import type {
  ActionFn,
  CheckFn,
  FactFn,
  HostRegistry,
  StageCtx,
} from "../host/registry.js";
import type { StageRunRow, StoreTx } from "../store/types.js";
import { ENGINE_ACTOR, failRun, type RunCtx } from "./advance.js";
import type { BriefOutcomes, TextData } from "./brief.js";
import { CallTimeout } from "./calls.js";
import { append, move, transition } from "./endings.js";
import type { TxCtx } from "./turns.js";
import { clip, descend, errorMessage, isPlainObject } from "./values.js";

/**
 * What the stages the tick runs itself share: the host functions they call,
 * the context those functions see, and how a stage run that can never make
 * progress is refused.
 */

/** A tick transaction for the stages the tick runs itself. */
export interface StageTickCtx extends TxCtx {
  registry: HostRegistry;
}

/**
 * A host function to call for a stage run, outside any transaction. `row`
 * is the stage run as it was when the call was prepared; the result is
 * recorded only if the stage run is still there.
 */
export type HostCall =
  | {
      kind: "check";
      row: StageRunRow;
      name: string;
      fn: CheckFn;
      ctx: StageCtx;
    }
  | {
      kind: "action";
      row: StageRunRow;
      name: string;
      fn: ActionFn;
      ctx: StageCtx & { idempotencyKey: string };
      /** The definition's cancel action, run once on a canceled run. */
      cancel: boolean;
    }
  | { kind: "fact"; row: StageRunRow; name: string; fn: FactFn; ctx: StageCtx };

/** Calls the host function; the caller bounds it with its call timeout. */
export function invoke(call: HostCall): Promise<unknown> {
  switch (call.kind) {
    case "check":
      return call.fn(call.ctx);
    case "action":
      return call.fn(call.ctx);
    case "fact":
      return call.fn(call.ctx);
  }
}

/** The ending of a host call that failed: `timeout` past the call timeout, else `turn_error`. */
export function callEnding(err: unknown): "timeout" | "turn_error" {
  return err instanceof CallTimeout ? "timeout" : "turn_error";
}

/** The detail a failed host call leaves in its transition. */
export function callError(
  call: HostCall,
  err: unknown,
): Record<string, unknown> {
  return { [call.kind]: call.name, error: clip(errorMessage(err)) };
}

/** The fields each stage of the run last completed with, by stage id. */
export function stageFields(
  t: StoreTx,
  runId: string,
  def: Definition,
): Record<string, Record<string, unknown>> {
  const stages: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(def.stages)) {
    const done = t.latestCompleted(runId, id);
    if (done && isPlainObject(done.fields)) stages[id] = done.fields;
  }
  return stages;
}

/** What a placeholder in a gate prompt or a wait's `until` can read. */
export function textData(ctx: RunCtx, outcomes: BriefOutcomes = {}): TextData {
  return {
    inputs: ctx.run.inputs,
    runId: ctx.run.runId,
    stages: stageFields(ctx.t, ctx.run.runId, ctx.pinned.def),
    outcomes,
  };
}

/**
 * The context a host function sees. Fields are read when the call is
 * prepared, so the function sees one consistent picture of the run.
 */
export function stageCtx(ctx: RunCtx, row: StageRunRow): StageCtx {
  const fields = stageFields(ctx.t, row.runId, ctx.pinned.def);
  return {
    runId: ctx.run.runId,
    stage: row.stage,
    inputs: structuredClone(ctx.run.inputs),
    field: (stage, name) =>
      Object.hasOwn(fields, stage) ? descend(fields[stage], name) : undefined,
    now: ctx.now,
  };
}

/**
 * Refuses a stage run that can never make progress (a brief missing from the
 * definition, a host function that is not registered), with a transition
 * saying why, and fails a run still waiting on it. Without this the row would
 * stay submitted and be tried again on every tick.
 */
export function rejectStageRun(
  ctx: RunCtx,
  row: StageRunRow,
  reason: string,
): void {
  move(ctx, row, "rejected", {
    state: "rejected",
    endedAt: ctx.now,
    dispatchedAt: null,
    waitReason: null,
    wakeAt: null,
  });
  append(ctx, transition(row, "rejected", "stage_rejected"), { reason });
  const run = ctx.t.getRun(ctx.run.runId);
  if (run?.status === "working" || run?.status === "input_required") {
    failRun({ ...ctx, run }, "stage_rejected", ENGINE_ACTOR, {
      stage: row.stage,
      reason,
    });
  }
}

/** Records that a host call's result arrived after its stage run moved on, and drops it. */
export function dropResult(c: TxCtx, call: HostCall, why: string): void {
  const row = c.t.getStageRun(call.row.stageRunId);
  if (!row) return;
  c.t.appendTransition({
    runId: row.runId,
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: row.state,
    event: "host_result_dropped",
    outcome: null,
    actor: ENGINE_ACTOR,
    at: c.now,
    detail: { [call.kind]: call.name, reason: why },
  });
}
