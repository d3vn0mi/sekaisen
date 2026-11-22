import type { Capabilities } from "../adapter/types.js";
import type { LoadedDefinition } from "../format/load.js";
import type { HostRegistry } from "../host/registry.js";
import { graphFindings } from "./graph.js";
import { policyFindings } from "./policy.js";
import { referenceFindings } from "./references.js";
import { schemaFindings } from "./schema.js";
import { terminationFindings } from "./termination.js";
import { timingFindings } from "./timing.js";

export interface Finding {
  check:
    | "schema"
    | "references"
    | "graph"
    | "termination"
    | "policy"
    | "timing"
    | string;
  severity: "error" | "warning" | "info";
  stage?: string;
  message: string;
}

export interface CheckOptions {
  registry: HostRegistry;
  capabilities?: Capabilities;
  /** How to report a check, action or fact name the registry lacks; default error. */
  unregisteredAs?: "error" | "warning";
}

/** Runs every check over a loaded definition and returns all findings. */
export async function runChecks(
  loaded: LoadedDefinition,
  opts: CheckOptions,
): Promise<Finding[]> {
  const findings = schemaFindings(loaded);
  if (Object.keys(loaded.def.stages).length === 0) return findings;
  findings.push(
    ...referenceFindings(loaded, opts.registry, opts.unregisteredAs ?? "error"),
    ...graphFindings(loaded),
    ...terminationFindings(loaded),
    ...policyFindings(loaded),
    ...timingFindings(loaded, opts.capabilities),
  );
  for (const hostCheck of opts.registry.hostChecks) {
    findings.push(...(await hostCheck(loaded.def, loaded)));
  }
  return findings;
}
