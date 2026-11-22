import type { Definition, RetryEnding } from "./types.js";

/**
 * Rules of the format that the checks and the engine both apply, kept in one
 * place so the two can never disagree.
 */

/** The first `end` stage with status `failed`, where an exhausted stage goes by default. */
export function failedEnd(def: Definition): string | undefined {
  return Object.entries(def.stages).find(
    ([, s]) => s.type === "end" && s.status === "failed",
  )?.[0];
}

/** A `{{ name }}` placeholder in a brief, a gate prompt or a wait's `until`. */
export const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * What a `retry` given without `on` retries: for an agent, a turn lost to a
 * restart; for an action, a call that threw or ran past the call timeout.
 */
export const DEFAULT_RETRY_ON: Record<"agent" | "action", RetryEnding[]> = {
  agent: ["lost"],
  action: ["turn_error", "timeout"],
};

/** The engine-classified endings an attempt of each retrying stage type can have. */
export const STAGE_ENDINGS: Record<"agent" | "action", readonly RetryEnding[]> =
  {
    agent: ["no_result", "lost", "timeout", "turn_error"],
    action: ["turn_error", "timeout"],
  };
