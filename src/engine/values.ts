/** Small helpers over untyped values the engine reads from runs and agents. */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The value at a dotted path of own properties, or undefined. */
export function descend(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split(".")) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
