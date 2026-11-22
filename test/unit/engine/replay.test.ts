import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadDefinition } from "../../../src/format/load.js";
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
 * rows, oldest first, rebuilds what the store says the run and each of its
 * stage runs ended up as.
 *
 * The fold covers what the log is meant to determine: the run's status and
 * current stage, and each stage run's state and outcome. Bookkeeping that is
 * not a state (dispatch sequence, deadlines, wake times, turn counts,
 * checkpoint notes, fields) is not in the log and is left out. A stage run's
 * stage id is fixed when it is created and is carried by every log line as
 * `run_stage`; the fold reads it from the stored row.
 */

interface Snapshot {
  run: RunRow;
  stageRuns: StageRunRow[];
  transitions: TransitionRow[];
}

interface Folded {
  status: string;
  currentStage: string | undefined;
  stageRuns: Map<string, { state: string; outcome: string | null }>;
}

const ENDED = ["completed", "failed", "canceled"];
const LIVE = ["submitted", "working", "input_required"];

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

/**
 * Folds the rows, checking on the way that each one starts from the state
 * the fold has reached. A run's switch between working and input_required
 * writes no transition: the run is input_required exactly while its live
 * stage run is (an operator gate is open).
 */
function fold(rows: TransitionRow[], stageOf: Map<string, string>): Folded {
  const f: Folded = {
    status: "working",
    currentStage: undefined,
    stageRuns: new Map(),
  };
  let ended = false;
  let live: string | undefined;
  const runStatus = (): string => {
    if (ended) return f.status;
    const state = live === undefined ? undefined : f.stageRuns.get(live)?.state;
    return state === "input_required" ? "input_required" : "working";
  };
  for (const [i, row] of rows.entries()) {
    const where = `transition ${i + 1} (${row.event})`;
    if (row.stageRunId === null) {
      expect(row.fromState, where).toBe(
        row.event === "run_created" ? null : runStatus(),
      );
      if (ENDED.includes(row.toState) && !ended) {
        ended = true;
        f.status = row.toState;
        const detail = row.detail as { stage?: unknown } | null;
        if (row.event === "run_ended" && typeof detail?.stage === "string") {
          f.currentStage = detail.stage;
        }
      }
      continue;
    }
    const before = f.stageRuns.get(row.stageRunId);
    expect(row.fromState, where).toBe(before?.state ?? null);
    f.stageRuns.set(row.stageRunId, {
      state: row.toState,
      outcome: row.outcome ?? before?.outcome ?? null,
    });
    // A stage entered (or retried) while the run is going becomes its
    // current stage; the cancel action, submitted after the run ended, does not.
    if (row.event === "stage_submitted" && !ended) {
      f.currentStage = stageOf.get(row.stageRunId);
      live = row.stageRunId;
    }
  }
  f.status = runStatus();
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
        { state: r.state, outcome: r.outcome },
      ]),
    ),
  };
}

function expectReplays(s: Snapshot): void {
  const stageOf = new Map(s.stageRuns.map((r) => [r.stageRunId, r.stage]));
  expect(fold(s.transitions, stageOf)).toEqual(stored(s));
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
      expectReplays(seen);
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
    for (const p of paths) expectReplays(p);
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
    expectReplays(seen);
  });
});
