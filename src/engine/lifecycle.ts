import type { StageRunRow, StageRunState } from "../store/types.js";

/**
 * Legal moves of a stage run. A retry is a new row, so the old row ends
 * `failed` and the new one starts `submitted`; no edge here models a retry.
 *
 * - submitted -> working: the first turn was dispatched, or a wait or a
 *   poll gate began (the engine itself is waiting or polling).
 * - submitted -> input_required: an operator gate began waiting on a person.
 * - submitted -> completed | failed: a check or action finished, or an agent
 *   ended before any turn ran (for example, no agent was available).
 * - submitted -> canceled | rejected: the run was canceled, or the stage was
 *   refused because it can never run (a brief that cannot be rendered, a host
 *   function that is not registered).
 * - working -> working: a continuation turn on the same row.
 * - working -> submitted: the row is dispatched again, after a usage-limit
 *   pause or a continuation that waits for admission.
 * - working -> completed | failed | canceled: the agent finished, the attempt
 *   ended, the wait elapsed, the poll gate passed or timed out, or the run
 *   was canceled.
 * - input_required -> completed | failed | canceled: the gate was resolved,
 *   timed out, or the run was canceled.
 */
export const STAGE_RUN_TRANSITIONS: Record<StageRunState, StageRunState[]> = {
  submitted: [
    "working",
    "input_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
  ],
  working: ["working", "completed", "failed", "canceled", "submitted"],
  input_required: ["completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: StageRunState,
    readonly to: StageRunState,
  ) {
    super(`illegal stage run transition ${from} -> ${to}`);
    this.name = "IllegalTransition";
  }
}

/**
 * True when the attempt's deadline has passed. A stage run a pause is
 * holding is not running down its deadline, which moves on release.
 */
export function deadlinePassed(row: StageRunRow, now: number): boolean {
  return (
    row.deadlineAt !== null && row.heldSince === null && now >= row.deadlineAt
  );
}

export function assertTransition(from: StageRunState, to: StageRunState): void {
  if (!STAGE_RUN_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransition(from, to);
  }
}
