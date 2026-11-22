import type { LoadedDefinition } from "../format/load.js";
import type { Finding } from "./index.js";

/** Problems found while loading the file, as errors. */
export function schemaFindings(loaded: LoadedDefinition): Finding[] {
  return loaded.problems.map((message) => ({
    check: "schema",
    severity: "error",
    message,
  }));
}
