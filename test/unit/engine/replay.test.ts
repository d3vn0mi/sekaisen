import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadDefinition } from "../../../src/format/load.js";
import type { Definition, RetryEnding } from "../../../src/format/types.js";
import { explore } from "../../../src/simulate/explore.js";
import { parseScript } from "../../../src/simulate/script.js";
import { simulate } from "../../../src/simulate/simulate.js";
import type {
  RunRow,
  StageRunRow,
  Store,
  TransitionRow,
} from "../../../src/store/types.js";

/**
 * The transition log is the run's history: folding a run's `transitions`
 * rows, oldest first, with the definition the run was pinned to, rebuilds
 * what the store says the run and each of its stage runs ended up as.
 *
 * The fold reads only what a log line carries (the stage run, from, to,
 * event and outcome) and rebuilds what the log is meant to determine: the
 * run's status and current stage, and for each stage run its state, outcome,
 * ending, attempt, visit and retry index. Bookkeeping that is not a state
 * (dispatch sequence, deadlines, wake times, turn counts, checkpoint notes,
 * fields) is not in the log and is left out. A stage run's stage id is fixed
 * when it is created and every log line carries it as `run_stage`; the fold
 * reads it from the stored row.
 *
 * Events that leave every state as it was (progress, turn_ended, reminders,
 * aborts, refusals) change nothing the fold rebuilds: that they are written,
 * and in what order, is pinned by the conformance logs, not by this test.
 */

interface Snapshot {
  run: RunRow;
  stageRuns: StageRunRow[];
  transitions: TransitionRow[];
}

interface FoldedStageRun {
  state: string;
  outcome: string | null;
  ending: string | null;
  attempt: number;
  visit: number;
  retryIndex: number;
}

interface Folded {
  status: string;
  currentStage: string | undefined;
  stageRuns: Map<string, FoldedStageRun>;
}

const ENDED = ["completed", "failed", "canceled"];
const LIVE = ["submitted", "working", "input_required"];
/** The endings an attempt is retried on, each written as an event of its name. */
const RETRYABLE = ["no_result", "lost", "timeout", "turn_error"];

function snapshot(store: Store, runId: string): Snapshot {
  return store.tx((t) => {
    const run = t.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return {
      run,
      stageRuns: t
        .listStageRuns({ limit: 100_000 })
        .filter((r) => r.runId === runId),
      transitions: t.transitions(runId),
    };
  });
}

/** Whether an attempt that ended with `ending` is retried, as the format's retry rule says. */
function retried(
  def: Definition,
  stage: string,
  ending: string,
  retryIndex: number,
): boolean {
  const s = def.stages[stage];
  if (s?.type !== "agent" && s?.type !== "action") return false;
  return s.retry.on.includes(ending as RetryEnding) && retryIndex < s.retry.max;
}

/** The `end` stage a run ending with `status` entered; the test needs it to be the only one. */
function endWith(def: Definition, status: string): string {
  const ends = Object.entries(def.stages).filter(
    ([, s]) => s.type === "end" && s.status === status,
  );
  expect(ends, `the end stage with status ${status}`).toHaveLength(1);
  return ends[0]?.[0] as string;
}

/**
 * Folds the rows, checking on the way that each one starts from the state
 * the fold has reached. A run's switch between working and input_required
 * writes no transition: the run is input_required while its live stage run
 * is (an operator gate is open). A cancel moves the stage run first, so the
 * run goes from input_required straight to canceled.
 */
function fold(
  rows: TransitionRow[],
  def: Definition,
  stageOf: Map<string, string>,
): Folded {
  const f: Folded = {
    status: "working",
    currentStage: undefined,
    stageRuns: new Map(),
  };
  let ended = false;
  let live: string | undefined;
  // The stage run the next stage_submitted retries, with its visit and index.
  let retry: { stage: string; visit: number; retryIndex: number } | undefined;
  const attempts = new Map<string, number>();
  const visits = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const where = `transition ${i + 1} (${row.event})`;
    if (row.stageRunId === null) {
      expect(row.fromState, where).toBe(
        row.event === "run_created" ? null : f.status,
      );
      if (ENDED.includes(row.toState) && !ended) {
        ended = true;
        f.status = row.toState;
        if (row.event === "run_ended") {
          f.currentStage = endWith(def, row.toState);
        }
      }
      continue;
    }
    const stage = stageOf.get(row.stageRunId) as string;
    const before = f.stageRuns.get(row.stageRunId);
    expect(row.fromState, where).toBe(before?.state ?? null);
    let next: FoldedStageRun;
    if (before === undefined) {
      const attempt = (attempts.get(stage) ?? 0) + 1;
      attempts.set(stage, attempt);
      const again = retry?.stage === stage ? retry : undefined;
      const visit = again?.visit ?? (visits.get(stage) ?? 0) + 1;
      visits.set(stage, Math.max(visit, visits.get(stage) ?? 0));
      next = {
        state: row.toState,
        outcome: null,
        ending: null,
        attempt,
        visit,
        retryIndex: again === undefined ? 0 : again.retryIndex + 1,
      };
    } else {
      next = { ...before, state: row.toState };
    }
    retry = undefined;
    if (row.outcome !== null) next.outcome = row.outcome;
    if (RETRYABLE.includes(row.event) && row.toState === "failed") {
      next.ending = row.event;
      if (retried(def, stage, row.event, next.retryIndex)) {
        retry = { stage, visit: next.visit, retryIndex: next.retryIndex };
      }
    }
    if (row.event === "gate_timeout") next.ending = "timeout";
    f.stageRuns.set(row.stageRunId, next);
    if (ended) continue;
    // A stage entered (or retried) while the run is going becomes its
    // current stage and its live stage run; the cancel action, submitted
    // after the run ended, does not.
    if (row.event === "stage_submitted") {
      f.currentStage = stage;
      live = row.stageRunId;
    }
    if (row.stageRunId === live && row.event !== "stage_canceled") {
      f.status =
        row.toState === "input_required" ? "input_required" : "working";
    }
  }
  return f;
}

/** The stored rows, as the fold sees them. */
function stored(s: Snapshot): Folded {
  return {
    status: s.run.status,
    currentStage: s.run.currentStage,
    stageRuns: new Map(
      s.stageRuns.map((r) => [
        r.stageRunId,
        {
          state: r.state,
          outcome: r.outcome,
          ending: r.ending ?? null,
          attempt: r.attempt,
          visit: r.visit,
          retryIndex: r.retryIndex,
        },
      ]),
    ),
  };
}

function expectReplays(s: Snapshot, def: Definition): void {
  const stageOf = new Map(s.stageRuns.map((r) => [r.stageRunId, r.stage]));
  expect(fold(s.transitions, def, stageOf)).toEqual(stored(s));
}

const CASES = path.resolve("conformance/cases");

describe("replaying the transition log", () => {
  const cases = readdirSync(CASES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  test.each(cases)(
    "rebuilds the stored rows of conformance case %s",
    async (name) => {
      const dir = path.join(CASES, name);
      const loaded = await loadDefinition(path.join(dir, "pipeline.yaml"));
      const script = parseScript(
        readFileSync(path.join(dir, "script.yaml"), "utf8"),
        loaded.def,
      );
      let seen: Snapshot | undefined;
      await simulate(loaded, script, {
        inspect: (store, runId) => {
          seen = snapshot(store, runId);
        },
      });
      if (!seen) throw new Error("inspect was not called");
      expectReplays(seen, loaded.def);
    },
  );

  test("rebuilds the stored rows of 50 explored paths of review-loop", async () => {
    const loaded = await loadDefinition(
      path.resolve("test/fixtures/defs/review-loop/pipeline.yaml"),
    );
    const paths: Snapshot[] = [];
    await explore(loaded, {
      maxDepth: 40,
      maxPaths: 50,
      inspect: (store, runId) => {
        paths.push(snapshot(store, runId));
      },
    });
    expect(paths).toHaveLength(50);
    // The paths between them reach every final run status but canceled,
    // and runs still going (stopped at a gate, or looping).
    const statuses = new Set(paths.map((p) => p.run.status));
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    for (const p of paths) expectReplays(p, loaded.def);
  });

  test("a run still waiting at an operator gate replays as input_required", async () => {
    const loaded = await loadDefinition(
      path.resolve("test/fixtures/defs/review-loop/pipeline.yaml"),
    );
    let seen: Snapshot | undefined;
    const r = await simulate(
      loaded,
      parseScript(
        "inputs: { topic: rust }\nstages:\n  publish: [ { ending: timeout } ]",
        loaded.def,
      ),
      {
        maxSteps: 20,
        inspect: (store, runId) => {
          seen = snapshot(store, runId);
        },
      },
    );
    expect(r.status).toBe("input_required");
    if (!seen) throw new Error("inspect was not called");
    expect(LIVE).toContain(seen.stageRuns.at(-1)?.state);
    expectReplays(seen, loaded.def);
  });
});
