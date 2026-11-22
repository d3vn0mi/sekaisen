import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
  StartTurn,
} from "./types.js";

/**
 * An in-memory harness for tests. It records every call, hands out run ids
 * `fr_1`, `fr_2`, … and, like a real harness, starts a turn only once per
 * idempotency key.
 */
export class FakeAdapter implements HarnessAdapter {
  /** Every `startTurn` call, in order, including ones that threw. */
  readonly calls: StartTurn[] = [];
  readonly opened: Array<{ agent: string; key: string }> = [];
  readonly aborted: string[] = [];
  readonly delivered: Array<{ sessionKey: string; message: string }> = [];
  caps: Capabilities = { turnCapMs: 600_000, maxConcurrent: 8, canAbort: true };
  /**
   * Runs inside `startTurn` before it returns. A test can throw here to
   * refuse the turn, or call back into the engine as a fast agent would.
   */
  beforeStart?: (p: StartTurn) => void | Promise<void>;
  /** Runs inside `readRunOutcome` before it answers, like `beforeStart`. */
  beforeRead?: (runId: string) => void | Promise<void>;

  private readonly outcomes = new Map<string, RunOutcome>();
  private readonly byKey = new Map<string, string>();
  private readonly runIds = new Set<string>();
  private started = 0;

  setOutcome(runId: string, outcome: RunOutcome): void {
    this.outcomes.set(runId, outcome);
  }

  async capabilities(): Promise<Capabilities> {
    return this.caps;
  }

  async openSession(agent: string, key: string): Promise<void> {
    this.opened.push({ agent, key });
  }

  async startTurn(p: StartTurn): Promise<{ runId: string }> {
    this.calls.push(p);
    await this.beforeStart?.(p);
    const known = this.byKey.get(p.idempotencyKey);
    if (known !== undefined) return { runId: known };
    const runId = `fr_${++this.started}`;
    this.byKey.set(p.idempotencyKey, runId);
    this.runIds.add(runId);
    return { runId };
  }

  async readRunOutcome(runId: string): Promise<RunOutcome> {
    await this.beforeRead?.(runId);
    const set = this.outcomes.get(runId);
    if (set) return set;
    return this.runIds.has(runId) ? { state: "running" } : { state: "unknown" };
  }

  async abortTurn(runId: string): Promise<boolean> {
    this.aborted.push(runId);
    return true;
  }

  async deliver(sessionKey: string, message: string): Promise<void> {
    this.delivered.push({ sessionKey, message });
  }
}
