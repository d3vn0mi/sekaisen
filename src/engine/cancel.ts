import { endRun, newAttempt, type RunCtx } from "./advance.js";
import { append, move, transition } from "./endings.js";
import {
  type AbortRequest,
  abortRequest,
  logAbort,
  type TxCtx,
} from "./turns.js";

/**
 * Cancels a run, as one transaction: the live stage run and the run move to
 * `canceled`, an open gate is resolved by `canceled:<actor>`, and the
 * definition's `onCancel` action, when it names one, is submitted to run
 * once. The live stage run keeps its token hash, so a later completion is
 * recognised and refused (and logged). Returns the harness turn to abort
 * when one was in flight.
 *
 * The cancel action is a stage run of that action stage with the fixed
 * idempotency key `${runId}:cancel` instead of one derived from its
 * attempt. The key is unique, so the action is submitted once per run, and
 * a crash before it runs leaves it for the tick to run under the same key.
 * It is the one stage run the tick runs on a canceled run; it never retries
 * and never moves the run on.
 */
export function cancelRun(
  c: TxCtx,
  runId: string,
  actor: string,
): AbortRequest | undefined {
  if (typeof actor !== "string" || actor === "") {
    throw new Error("cancel needs who canceled the run");
  }
  const run = c.t.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  if (run.status !== "working" && run.status !== "input_required") {
    throw new Error(`run ${runId} already ended (${run.status})`);
  }
  const pinned = c.pinned.of(c.t, run);
  const ctx: RunCtx = { t: c.t, pinned, run, now: c.now, emit: c.emit };
  let abort: AbortRequest | undefined;
  const live = c.t.liveStageRun(runId);
  if (live) {
    if (
      live.state === "working" &&
      live.dispatchedAt !== null &&
      live.adapterRunId !== null
    ) {
      abort = { stageRunId: live.stageRunId, adapterRunId: live.adapterRunId };
    }
    move(ctx, live, "canceled", {
      state: "canceled",
      endedAt: c.now,
      dispatchedAt: null,
      waitReason: null,
      wakeAt: null,
      ...(abort === undefined ? {} : abortRequest(abort.adapterRunId, c.now)),
    });
    append(
      ctx,
      transition(live, "canceled", "stage_canceled", actor),
      abort === undefined ? {} : { adapterRunId: abort.adapterRunId },
    );
    if (abort !== undefined) {
      logAbort(
        c.t,
        { ...live, state: "canceled" },
        "abort_requested",
        actor,
        c.now,
        { adapterRunId: abort.adapterRunId },
      );
    }
    const gate = c.t.getGate(live.stageRunId);
    if (gate && gate.resolvedBy === null) {
      c.t.upsertGate({
        ...gate,
        resolvedBy: `canceled:${actor}`,
        resolvedAt: c.now,
        pollAt: null,
      });
    }
  }
  endRun(ctx, run.currentStage, "canceled", actor, "run_canceled");

  const target = pinned.def.onCancel;
  if (target === undefined) return abort;
  if (pinned.def.stages[target]?.type !== "action") {
    c.t.appendTransition({
      runId,
      stageRunId: null,
      fromState: "canceled",
      toState: "canceled",
      event: "cancel_action_skipped",
      outcome: null,
      actor,
      at: c.now,
      detail: { stage: target, reason: "onCancel does not name an action" },
    });
    return abort;
  }
  const row = newAttempt(ctx, target, c.t.countVisits(runId, target) + 1, 0);
  c.t.insertStageRun(row, { cancelAction: true });
  c.t.appendTransition({
    runId,
    stageRunId: row.stageRunId,
    fromState: null,
    toState: "submitted",
    event: "stage_submitted",
    outcome: null,
    actor,
    at: c.now,
    detail: { onCancel: true },
  });
  c.emit("stage_changed", {
    runId,
    stageRunId: row.stageRunId,
    stage: target,
    from: null,
    to: "submitted",
  });
  return abort;
}
