import type { Finding } from "../checks/index.js";
import type { LoadedDefinition } from "../format/load.js";
import type { Definition } from "../format/types.js";

/** What a host function sees about the stage it is running for. */
export interface StageCtx {
  runId: string;
  stage: string;
  inputs: unknown;
  /** A field a finished stage reported, or undefined if it has none. */
  field(stage: string, name: string): unknown;
  now: number;
}

/*
 * Host functions are called by the engine's tick, outside any transaction,
 * each bounded by the engine's call timeout (`adapterCallTimeoutMs`). A call
 * that throws ends its attempt as `turn_error`; one that outlives the timeout
 * ends as `timeout` (a fact backs off instead). An action's `retry.on` names
 * which of the two it retries; without `on` it retries both.
 */

/** Returns the name of the outcome to follow. */
export type CheckFn = (ctx: StageCtx) => Promise<string>;
export type ActionFn = (
  ctx: StageCtx & { idempotencyKey: string },
) => Promise<void>;
export type FactFn = (ctx: StageCtx) => Promise<boolean>;
/** A host's own verification of a definition, reported as findings. */
export type HostCheck = (
  def: Definition,
  loaded: LoadedDefinition,
) => Promise<Finding[]>;

export interface HostRegistry {
  checks: Map<string, CheckFn>;
  actions: Map<string, ActionFn>;
  facts: Map<string, FactFn>;
  hostChecks: HostCheck[];
}

export function createRegistry(): HostRegistry {
  return {
    checks: new Map(),
    actions: new Map(),
    facts: new Map(),
    hostChecks: [],
  };
}
