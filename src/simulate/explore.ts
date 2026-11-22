import type { JsonSchema } from "../format/jsonschema.js";
import type { LoadedDefinition } from "../format/load.js";
import type { Definition, Stage } from "../format/types.js";
import { type GuardAst, parseGuard } from "../guard/parse.js";
import { type Coverage, splitEdges } from "./coverage.js";
import { minimalFields } from "./minimal.js";
import type { Script, SimEnding } from "./script.js";
import {
  type Answer,
  type Decision,
  type SimulationResult,
  simulate,
} from "./simulate.js";

export interface ExploreOptions {
  /** Decisions a path may branch at; past them every decision takes its default. */
  maxDepth: number;
  /** Most paths simulated before the search stops. */
  maxPaths: number;
  /** Most ticks one path runs before it counts as a step limit; 200 by default. */
  maxSteps?: number;
  /**
   * Skip what was already explored: a decision whose state was branched at
   * the same or a shallower depth, and the rest of a run whose defaults
   * bring it back to a state it was in. True by default; off only to show
   * that pruning loses nothing.
   * @internal
   */
  prune?: boolean;
}

/** Ticks a path may take by default: a sound definition's paths need far fewer. */
export const EXPLORE_MAX_STEPS = 200;

/**
 * `no_end`: the run stopped short of an `end` stage (it stalled, or failed
 * outside one); `step_limit`: it would never end, having run out of steps
 * or come back to a state it already left with only defaults ahead;
 * `policy`: a stage that deploys was entered with no operator gate answered
 * before it.
 */
export type ExploreProblemKind = "no_end" | "policy" | "step_limit";

export interface ExploreProblem {
  /** The choice made at each decision of the run, as `<stage>:<choice>`. */
  path: string[];
  problem: ExploreProblemKind;
  /**
   * For `policy` the deploying stage entered. Otherwise the first stage, in
   * definition order, of the loop the run was going round, or the last
   * stage it entered when it was not looping.
   */
  stage: string;
}

export interface ExploreResult {
  /** Paths simulated. */
  paths: number;
  /** True when `maxPaths` stopped the search with paths left to try. */
  truncated: boolean;
  problems: ExploreProblem[];
  /** Edges taken on any path, and those taken on none. */
  coverage: Coverage;
}

/**
 * One way a decision can go. Outcomes keep their name (`draft:drafted`);
 * an engine ending, a gate's timeout and a failed action are marked with
 * `~` (`draft:~lost`, `review:~timeout`, `publish:~fail`).
 */
interface Choice {
  label: string;
  answer: Answer;
  /** True for an operator's answer to a gate. */
  operator: boolean;
}

/** A decision a run met: what it could do, what it did, and its state. */
interface Step {
  choices: Choice[];
  chosen: number;
  state: string;
}

interface PathRun {
  steps: Step[];
  result: SimulationResult;
}

/** What a guard can read that changes as the run goes. */
type Term = Extract<GuardAst, { kind: "count" | "attempts" | "field" }>;

/**
 * Explores a definition's paths, depth first: at each decision every
 * declared outcome, every engine ending an agent turn can have, a gate's
 * timeout when it leads somewhere, and an action's failure. Each path is a
 * fresh simulation answering its decisions from a prefix of choices, then
 * by default (the first outcome, minimal fields). Problems are reported
 * with their path; coverage is merged over every path.
 */
export async function explore(
  loaded: LoadedDefinition,
  opts: ExploreOptions,
): Promise<ExploreResult> {
  const { def } = loaded;
  const prune = opts.prune ?? true;
  const ctx: RunContext = {
    loaded,
    terms: guardTerms(def),
    deploys: Object.entries(def.stages)
      .filter(([, stage]) => stage.type === "agent" && stage.deploys === true)
      .map(([id]) => id),
    prune,
    maxSteps: opts.maxSteps ?? EXPLORE_MAX_STEPS,
    script: {
      stages: {},
      facts: {},
      checks: {},
      actions: {},
      inputs: def.inputs ? minimal("inputs", def.inputs) : {},
    },
    choices: new Map(),
  };
  // The shallowest depth each state was branched at.
  const branched = new Map<string, number>();
  const taken = new Set<string>();
  const problems: ExploreProblem[] = [];
  const stack: number[][] = [[]];
  let paths = 0;
  let truncated = false;
  for (let prefix = stack.pop(); prefix; prefix = stack.pop()) {
    if (paths >= opts.maxPaths) {
      truncated = true;
      break;
    }
    const run = await runPath(ctx, prefix);
    paths++;
    for (const id of run.result.coverage.taken) taken.add(id);
    const path = run.steps.map((s) => s.choices[s.chosen]?.label ?? "?");
    for (const { problem, stage } of problemsOf(def, run.result)) {
      problems.push({ path, problem, stage });
    }
    // Branch at every decision this run took by default, shallowest first.
    const children: number[][] = [];
    const last = Math.min(run.steps.length, opts.maxDepth);
    for (let depth = prefix.length; depth < last; depth++) {
      const step = run.steps[depth] as Step;
      if (prune) {
        const seen = branched.get(step.state);
        if (seen !== undefined && seen <= depth) break;
        branched.set(step.state, depth);
      }
      const way = run.steps.slice(0, depth).map((s) => s.chosen);
      step.choices.forEach((_, c) => {
        if (c !== step.chosen) children.push([...way, c]);
      });
    }
    stack.push(...children.reverse());
  }
  return { paths, truncated, problems, coverage: splitEdges(def, taken) };
}

interface RunContext {
  loaded: LoadedDefinition;
  terms: Term[];
  /** The stages that deploy. */
  deploys: string[];
  prune: boolean;
  maxSteps: number;
  script: Script;
  /** The choices of each stage and decision kind, built once. */
  choices: Map<string, Choice[]>;
}

/** Simulates one path: `prefix[i]` answers decision i, defaults answer the rest. */
async function runPath(ctx: RunContext, prefix: number[]): Promise<PathRun> {
  const steps: Step[] = [];
  const defaultStates = new Set<string>();
  let answered = false;
  // Deploying stages entered before any operator answer.
  const ungated = new Set<string>();
  const decide = (d: Decision): Answer | undefined => {
    const choices = choicesOf(ctx, d);
    const depth = steps.length;
    const chosen = depth < prefix.length ? (prefix[depth] as number) : 0;
    const choice = choices[chosen];
    if (choice === undefined) return undefined;
    if (!answered) {
      for (const id of ctx.deploys) {
        if (d.guard.attempts(id) > 0) ungated.add(id);
      }
    }
    const state = stateOf(d, { answered, ungated }, ctx);
    steps.push({ choices, chosen, state });
    if (choice.operator) answered = true;
    if (ctx.prune && depth >= prefix.length) {
      // Defaults from a state already left come back to it for ever.
      if (defaultStates.has(state)) d.stop();
      defaultStates.add(state);
    }
    return choice.answer;
  };
  const result = await simulate(ctx.loaded, ctx.script, {
    decide,
    maxSteps: ctx.maxSteps,
  });
  const refused = result.problems.find((p) =>
    p.startsWith("completion_refused"),
  );
  if (refused !== undefined) {
    throw new Error(`explore: a generated answer was refused: ${refused}`);
  }
  return { steps, result };
}

/** The problems one simulated path shows, each with its stage. */
function problemsOf(
  def: Definition,
  r: SimulationResult,
): Array<{ problem: ExploreProblemKind; stage: string }> {
  const out: Array<{ problem: ExploreProblemKind; stage: string }> =
    deployedUngated(def, r).map((stage) => ({ problem: "policy", stage }));
  const stage = stuckAt(def, r);
  if (r.problems.some((p) => /^(max_steps|stopped):/.test(p))) {
    out.push({ problem: "step_limit", stage });
  } else if (!r.reachedEnd) {
    out.push({ problem: "no_end", stage });
  }
  return out;
}

/**
 * Where a run that did not end is stuck: the stage of the loop it was
 * going round that comes first in the definition, or the last stage it
 * entered when it was not looping. It depends on the loop alone, not on
 * when the loop was noticed.
 */
function stuckAt(def: Definition, r: SimulationResult): string {
  // Stages in the order they were entered; a retry is not a new entry.
  const entered: string[] = [];
  for (const line of r.log) {
    if (line.event !== "stage_submitted" || line.run_stage === "run") continue;
    if (entered.at(-1) !== line.run_stage) entered.push(line.run_stage);
  }
  const last = entered.at(-1);
  if (last === undefined) return "";
  // One round of the loop: everything entered since the last stage's
  // previous entry.
  const before = entered.lastIndexOf(last, entered.length - 2);
  if (before < 0) return last;
  const loop = new Set(entered.slice(before + 1));
  return Object.keys(def.stages).find((id) => loop.has(id)) ?? last;
}

/** Every deploying stage entered before any operator answered a gate, once each. */
function deployedUngated(def: Definition, r: SimulationResult): string[] {
  const found = new Set<string>();
  let answered = false;
  for (const line of r.log) {
    const stage = def.stages[line.run_stage];
    if (
      line.event === "gate_resolved" &&
      stage?.type === "gate" &&
      stage.who === "operator"
    ) {
      answered = true;
    }
    if (
      line.event === "stage_submitted" &&
      stage?.type === "agent" &&
      stage.deploys === true &&
      !answered
    ) {
      found.add(line.run_stage);
    }
  }
  return [...found];
}

/**
 * Everything that decides how the run goes on from a decision, and what it
 * will be reported for: where it is, its retry and turn, the value of every
 * term a guard reads, whether an operator has answered, and which
 * deploying stages it already entered without one. Two decisions with the
 * same key must have the same future; the key has to name everything the
 * engine chooses a route by, or pruning hides paths.
 */
function stateOf(
  d: Decision,
  policy: { answered: boolean; ungated: Set<string> },
  ctx: RunContext,
): string {
  const values = ctx.terms.map((t) => {
    const v =
      t.kind === "count"
        ? d.guard.count(t.stage, t.outcome)
        : t.kind === "attempts"
          ? d.guard.attempts(t.stage)
          : d.guard.field(t.stage, t.name);
    return v === undefined ? { undefined: true } : v;
  });
  return JSON.stringify([
    d.kind,
    d.stage,
    d.retryIndex,
    d.turnsUsed,
    values,
    policy.answered,
    ctx.deploys.filter((id) => policy.ungated.has(id)),
  ]);
}

/** Every count, attempts and field term the definition's guards read, once each. */
function guardTerms(def: Definition): Term[] {
  const terms = new Map<string, Term>();
  const walk = (n: GuardAst): void => {
    switch (n.kind) {
      case "count":
      case "attempts":
      case "field":
        terms.set(JSON.stringify({ ...n, text: "" }), n);
        break;
      case "not":
        walk(n.operand);
        break;
      case "and":
      case "or":
        for (const t of n.terms) walk(t);
        break;
      case "cmp":
        walk(n.left);
        walk(n.right);
        break;
      default:
        break;
    }
  };
  for (const stage of Object.values(def.stages)) {
    if (stage.type !== "agent" && stage.type !== "gate") continue;
    for (const outcome of Object.values(stage.outcomes)) {
      if (typeof outcome.next === "string") continue;
      for (const branch of outcome.next) {
        if (branch.if === undefined) continue;
        try {
          walk(parseGuard(branch.if));
        } catch {
          // A guard that does not parse fails the run where it is met.
        }
      }
    }
  }
  return [...terms.values()];
}

/** The engine endings an agent turn can have; a timeout only under a deadline. */
function endingsOf(stage: Extract<Stage, { type: "agent" }>): SimEnding[] {
  return [
    "no_result",
    "turn_error",
    ...(stage.deadline === undefined ? [] : (["timeout"] as const)),
    "lost",
    "usage_limited",
  ];
}

/** The ways a decision can go, default first. */
function choicesOf(ctx: RunContext, d: Decision): Choice[] {
  const key = `${d.kind}:${d.stage}`;
  let choices = ctx.choices.get(key);
  if (choices === undefined) {
    choices = buildChoices(ctx.loaded.def, d.kind, d.stage);
    ctx.choices.set(key, choices);
  }
  return choices;
}

function buildChoices(
  def: Definition,
  kind: Decision["kind"],
  id: string,
): Choice[] {
  const stage = def.stages[id];
  const choice = (label: string, answer: Answer, operator = false) => ({
    label: `${id}:${label}`,
    answer,
    operator,
  });
  const timesOut = stage?.type === "gate" && "next" in stage.onTimeout;
  switch (kind) {
    case "turn": {
      if (stage?.type !== "agent") return [];
      return [
        ...Object.entries(stage.outcomes).map(([name, o]) =>
          choice(name, {
            kind: "outcome",
            outcome: name,
            fields: o.fields
              ? (minimal(`${id}:${name}`, o.fields) as Record<string, unknown>)
              : {},
            after: 0,
          }),
        ),
        ...endingsOf(stage).map((ending) =>
          choice(`~${ending}`, { kind: "ending", ending, after: 0 }),
        ),
      ];
    }
    case "gate":
      if (stage?.type !== "gate") return [];
      return [
        ...Object.keys(stage.outcomes).map((name) =>
          choice(name, { kind: "resolve", outcome: name, after: 0 }, true),
        ),
        ...(timesOut
          ? [
              choice("~timeout", {
                kind: "ending",
                ending: "timeout",
                after: 0,
              }),
            ]
          : []),
      ];
    case "poll": {
      const first = stage?.type === "gate" && Object.keys(stage.outcomes)[0];
      if (!first) return [];
      return [
        choice(first, { kind: "poll", holds: true }),
        ...(timesOut
          ? [choice("~timeout", { kind: "poll", holds: false })]
          : []),
      ];
    }
    case "check":
      if (stage?.type !== "check") return [];
      return Object.keys(stage.outcomes).map((name) =>
        choice(name, { kind: "check", outcome: name }),
      );
    case "action":
      return [
        choice("ok", { kind: "action", ok: true }),
        choice("~fail", { kind: "action", ok: false }),
      ];
  }
}

/** The minimal value of a schema; an error names what it is for. */
function minimal(what: string, schema: JsonSchema): unknown {
  try {
    return minimalFields(schema);
  } catch (err) {
    throw new Error(`${what}: ${(err as Error).message}`);
  }
}
