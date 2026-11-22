import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  checkSchema,
  fieldsShorthandToSchema,
  type JsonSchema,
  validateJson,
} from "./jsonschema.js";
import {
  type ActionStage,
  type AgentStage,
  type CheckStage,
  type Definition,
  type Duration,
  type EndStage,
  type GateStage,
  type Next,
  type Outcome,
  type ProviderPolicy,
  parseDuration,
  type RetryPolicy,
  type Stage,
  type WaitStage,
} from "./types.js";

export interface LoadedDefinition {
  file: string;
  dir: string;
  def: Definition;
  hash: string;
  briefs: Record<string, string>;
  problems: string[];
}

type Raw = Record<string, unknown>;

/** Applied to agent stages when neither the stage nor the defaults give a retry. */
const agentRetry = (): RetryPolicy => ({ max: 1, on: ["lost"] });
const otherRetry = (): RetryPolicy => ({ max: 0, on: [] });
const copyRetry = (r: RetryPolicy): RetryPolicy => ({
  max: r.max,
  on: [...r.on],
});
const RESERVED_TYPES = ["subpipeline", "parallel"];

let cachedSchema: JsonSchema | undefined;

/** The JSON Schema describing a definition file, as shipped in `schema.json`. */
export function definitionSchema(): JsonSchema {
  if (cachedSchema) return cachedSchema;
  // `schema.json` sits next to this module: in `src` when running from
  // source, in `dist` after the build copies it there.
  cachedSchema = JSON.parse(
    readFileSync(new URL("./schema.json", import.meta.url), "utf8"),
  ) as JsonSchema;
  return cachedSchema;
}

function isObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emptyDefinition(raw: unknown): Definition {
  const id = isObject(raw) && typeof raw.id === "string" ? raw.id : "";
  return {
    format: 1,
    id,
    version: 0,
    providers: "fleet",
    start: "",
    stages: {},
    extensions: {},
  };
}

function duration(v: unknown): Duration | undefined {
  return typeof v === "string" ? parseDuration(v) : undefined;
}

function retryOf(v: unknown): RetryPolicy | undefined {
  if (!isObject(v)) return undefined;
  return {
    max: v.max as number,
    on: ((v.on as RetryPolicy["on"] | undefined) ?? []).slice(),
  };
}

function nextOf(v: unknown): Next {
  if (typeof v === "string") return v;
  return (v as Raw[]).map((b) =>
    typeof b.if === "string"
      ? { if: b.if, to: b.to as string }
      : { to: b.to as string },
  );
}

/**
 * Outcome fields are the `name: type` shorthand when every value is a string;
 * anything else is a full JSON Schema, which must describe an object.
 */
function fieldsOf(v: unknown, where: string, outcome: string): JsonSchema {
  if (!isObject(v)) {
    throw new Error(`${where}: fields must be an object`);
  }
  if (Object.values(v).every((spec) => typeof spec === "string")) {
    try {
      return fieldsShorthandToSchema(v as Record<string, string>);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  }
  if (v.type !== "object") {
    throw new Error(
      `outcome ${outcome}: fields schema must be an object schema`,
    );
  }
  const schema = v as JsonSchema;
  try {
    checkSchema(schema);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
  return schema;
}

function outcomesOf(
  v: unknown,
  where: string,
  problems: string[],
): Record<string, Outcome> {
  const out: Record<string, Outcome> = {};
  for (const [name, raw] of Object.entries(v as Raw)) {
    const o = raw as Raw;
    const outcome: Outcome = { next: nextOf(o.next) };
    if (o.fields !== undefined) {
      try {
        outcome.fields = fieldsOf(
          o.fields,
          `${where}/outcomes/${name}/fields`,
          name,
        );
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    out[name] = outcome;
  }
  return out;
}

function providersOf(v: unknown): ProviderPolicy {
  if (v === undefined) return "fleet";
  if (isObject(v)) return { allow: (v.allow as string[]).slice() };
  return v as "fleet" | "subscription";
}

interface Defaults {
  deadline?: Duration;
  retry?: RetryPolicy;
}

function stageOf(
  id: string,
  raw: Raw,
  defaults: Defaults,
  problems: string[],
): Stage {
  const where = `/stages/${id}`;
  switch (raw.type) {
    case "agent": {
      const turns = (raw.turns as Raw | undefined) ?? {};
      const stage: AgentStage = {
        type: "agent",
        agent: raw.agent as string,
        session: (raw.session as "run" | "project" | undefined) ?? "run",
        brief: raw.brief as string,
        turns: { max: (turns.max as number | undefined) ?? 1 },
        retry:
          retryOf(raw.retry) ??
          (defaults.retry ? copyRetry(defaults.retry) : agentRetry()),
        outcomes: outcomesOf(raw.outcomes, where, problems),
      };
      const cap = duration(turns.cap);
      if (cap !== undefined) stage.turns.capMs = cap;
      const deadline = duration(raw.deadline) ?? defaults.deadline;
      if (deadline !== undefined) stage.deadline = deadline;
      if (isObject(raw.requires)) {
        stage.requires = { tools: (raw.requires.tools as string[]).slice() };
      }
      if (typeof raw.deploys === "boolean") stage.deploys = raw.deploys;
      if (typeof raw.on_exhausted === "string") {
        stage.onExhausted = raw.on_exhausted;
      }
      return stage;
    }
    case "gate": {
      const timeout = parseDuration(raw.timeout as string);
      const ot = raw.on_timeout as Raw | undefined;
      const stage: GateStage = {
        type: "gate",
        timeout,
        onTimeout:
          ot === undefined
            ? { remind: timeout }
            : typeof ot.next === "string"
              ? { next: ot.next }
              : typeof ot.remind === "string"
                ? { remind: parseDuration(ot.remind) }
                : { remind: timeout },
        outcomes: outcomesOf(raw.outcomes, where, problems),
      };
      if (raw.who === "operator") stage.who = "operator";
      if (isObject(raw.poll)) {
        stage.poll = {
          fact: raw.poll.fact as string,
          every: parseDuration(raw.poll.every as string),
        };
      }
      if (typeof raw.prompt === "string") stage.prompt = raw.prompt;
      return stage;
    }
    case "check":
      return {
        type: "check",
        check: raw.check as string,
        outcomes: { ...(raw.outcomes as Record<string, string>) },
      } satisfies CheckStage;
    case "action": {
      const stage: ActionStage = {
        type: "action",
        action: raw.action as string,
        next: raw.next as string,
        retry:
          retryOf(raw.retry) ??
          (defaults.retry ? copyRetry(defaults.retry) : otherRetry()),
      };
      if (typeof raw.on_exhausted === "string") {
        stage.onExhausted = raw.on_exhausted;
      }
      return stage;
    }
    case "wait": {
      const stage: WaitStage = { type: "wait", next: raw.next as string };
      const f = duration(raw.for);
      if (f !== undefined) stage.for = f;
      if (typeof raw.until === "string") stage.until = raw.until;
      return stage;
    }
    default:
      return {
        type: "end",
        status: raw.status as EndStage["status"],
      };
  }
}

const STAGE_DEFS: Record<string, string> = {
  agent: "agentStage",
  gate: "gateStage",
  check: "checkStage",
  action: "actionStage",
  wait: "waitStage",
  end: "endStage",
};

/** Names a placeholder reads as engine values, so no stage may use them. */
const RESERVED_STAGE_IDS = ["run", "stage", "inputs"];

const RESERVED_OUTCOMES = ["on_timeout", "on_exhausted", "on_cancel", "next"];

/** Rules the schema cannot say: reserved outcome names and gate kinds. */
function stageRules(id: string, stage: Raw): string[] {
  const out: string[] = [];
  if (isObject(stage.outcomes)) {
    for (const name of Object.keys(stage.outcomes)) {
      if (RESERVED_OUTCOMES.includes(name)) {
        out.push(`stage ${id}: outcome name ${name} is reserved`);
      }
    }
  }
  if (stage.type === "gate") {
    const who = stage.who !== undefined;
    const poll = stage.poll !== undefined;
    if (who && poll) {
      out.push(
        `stage ${id}: a gate has either who: operator or poll, not both`,
      );
    } else if (!who && !poll) {
      out.push(`stage ${id}: a gate needs who: operator or poll`);
    }
  }
  return out;
}

/** Schema errors for the file, one per problem, with stage-level precision. */
function schemaProblems(doc: Raw): string[] {
  const schema = definitionSchema();
  const defs = schema.$defs ?? {};
  const top: JsonSchema = {
    ...schema,
    properties: { ...schema.properties, stages: { type: "object" } },
  };
  const problems = validateJson(top, doc);
  const stages = isObject(doc.stages) ? doc.stages : {};
  for (const [id, stage] of Object.entries(stages)) {
    const where = `/stages/${id}`;
    if (RESERVED_STAGE_IDS.includes(id)) {
      problems.push(`stage id ${id} is reserved`);
    }
    if (!isObject(stage)) {
      problems.push(`${where}: must be object`);
      continue;
    }
    const t = stage.type;
    if (typeof t === "string" && RESERVED_TYPES.includes(t)) {
      problems.push(`stage ${id}: type ${t} is reserved for a later format`);
      continue;
    }
    const def = typeof t === "string" ? STAGE_DEFS[t] : undefined;
    if (def === undefined) {
      problems.push(`stage ${id}: unknown type ${JSON.stringify(t)}`);
      continue;
    }
    problems.push(
      ...validateJson({ $ref: `#/$defs/${def}`, $defs: defs }, stage, where),
      ...stageRules(id, stage),
    );
  }
  return problems;
}

function referencedBriefs(def: Definition): string[] {
  const out = new Set<string>();
  for (const stage of Object.values(def.stages)) {
    if (stage.type === "agent") out.add(stage.brief);
  }
  return [...out].sort();
}

function buildDefinition(
  doc: Raw,
  extensions: Record<string, unknown>,
  problems: string[],
): Definition {
  let inputs: JsonSchema | undefined;
  if (isObject(doc.inputs)) {
    inputs = doc.inputs as JsonSchema;
    try {
      checkSchema(inputs);
    } catch (e) {
      problems.push(`/inputs: ${(e as Error).message}`);
    }
  }
  const rawDefaults = isObject(doc.defaults) ? doc.defaults : undefined;
  const defaults: NonNullable<Definition["defaults"]> = {};
  const deadline = duration(rawDefaults?.deadline);
  if (deadline !== undefined) defaults.deadline = deadline;
  const retry = retryOf(rawDefaults?.retry);
  if (retry) defaults.retry = retry;
  if (typeof rawDefaults?.priority === "number") {
    defaults.priority = rawDefaults.priority;
  }
  const stages: Record<string, Stage> = {};
  for (const [id, raw] of Object.entries(doc.stages as Raw)) {
    stages[id] = stageOf(id, raw as Raw, defaults, problems);
  }
  const def: Definition = {
    format: 1,
    id: doc.id as string,
    version: doc.version as number,
    providers: providersOf(doc.providers),
    start: doc.start as string,
    stages,
    extensions,
  };
  if (typeof doc.title === "string") def.title = doc.title;
  if (inputs) def.inputs = inputs;
  if (rawDefaults) def.defaults = defaults;
  if (typeof doc.on_cancel === "string") def.onCancel = doc.on_cancel;
  return def;
}

/**
 * Reads and normalises a pipeline file. Problems found while reading are
 * returned, not thrown, so a caller can report all of them at once; a file
 * that cannot be parsed or fails the schema yields an empty definition.
 */
export async function loadDefinition(file: string): Promise<LoadedDefinition> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const bytes = await readFile(abs);
  const problems: string[] = [];
  const briefs: Record<string, string> = {};
  const result = (def: Definition, hash: string): LoadedDefinition => ({
    file: abs,
    dir,
    def,
    hash,
    briefs,
    problems,
  });
  const plainHash = createHash("sha256").update(bytes).digest("hex");

  let parsed: unknown;
  try {
    parsed = parse(bytes.toString("utf8"));
  } catch (e) {
    problems.push(`yaml: ${(e as Error).message}`);
    return result(emptyDefinition(undefined), plainHash);
  }
  if (!isObject(parsed)) {
    problems.push(": must be object");
    return result(emptyDefinition(undefined), plainHash);
  }

  const extensions: Record<string, unknown> = {};
  const doc: Raw = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("x-")) extensions[k] = v;
    else doc[k] = v;
  }

  let structural: string[];
  try {
    structural = schemaProblems(doc);
  } catch (e) {
    structural = [`schema: ${(e as Error).message}`];
  }
  if (structural.length > 0) {
    problems.push(...structural);
    return result(emptyDefinition(doc), plainHash);
  }

  const def = buildDefinition(doc, extensions, problems);

  const hash = createHash("sha256").update(bytes);
  for (const rel of referencedBriefs(def)) {
    const target = path.resolve(dir, rel);
    const inside = path.relative(dir, target);
    if (
      path.isAbsolute(rel) ||
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    ) {
      problems.push(`brief ${rel}: must be inside the pipeline's folder`);
      continue;
    }
    try {
      const text = await readFile(target);
      briefs[rel] = text.toString("utf8");
      hash.update(`\0${rel}\0`).update(text);
    } catch {
      problems.push(`brief ${rel}: cannot be read`);
    }
  }
  return result(def, hash.digest("hex"));
}
