// A minimal harness adapter that keeps everything in memory. It starts no real
// agent: a turn "runs" until the host calls `finish`. Replace the bodies with
// calls to your harness. In your own project, import the types from "sekaisen".
import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
  StartTurn,
} from "../../src/index.js";

interface Turn {
  start: StartTurn;
  outcome: RunOutcome;
}

export class MemoryAdapter implements HarnessAdapter {
  /** Turns by harness run id, in the order they started. */
  readonly turns = new Map<string, Turn>();
  /** Harness run ids by idempotency key: a key seen again returns its turn. */
  private readonly byKey = new Map<string, string>();
  /** What `deliver` was asked to tell each session. */
  readonly delivered: Array<{ sessionKey: string; message: string }> = [];

  async capabilities(): Promise<Capabilities> {
    return {
      turnCapMs: 10 * 60_000,
      maxConcurrent: 2,
      canAbort: true,
      subscriptionProvider: "demo-subscription",
    };
  }

  async openSession(_agent: string, _key: string): Promise<void> {
    // Nothing to prepare: a session here is just a key.
  }

  async startTurn(p: StartTurn): Promise<{ runId: string }> {
    const known = this.byKey.get(p.idempotencyKey);
    if (known !== undefined) return { runId: known };
    const runId = `turn-${this.turns.size + 1}`;
    this.byKey.set(p.idempotencyKey, runId);
    this.turns.set(runId, { start: p, outcome: { state: "running" } });
    return { runId };
  }

  async readRunOutcome(runId: string): Promise<RunOutcome> {
    return this.turns.get(runId)?.outcome ?? { state: "unknown" };
  }

  async abortTurn(runId: string): Promise<boolean> {
    const turn = this.turns.get(runId);
    if (turn?.outcome.state !== "running") return false;
    turn.outcome = { state: "ended", ending: "killed" };
    return true;
  }

  async deliver(sessionKey: string, message: string): Promise<void> {
    this.delivered.push({ sessionKey, message });
  }

  /** What a real harness does when the agent's turn ends. */
  finish(runId: string, outcome: Extract<RunOutcome, { state: "ended" }>) {
    const turn = this.turns.get(runId);
    if (turn) turn.outcome = outcome;
  }
}
