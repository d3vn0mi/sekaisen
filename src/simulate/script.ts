import { parse as parseYaml } from "yaml";
import { checkFields } from "../engine/completion.js";
import { isPlainObject } from "../engine/values.js";
import { validateJson } from "../format/jsonschema.js";
import {
  type Definition,
  type Duration,
  parseDuration,
} from "../format/types.js";

/**
 * A simulation script: what each simulated turn, gate and host function
 * answers. Entries are used in order; once a list runs out, an agent turn
 * reports its stage's first outcome with no fields, an operator gate is
 * resolved with its first outcome, a check returns its stage's first
 * outcome, an action succeeds and a fact holds.
 */
export interface Script {
  /** By stage id: one entry per dispatched turn (agent) or per opening (gate). */
  stages: Record<string, Visit[]>;
  /** By fact name: the answer of each poll, in order. */
  facts: Record<string, boolean[]>;
  /** By check name: the outcome of each call, in order. */
  checks: Record<string, string[]>;
  /** By action name: whether each call succeeds or throws, in order. */
  actions: Record<string, Array<"ok" | "fail">>;
  inputs: unknown;
}

/** The engine-classified endings a simulated agent turn can have. */
export const SIM_ENDINGS = [
  "no_result",
  "lost",
  "timeout",
  "usage_limited",
  "turn_error",
] as const;
export type SimEnding = (typeof SIM_ENDINGS)[number];

/**
 * One entry of a stage. `after` is how long after the turn starts (or the
 * gate opens) the entry takes effect; 0 when not given.
 */
export type Visit =
  | {
      kind: "outcome";
      outcome: string;
      fields: Record<string, unknown>;
      after: Duration;
    }
  /** `resets`: for `usage_limited`, how long until the limit lifts. */
  | { kind: "ending"; ending: SimEnding; after: Duration; resets?: Duration }
  | { kind: "resolve"; outcome: string; after: Duration };

/** A script that cannot be used; `problems` lists every reason. */
export class ScriptError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ScriptError";
  }
}

const TOP_KEYS = ["stages", "facts", "checks", "actions", "inputs"];
const VISIT_KEYS = [
  "outcome",
  "ending",
  "resolve",
  "fields",
  "after",
  "resets",
];

/**
 * Reads a YAML script and checks it against `def`: every stage, outcome,
 * ending, host name and duration it names must exist, and its inputs must
 * satisfy the definition's. Throws a ScriptError listing every problem.
 */
export function parseScript(text: string, def: Definition): Script {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ScriptError([`yaml: ${(err as Error).message}`]);
  }
  const problems: string[] = [];
  const top = raw === null || raw === undefined ? {} : raw;
  if (!isPlainObject(top))
    throw new ScriptError(["a script must be a mapping"]);
  for (const key of Object.keys(top)) {
    if (!TOP_KEYS.includes(key)) problems.push(`unknown key ${key}`);
  }
  const script: Script = {
    stages: readStages(top.stages, def, problems),
    actions: readLists<"ok" | "fail">(top.actions, "actions", problems, {
      known: (name) =>
        hostNames(def, "action").has(name)
          ? undefined
          : `no action stage runs ${name}`,
      item: (v) =>
        v === "ok" || v === "fail"
          ? { value: v }
          : { error: `${JSON.stringify(v)} is neither ok nor fail` },
    }),
    checks: readLists(top.checks, "checks", problems, {
      known: (name) =>
        hostNames(def, "check").has(name)
          ? undefined
          : `no check stage runs ${name}`,
      item: (v, name) => checkOutcome(def, name, v),
    }),
    facts: readLists<boolean>(top.facts, "facts", problems, {
      known: (name) =>
        hostNames(def, "fact").has(name) ? undefined : `no gate polls ${name}`,
      item: (v) =>
        typeof v === "boolean"
          ? { value: v }
          : { error: `${JSON.stringify(v)} is not true or false` },
    }),
    inputs: top.inputs === undefined ? {} : top.inputs,
  };
  const inputErrors = def.inputs
    ? validateJson(def.inputs, script.inputs)
    : isPlainObject(script.inputs)
      ? []
      : ["must be a mapping"];
  if (inputErrors.length > 0) {
    problems.push(`inputs: ${inputErrors.slice(0, 10).join("; ")}`);
  }
  if (problems.length > 0) throw new ScriptError(problems);
  return script;
}

function readStages(
  raw: unknown,
  def: Definition,
  problems: string[],
): Record<string, Visit[]> {
  const out: Record<string, Visit[]> = {};
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) {
    problems.push("stages must be a mapping of stage ids to lists");
    return out;
  }
  for (const [id, list] of Object.entries(raw)) {
    const where = `stages.${id}`;
    const stage = Object.hasOwn(def.stages, id) ? def.stages[id] : undefined;
    if (!stage) {
      problems.push(`${where}: no stage named ${id}`);
      continue;
    }
    if (stage.type === "check" || stage.type === "action") {
      problems.push(
        `${where}: ${id} is ${stage.type === "action" ? "an action" : "a check"} stage; script its ${stage.type} under ${stage.type}s`,
      );
      continue;
    }
    if (stage.type === "gate" && stage.poll) {
      problems.push(
        `${where}: gate ${id} polls ${stage.poll.fact}; script the fact under facts`,
      );
      continue;
    }
    if (stage.type !== "agent" && stage.type !== "gate") {
      problems.push(`${where}: a ${stage.type} stage is not scripted`);
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(`${where}: must be a list of visits`);
      continue;
    }
    const visits: Visit[] = [];
    list.forEach((entry: unknown, i) => {
      const visit = readVisit(entry, id, stage);
      if (typeof visit === "string") problems.push(`${where}[${i}]: ${visit}`);
      else visits.push(visit);
    });
    out[id] = visits;
  }
  return out;
}

type ScriptedStage = Extract<
  Definition["stages"][string],
  { type: "agent" | "gate" }
>;

/** One visit, or why it is malformed. */
function readVisit(
  entry: unknown,
  id: string,
  stage: ScriptedStage,
): Visit | string {
  if (!isPlainObject(entry)) return "a visit must be a mapping";
  const unknown = Object.keys(entry).find((k) => !VISIT_KEYS.includes(k));
  if (unknown !== undefined) return `unknown key ${unknown}`;
  const kinds = ["outcome", "ending", "resolve"].filter((k) => k in entry);
  if (kinds.length !== 1) {
    return "a visit has exactly one of outcome, ending or resolve";
  }
  let after = 0;
  if (entry.after !== undefined) {
    try {
      after = parseDuration(entry.after as string);
    } catch (err) {
      return `after: ${(err as Error).message}`;
    }
  }
  if (entry.resets !== undefined && entry.ending !== "usage_limited") {
    return "resets goes only with ending: usage_limited";
  }
  if (entry.fields !== undefined && !("outcome" in entry)) {
    return "fields go only with outcome";
  }
  const declared = Object.keys(stage.outcomes);
  const unknownOutcome = (name: unknown) =>
    `unknown outcome ${JSON.stringify(name)}; declared: ${declared.join(", ")}`;

  if (stage.type === "gate") {
    if ("resolve" in entry) {
      const outcome = entry.resolve;
      if (typeof outcome !== "string" || !declared.includes(outcome)) {
        return unknownOutcome(outcome);
      }
      return { kind: "resolve", outcome, after };
    }
    if ("ending" in entry) {
      return entry.ending === "timeout"
        ? { kind: "ending", ending: "timeout", after }
        : "a gate's only ending is timeout";
    }
    return `${id} is a gate; use resolve, or ending: timeout`;
  }

  if ("resolve" in entry)
    return `${id} is an agent stage; use outcome or ending`;
  if ("ending" in entry) {
    const ending = entry.ending;
    if (!SIM_ENDINGS.includes(ending as SimEnding)) {
      return `unknown ending ${JSON.stringify(ending)}; one of ${SIM_ENDINGS.join(", ")}`;
    }
    const visit: Visit = { kind: "ending", ending: ending as SimEnding, after };
    if (entry.resets !== undefined) {
      try {
        visit.resets = parseDuration(entry.resets as string);
      } catch (err) {
        return `resets: ${(err as Error).message}`;
      }
    }
    return visit;
  }
  const outcome = entry.outcome;
  if (typeof outcome !== "string" || !declared.includes(outcome)) {
    return unknownOutcome(outcome);
  }
  const fields = entry.fields === undefined ? {} : entry.fields;
  const invalid = checkFields(outcome, stage.outcomes[outcome]?.fields, fields);
  if (invalid) return invalid;
  return {
    kind: "outcome",
    outcome,
    fields: fields as Record<string, unknown>,
    after,
  };
}

type Read<T> = { value: T } | { error: string };

/**
 * Reads a mapping of host names to lists: `known` says why a name is not
 * one the definition calls, `item` reads each entry.
 */
function readLists<T>(
  raw: unknown,
  section: string,
  problems: string[],
  read: {
    known: (name: string) => string | undefined;
    item: (v: unknown, name: string) => Read<T>;
  },
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) {
    problems.push(`${section} must be a mapping of names to lists`);
    return out;
  }
  for (const [name, list] of Object.entries(raw)) {
    const where = `${section}.${name}`;
    const unknown = read.known(name);
    if (unknown !== undefined) {
      problems.push(`${where}: ${unknown}`);
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(`${where}: must be a list`);
      continue;
    }
    const values: T[] = [];
    list.forEach((v: unknown, i) => {
      const r = read.item(v, name);
      if ("error" in r) problems.push(`${where}[${i}]: ${r.error}`);
      else values.push(r.value);
    });
    out[name] = values;
  }
  return out;
}

/** The host names the definition's stages call, by kind. */
export function hostNames(
  def: Definition,
  kind: "check" | "action" | "fact",
): Set<string> {
  const names = new Set<string>();
  for (const stage of Object.values(def.stages)) {
    if (kind === "check" && stage.type === "check") names.add(stage.check);
    if (kind === "action" && stage.type === "action") names.add(stage.action);
    if (kind === "fact" && stage.type === "gate" && stage.poll) {
      names.add(stage.poll.fact);
    }
  }
  return names;
}

/** `v` when every check stage running `name` declares it as an outcome. */
function checkOutcome(def: Definition, name: string, v: unknown): Read<string> {
  for (const [id, stage] of Object.entries(def.stages)) {
    if (stage.type !== "check" || stage.check !== name) continue;
    if (typeof v !== "string" || !Object.hasOwn(stage.outcomes, v)) {
      return {
        error: `${JSON.stringify(v)} is not an outcome of check stage ${id} (declared: ${Object.keys(stage.outcomes).join(", ")})`,
      };
    }
  }
  return { value: v as string };
}
