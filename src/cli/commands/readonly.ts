import { openSqliteStore } from "../../store/sqlite.js";
import type { Store } from "../../store/types.js";

/** Opens the store at `path` read-only; the message says why when it cannot. */
export function openReadOnly(
  path: string,
): { store: Store } | { error: string } {
  try {
    return { store: openSqliteStore(path, { readonly: true }) };
  } catch (x) {
    return { error: `${path}: error store ${(x as Error).message}\n` };
  }
}

/** A time as an ISO instant. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
