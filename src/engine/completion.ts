import type { JsonSchema } from "../format/jsonschema.js";
import { validateJson } from "../format/jsonschema.js";
import type { AgentStage } from "../format/types.js";
import type { RunRow, StageRunRow, StoreTx } from "../store/types.js";
import { fieldsShorthand } from "./brief.js";
import { deadlinePassed } from "./lifecycle.js";
import type { PinnedDefinitions } from "./pinned.js";
import { hashesEqual, hashToken } from "./tokens.js";
import { isPlainObject } from "./values.js";

export interface CompleteParams {
  token: string;
  outcome: string;
  fields?: unknown;
  artifacts?: string[];
  /** The agent the harness says is calling; checked against the stage's agent when given. */
  callerAgent?: string;
}

/**
 * `next` is the stage the run moved to (an `end` stage's id when the run
 * ended there), or null when the run failed without reaching one.
 */
export type CompletionResult =
  | { ok: true; next: string | null; applied: "now" | "already" }
  | { ok: false; error: string };

/** Largest `fields` object and `artifacts` list a completion may carry, together, as JSON. */
export const MAX_FIELDS_BYTES = 64 * 1024;
/** Most artifacts one completion may name. */
export const MAX_ARTIFACTS = 64;
/** Longest artifact, in characters: it names where a result lives. */
export const MAX_ARTIFACT_CHARS = 1024;
/** Largest progress note. */
export const MAX_NOTE_BYTES = 64 * 1024;

export const fail = (error: string): CompletionResult => ({ ok: false, error });

/** JSON with object keys sorted, so equal values compare equal. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export type TokenLookup =
  | { kind: "live"; row: StageRunRow; run: RunRow; stage: AgentStage }
  | { kind: "completed"; row: StageRunRow }
  | { kind: "refused"; error: string };

/**
 * Finds the agent stage run a token belongs to. In order: the token is
 * known, its attempt has not ended (a refusal is logged), the caller is the
 * stage's agent, then either the attempt is already completed or the run
 * is still working.
 */
export function byToken(
  t: StoreTx,
  pinned: PinnedDefinitions,
  now: number,
  token: string,
  callerAgent: string | undefined,
  /** The event logged when the token's attempt has ended. */
  refusedEvent: "completion_refused" | "progress_refused",
): TokenLookup {
  const refused = (error: string) => ({ kind: "refused" as const, error });
  const hash = hashToken(token);
  const row = t.findStageRunByTokenHash(hash);
  if (!row || row.tokenHash === null || !hashesEqual(row.tokenHash, hash)) {
    return refused(
      "this token is not live: it is unknown or belongs to an earlier attempt",
    );
  }
  const run = t.getRun(row.runId);
  const stage = run && pinned.of(t, run).def.stages[row.stage];
  if (!run || stage?.type !== "agent") {
    return refused("this token does not belong to an agent stage");
  }
  // An attempt past its deadline is over even before the tick records it.
  const overdue = row.state !== "completed" && deadlinePassed(row, now);
  const ended =
    overdue || !["submitted", "working", "completed"].includes(row.state);
  if (ended) {
    const timedOut = overdue || row.ending === "timeout";
    const reason = timedOut ? "attempt timed out" : "attempt ended";
    // Logged once per stage run, and again only when the reason changes, so
    // an agent that keeps calling with a dead token cannot grow the log.
    const last = t
      .transitions(row.runId)
      .findLast(
        (x) => x.stageRunId === row.stageRunId && x.event === refusedEvent,
      );
    const lastReason = isPlainObject(last?.detail)
      ? last.detail.reason
      : undefined;
    if (lastReason !== reason) {
      t.appendTransition({
        runId: row.runId,
        stageRunId: row.stageRunId,
        fromState: row.state,
        toState: row.state,
        event: refusedEvent,
        outcome: null,
        actor: `agent:${callerAgent ?? stage.agent}`,
        at: now,
        detail: { reason },
      });
    }
    return refused(
      timedOut
        ? "this attempt timed out; its deadline passed"
        : `this attempt has ended (${row.state})`,
    );
  }
  if (callerAgent !== undefined && callerAgent !== stage.agent) {
    return refused(
      `this stage belongs to agent ${stage.agent}, not ${callerAgent}`,
    );
  }
  if (row.state === "completed") return { kind: "completed", row };
  if (run.status !== "working") return refused(`the run is ${run.status}`);
  return { kind: "live", row, run, stage };
}

/** A completion for an attempt already completed: idempotent when identical. */
export function repeated(
  t: StoreTx,
  row: StageRunRow,
  p: CompleteParams,
): CompletionResult {
  if (row.outcome !== p.outcome) {
    return fail(`this stage was already completed with outcome ${row.outcome}`);
  }
  const fields = p.fields === undefined ? {} : p.fields;
  if (stableJson(fields) !== stableJson(row.fields)) {
    return fail(
      `this stage was already completed with outcome ${row.outcome} and other fields`,
    );
  }
  const done = t
    .transitions(row.runId)
    .find(
      (x) => x.stageRunId === row.stageRunId && x.event === "stage_completed",
    );
  const next = isPlainObject(done?.detail) ? done.detail.next : null;
  return {
    ok: true,
    next: typeof next === "string" ? next : null,
    applied: "already",
  };
}

/** The problem with a completion's `artifacts`, or undefined when they are acceptable. */
export function checkArtifacts(artifacts: unknown): string | undefined {
  if (artifacts === undefined) return undefined;
  if (
    !Array.isArray(artifacts) ||
    !artifacts.every((a) => typeof a === "string")
  ) {
    return "artifacts must be a list of strings, each naming where a result lives";
  }
  if (artifacts.length > MAX_ARTIFACTS) {
    return `artifacts has ${artifacts.length} items; at most ${MAX_ARTIFACTS} are allowed`;
  }
  const long = artifacts.findIndex((a) => a.length > MAX_ARTIFACT_CHARS);
  if (long >= 0) {
    return `artifacts[${long}] is ${artifacts[long]?.length} characters long; at most ${MAX_ARTIFACT_CHARS} are allowed. An artifact names where a result lives, not the result itself`;
  }
  return undefined;
}

/**
 * The problem with `fields` for `outcome`, or undefined when they are
 * acceptable. `artifacts` count toward the size budget.
 */
export function checkFields(
  outcome: string,
  schema: JsonSchema | undefined,
  fields: unknown,
  artifacts?: string[],
): string | undefined {
  if (!isPlainObject(fields)) {
    return `fields must be an object; outcome ${outcome} takes ${fieldsShorthand(schema)}`;
  }
  const size =
    Buffer.byteLength(JSON.stringify(fields)) +
    (artifacts === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(artifacts)));
  if (size > MAX_FIELDS_BYTES) {
    return artifacts === undefined
      ? `fields are larger than 64 KiB; put large content in an artifact and pass its location. Outcome ${outcome} takes ${fieldsShorthand(schema)}`
      : `fields and artifacts together are larger than 64 KiB as JSON; keep large content out of the completion and pass its location. Outcome ${outcome} takes ${fieldsShorthand(schema)}`;
  }
  if (!schema) {
    return Object.keys(fields).length === 0
      ? undefined
      : `outcome ${outcome} declares no fields; pass {} or leave fields out`;
  }
  const errors = validateJson(schema, fields);
  if (errors.length === 0) return undefined;
  const shown = errors.slice(0, 10).join("; ");
  return `fields for outcome ${outcome} are invalid: ${shown}. Declared ${fieldsShorthand(schema)}`;
}
