import type { Definition } from "./types.js";

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
