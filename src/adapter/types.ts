/**
 * The seam between the engine and the system that runs agent turns.
 *
 * This interface is provisional until the first adapter is built; expect it
 * to change as real harnesses exercise it.
 */

/** What a harness can do, read once at start-up and by the checks. */
export interface Capabilities {
  /** Longest a single turn may run, in milliseconds. */
  turnCapMs: number;
  /** How many turns can run at the same time. */
  maxConcurrent: number;
  canAbort: boolean;
  /** The provider that counts as the subscription for the `subscription` policy. */
  subscriptionProvider?: string;
  /** The tools an agent holds, when the harness can tell. */
  agentTools?(agent: string): Promise<string[]>;
}

export interface StartTurn {
  agent: string;
  /**
   * Chosen by the engine and stable for the stage's session policy:
   * `run:<runId>:<agent>` for `session: run`, `project:<project>:<agent>` for
   * `session: project`. The adapter maps it to a session of its harness; the
   * same key must reach the same session.
   */
  sessionKey: string;
  message: string;
  capMs: number;
  /** Repeated only for a turn the harness may already have accepted; it must not start twice. */
  idempotencyKey: string;
  /** The completion tools; a harness that grants tools per turn grants these. */
  tools: string[];
}

export type RunOutcome =
  | { state: "running" }
  | {
      state: "ended";
      ending: "ok" | "error" | "timeout" | "killed";
      error?: string;
      runtime?: { provider: string; model: string };
    }
  | { state: "unknown" };

export interface ToolCall {
  agent: string;
  tool: string;
}

export interface HarnessAdapter {
  capabilities(): Promise<Capabilities>;
  /** May be a no-op. */
  openSession(agent: string, key: string): Promise<void>;
  startTurn(p: StartTurn): Promise<{ runId: string }>;
  readRunOutcome(runId: string): Promise<RunOutcome>;
  abortTurn?(runId: string): Promise<boolean>;
  /** Tells a session something without dispatching a turn (reminders). */
  deliver(sessionKey: string, message: string): Promise<void>;
  /** A host loop, when the core is not ticking itself. */
  schedule?(spec: string, fn: () => void): { dispose(): void };
  /** Optional hardening: decide each tool call. */
  guardToolCall?(fn: (call: ToolCall) => "allow" | { deny: string }): void;
}
