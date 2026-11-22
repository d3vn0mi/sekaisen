import { edgeId, edgesOf } from "../checks/edges.js";
import type { Definition } from "../format/types.js";
import type { TransitionRow } from "../store/types.js";

/**
 * One transition of a simulated run, in the shape the conformance suite
 * compares: no times and no ids but `seq`. `run_stage` is the stage id, or
 * `run` for a transition of the run itself.
 */
export interface TransitionLogLine {
  seq: number;
  run_stage: string;
  from: string | null;
  to: string;
  event: string;
  outcome?: string;
  actor: string;
}

/** Edge ids (`<stage>.<outcome>[<branch>]`) in definition order. */
export interface Coverage {
  taken: string[];
  untaken: string[];
}

export function logLine(
  seq: number,
  row: TransitionRow,
  stage: string | undefined,
): TransitionLogLine {
  return {
    seq,
    run_stage: stage ?? "run",
    from: row.fromState,
    to: row.toState,
    event: row.event,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    actor: row.actor,
  };
}

/** The declared edge a transition followed, if it followed one. */
export function edgeOf(row: TransitionRow, stage: string): string | undefined {
  const detail = (row.detail ?? {}) as {
    branch?: unknown;
    exhausted?: unknown;
  };
  let label: string | undefined;
  switch (row.event) {
    case "stage_completed":
      // An action completes with no outcome; its one edge is `next`.
      label = row.outcome ?? "next";
      break;
    case "gate_resolved":
    case "gate_passed":
      label = row.outcome ?? undefined;
      break;
    case "wait_elapsed":
      label = "next";
      break;
    case "gate_timeout":
      label = "on_timeout";
      break;
    default:
      if (detail.exhausted === true) label = "on_exhausted";
  }
  if (label === undefined) return undefined;
  const branch = typeof detail.branch === "number" ? `[${detail.branch}]` : "";
  return `${stage}.${label}${branch}`;
}

/** Every edge id of `def` but the definition's `onCancel`, in definition order. */
export function edgeIds(def: Definition): string[] {
  return edgesOf(def)
    .filter((e) => e.from !== "*")
    .map(edgeId);
}

/** Splits the definition's edges into those `taken` holds and the rest. */
export function splitEdges(def: Definition, taken: Set<string>): Coverage {
  const ids = edgeIds(def);
  return {
    taken: ids.filter((id) => taken.has(id)),
    untaken: ids.filter((id) => !taken.has(id)),
  };
}

/** The declared edges a run's transitions followed, and those it did not. */
export function coverage(
  def: Definition,
  rows: TransitionRow[],
  stageOf: (row: TransitionRow) => string | undefined,
): Coverage {
  const seen = new Set<string>();
  for (const row of rows) {
    const stage = stageOf(row);
    const id = stage === undefined ? undefined : edgeOf(row, stage);
    if (id !== undefined) seen.add(id);
  }
  return splitEdges(def, seen);
}
