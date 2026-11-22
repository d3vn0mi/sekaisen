import type { LoadedDefinition } from "../format/load.js";
import type { HostRegistry } from "../host/registry.js";
import { graphFindings } from "./graph.js";
import { referenceFindings } from "./references.js";
import { schemaFindings } from "./schema.js";

export interface Finding {
  check:
    | "schema"
    | "references"
    | "graph"
    | "termination"
    | "policy"
    | "timing"
    | string;
  severity: "error" | "warning";
  stage?: string;
  message: string;
}

export interface CheckOptions {
  registry: HostRegistry;
  capabilities?: { turnCapMs: number };
}

/** Runs every check over a loaded definition and returns all findings. */
export async function runChecks(
  loaded: LoadedDefinition,
  opts: CheckOptions,
): Promise<Finding[]> {
  const findings = schemaFindings(loaded);
  if (Object.keys(loaded.def.stages).length === 0) return findings;
  findings.push(
    ...referenceFindings(loaded, opts.registry),
    ...graphFindings(loaded),
  );
  for (const hostCheck of opts.registry.hostChecks) {
    findings.push(...(await hostCheck(loaded.def, loaded)));
  }
  return findings;
}
