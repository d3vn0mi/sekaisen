import type { GateStage } from "../format/types.js";
import type { GateRow, StageRunRow } from "../store/types.js";
import {
  advance,
  ENGINE_ACTOR,
  enter,
  type RunCtx,
  withRunStatus,
} from "./advance.js";
import { renderText } from "./brief.js";
import { MAX_NOTE_BYTES } from "./completion.js";
import { append, move, transition } from "./endings.js";
import {
  type HostCall,
  rejectStageRun,
  type StageTickCtx,
  stageCtx,
  textData,
} from "./hostcalls.js";
import type { TxCtx } from "./turns.js";
import { clip, errorMessage } from "./values.js";

/**
 * Gates, each function the body of one transaction. An operator gate moves
 * its stage run to `input_required` and the run with it; a poll gate's stage
 * run is `working` while the tick polls its fact, and the run stays
 * `working`. The `gates` row holds what the wait needs across restarts: the
 * prompt, the outcomes, the next reminder and poll, and who resolved it.
 *
 * The timeout counts from when the gate was entered. With `onTimeout.next`
 * the gate takes that edge once it passes; with `onTimeout.remind` the first
 * reminder is due when it passes and the next ones every `remind` after.
 */

/** Longest a poll waits after its fact keeps throwing, as a multiple of `every`. */
export const MAX_POLL_BACKOFF = 8;

/**
 * One due gate: opens it on first sight, then takes its timeout edge, sends
 * a reminder, or returns the fact to poll.
 */
export function stepGate(
  c: StageTickCtx,
  ctx: RunCtx,
  seen: StageRunRow,
  stage: GateStage,
): HostCall | undefined {
  let row = seen;
  let rctx = ctx;
  if (row.state === "submitted") {
    const fact = stage.poll && c.registry.facts.get(stage.poll.fact);
    if (stage.poll && !fact) {
      rejectStageRun(ctx, row, `fact ${stage.poll.fact} is not registered`);
      return undefined;
    }
    ({ row, ctx: rctx } = openGate(ctx, row, stage));
  }
  let gate = c.t.getGate(row.stageRunId);
  if (!gate || gate.resolvedBy !== null) {
    stopWaking(ctx, row);
    return undefined;
  }
  const timeoutAt = timeoutOf(row, stage);
  if ("next" in stage.onTimeout && c.now >= timeoutAt) {
    timeOut(rctx, row, gate, stage.onTimeout.next, timeoutAt);
    return undefined;
  }
  if (gate.remindAt !== null && c.now >= gate.remindAt) {
    gate = remind(rctx, row, gate, stage);
  }
  if (stage.poll && gate.pollAt !== null && c.now >= gate.pollAt) {
    const fn = c.registry.facts.get(stage.poll.fact);
    if (!fn) {
      rejectStageRun(rctx, row, `fact ${stage.poll.fact} is not registered`);
      return undefined;
    }
    return {
      kind: "fact",
      row,
      name: stage.poll.fact,
      fn,
      ctx: stageCtx(rctx, row),
    };
  }
  reschedule(rctx, row, gate, stage);
  return undefined;
}

/** A poll's answer: true passes the gate with its one outcome, false polls again after `every`. */
export function recordFact(
  ctx: RunCtx,
  row: StageRunRow,
  gate: GateRow,
  stage: GateStage,
  fact: string,
  value: unknown,
): void {
  const every = stage.poll?.every ?? 0;
  if (value !== true) {
    const next = { ...gate, pollAt: ctx.now + every, pollFailures: 0 };
    ctx.t.upsertGate(next);
    reschedule(ctx, row, next, stage);
    return;
  }
  const outcome = Object.keys(stage.outcomes)[0];
  if (outcome === undefined) {
    rejectStageRun(ctx, row, `poll gate ${row.stage} declares no outcome`);
    return;
  }
  move(ctx, row, "completed", {
    state: "completed",
    outcome,
    endedAt: ctx.now,
    wakeAt: null,
  });
  ctx.t.upsertGate({
    ...gate,
    resolvedBy: `fact:${fact}`,
    resolvedAt: ctx.now,
    pollAt: null,
  });
  advance(ctx, row, outcome, {
    stageRunId: row.stageRunId,
    fromState: row.state,
    toState: "completed",
    event: "gate_passed",
    outcome,
    actor: `fact:${fact}`,
    detail: {},
  });
}

/**
 * A poll whose fact threw: the next poll backs off, doubling up to
 * `MAX_POLL_BACKOFF` times `every`. A `poll_error` transition is written for
 * the first failure in a row and whenever the error text changes, so a fact
 * that keeps failing the same way does not flood the log.
 */
export function recordFactError(
  ctx: RunCtx,
  row: StageRunRow,
  gate: GateRow,
  stage: GateStage,
  fact: string,
  err: unknown,
): void {
  const every = stage.poll?.every ?? 0;
  const failures = gate.pollFailures + 1;
  const delay = every * Math.min(2 ** failures, MAX_POLL_BACKOFF);
  const error = clip(errorMessage(err));
  const next = {
    ...gate,
    pollAt: ctx.now + delay,
    pollFailures: failures,
    pollError: error,
  };
  ctx.t.upsertGate(next);
  if (failures === 1 || error !== gate.pollError) {
    append(ctx, transition(row, row.state, "poll_error"), {
      fact,
      error,
      failures,
      nextPollAt: next.pollAt,
    });
  }
  reschedule(ctx, row, next, stage);
}

/**
 * An operator's answer to a gate. Throws when the stage run is not an open
 * operator gate or the outcome is not one it declares.
 */
export function resolveGate(
  c: TxCtx,
  stageRunId: string,
  outcome: string,
  by: string,
  note: string | undefined,
): string | null {
  if (typeof by !== "string" || by === "") {
    throw new Error("resolveGate needs who resolved the gate");
  }
  if (note !== undefined && Buffer.byteLength(note) > MAX_NOTE_BYTES) {
    throw new Error("note is larger than 64 KiB; shorten it");
  }
  const row = c.t.getStageRun(stageRunId);
  if (!row) throw new Error(`unknown stage run ${stageRunId}`);
  const gate = c.t.getGate(stageRunId);
  if (!gate)
    throw new Error(`stage run ${stageRunId} is not waiting on a gate`);
  if (gate.resolvedBy !== null) {
    throw new Error(`gate already resolved by ${gate.resolvedBy}`);
  }
  if (gate.kind !== "operator") {
    throw new Error(
      `stage run ${stageRunId} is a poll gate; it passes when its fact holds`,
    );
  }
  const run = c.t.getRun(row.runId);
  const pinned = run && c.pinned.of(c.t, run);
  const stage = pinned?.def.stages[row.stage];
  if (!run || !pinned || stage?.type !== "gate") {
    throw new Error(`stage run ${stageRunId} is not waiting on a gate`);
  }
  if (row.state !== "input_required" || run.status !== "input_required") {
    throw new Error(
      `stage run ${stageRunId} is not waiting on the operator (${row.state})`,
    );
  }
  if (!Object.hasOwn(stage.outcomes, outcome)) {
    throw new Error(
      `unknown outcome "${outcome}" for gate ${row.stage}; declared outcomes: ${Object.keys(stage.outcomes).join(", ")}`,
    );
  }
  const ctx: RunCtx = { t: c.t, pinned, run, now: c.now, emit: c.emit };
  move(ctx, row, "completed", {
    state: "completed",
    outcome,
    endedAt: c.now,
    wakeAt: null,
  });
  c.t.upsertGate({ ...gate, resolvedBy: by, resolvedAt: c.now });
  return advance(withRunStatus(ctx, "working"), row, outcome, {
    stageRunId,
    fromState: row.state,
    toState: "completed",
    event: "gate_resolved",
    outcome,
    actor: by,
    detail: note === undefined ? {} : { note },
  });
}

function openGate(
  ctx: RunCtx,
  row: StageRunRow,
  stage: GateStage,
): { row: StageRunRow; ctx: RunCtx } {
  const operator = stage.poll === undefined;
  const to = operator ? "input_required" : "working";
  const timeoutAt = timeoutOf(row, stage);
  const outcomes = Object.keys(stage.outcomes);
  const prompt =
    stage.prompt === undefined
      ? null
      : renderText(stage.prompt, textData(ctx, stage.outcomes));
  const gate: GateRow = {
    stageRunId: row.stageRunId,
    kind: operator ? "operator" : "poll",
    waitingOn: operator ? "operator" : `fact:${stage.poll?.fact}`,
    remindAt: "remind" in stage.onTimeout ? timeoutAt : null,
    resolvedBy: null,
    resolvedAt: null,
    prompt,
    outcomes,
    pollAt: operator ? null : ctx.now,
    pollFailures: 0,
    pollError: null,
  };
  const patch = {
    state: to,
    startedAt: ctx.now,
    deadlineAt: timeoutAt,
    wakeAt: nextWake(gate, stage, timeoutAt),
  } as const;
  move(ctx, row, to, patch);
  ctx.t.upsertGate(gate);
  append(ctx, transition(row, to, "gate_opened"), {
    kind: gate.kind,
    timeoutAt,
  });
  const opened = { ...row, ...patch };
  if (!operator) return { row: opened, ctx };
  const rctx = withRunStatus(ctx, "input_required");
  // A gate first seen at or past its timeout is not announced here: it
  // takes its timeout edge, or its first reminder announces it, in the same
  // transaction.
  if (ctx.now < timeoutAt) emitGate(rctx, opened, gate);
  return { row: opened, ctx: rctx };
}

function timeOut(
  ctx: RunCtx,
  row: StageRunRow,
  gate: GateRow,
  next: string,
  timeoutAt: number,
): void {
  move(ctx, row, "failed", {
    state: "failed",
    ending: "timeout",
    endedAt: ctx.now,
    wakeAt: null,
  });
  ctx.t.upsertGate({
    ...gate,
    resolvedBy: "timeout",
    resolvedAt: ctx.now,
    pollAt: null,
  });
  const rctx = withRunStatus(ctx, "working");
  append(rctx, transition(row, "failed", "gate_timeout"), { timeoutAt, next });
  enter(rctx, next, ENGINE_ACTOR);
}

/**
 * Writes a `gate_reminder` transition and schedules the next one. An
 * operator gate also emits its `gate` event again; a poll gate has nobody
 * to remind, so the transition is the whole reminder.
 */
function remind(
  ctx: RunCtx,
  row: StageRunRow,
  gate: GateRow,
  stage: GateStage,
): GateRow {
  const every =
    "remind" in stage.onTimeout
      ? (stage.onTimeout.remind ?? stage.timeout)
      : stage.timeout;
  const next = { ...gate, remindAt: ctx.now + every };
  ctx.t.upsertGate(next);
  append(ctx, transition(row, row.state, "gate_reminder"), {
    nextReminderAt: next.remindAt,
  });
  if (gate.kind === "operator") emitGate(ctx, row, next);
  return next;
}

/** Sets the stage run to wake for the gate's next poll, reminder or timeout. */
function reschedule(
  ctx: RunCtx,
  row: StageRunRow,
  gate: GateRow,
  stage: GateStage,
): void {
  const wakeAt = nextWake(gate, stage, timeoutOf(row, stage));
  if (wakeAt === row.wakeAt) return;
  ctx.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { wakeAt },
  );
}

function stopWaking(ctx: RunCtx, row: StageRunRow): void {
  ctx.t.updateStageRunIf(
    row.stageRunId,
    { state: row.state, attempt: row.attempt },
    { wakeAt: null },
  );
}

function nextWake(
  gate: GateRow,
  stage: GateStage,
  timeoutAt: number,
): number | null {
  const times = [gate.pollAt, gate.remindAt];
  if ("next" in stage.onTimeout) times.push(timeoutAt);
  const due = times.filter((x): x is number => x !== null);
  return due.length === 0 ? null : Math.min(...due);
}

/** When the gate times out: its timeout after it was entered. */
function timeoutOf(row: StageRunRow, stage: GateStage): number {
  return row.deadlineAt ?? row.createdAt + stage.timeout;
}

function emitGate(ctx: RunCtx, row: StageRunRow, gate: GateRow): void {
  ctx.emit("gate", {
    runId: row.runId,
    stageRunId: row.stageRunId,
    stage: row.stage,
    prompt: gate.prompt,
    outcomes: gate.outcomes ?? [],
  });
}
