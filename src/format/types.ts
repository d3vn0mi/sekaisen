import type { JsonSchema } from "./jsonschema.js";

/** A length of time in milliseconds. */
export type Duration = number;

/** Endings the engine classifies itself; only these can be retried. */
export type RetryEnding = "no_result" | "lost" | "timeout" | "turn_error";

export interface RetryPolicy {
  max: number;
  on: RetryEnding[];
}

export type ProviderPolicy = "fleet" | "subscription" | { allow: string[] };

/** A stage id, or ordered branches ending with an unconditional one. */
export type Next = string | Array<{ if?: string; to: string }>;

export interface Outcome {
  fields?: JsonSchema;
  next: Next;
}

export interface AgentStage {
  type: "agent";
  agent: string;
  session: "run" | "project";
  brief: string;
  /** Wall-clock budget for one attempt; undefined means no deadline. */
  deadline?: Duration;
  turns: { max: number; capMs?: Duration };
  retry: RetryPolicy;
  requires?: { tools: string[] };
  deploys?: boolean;
  onExhausted?: string;
  outcomes: Record<string, Outcome>;
}

export interface GateStage {
  type: "gate";
  who?: "operator";
  poll?: { fact: string; every: Duration };
  prompt?: string;
  /** Counted from when the gate is entered. */
  timeout: Duration;
  /**
   * What happens once `timeout` passes: take the `next` edge, or remind (the
   * first reminder fires at the timeout, then one every `remind`, and the gate
   * keeps waiting).
   */
  onTimeout: { remind?: Duration } | { next: string };
  outcomes: Record<string, Outcome>;
}

export interface CheckStage {
  type: "check";
  check: string;
  outcomes: Record<string, string>;
}

export interface ActionStage {
  type: "action";
  action: string;
  next: string;
  retry: RetryPolicy;
  onExhausted?: string;
}

export interface WaitStage {
  type: "wait";
  for?: Duration;
  until?: string;
  next: string;
}

export interface EndStage {
  type: "end";
  status: "completed" | "failed" | "canceled";
}

export type Stage =
  | AgentStage
  | GateStage
  | CheckStage
  | ActionStage
  | WaitStage
  | EndStage;

export interface Definition {
  format: 1;
  id: string;
  title?: string;
  version: number;
  inputs?: JsonSchema;
  defaults?: {
    deadline?: Duration;
    /** As written: without `on`, each stage gets its own type's default `on`. */
    retry?: { max: number; on?: RetryEnding[] };
    priority?: number;
  };
  providers: ProviderPolicy;
  start: string;
  stages: Record<string, Stage>;
  onCancel?: string;
  /** `x-*` keys of the file, ignored by the core. */
  extensions: Record<string, unknown>;
}

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `"90s"`, `"30m"`, `"24h"` or `"2d"` to milliseconds; anything else throws. */
export function parseDuration(text: string): Duration {
  const m = typeof text === "string" ? /^(\d+)([smhd])$/.exec(text) : null;
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(text)}`);
  return Number(m[1]) * (UNITS[m[2] as string] as number);
}
