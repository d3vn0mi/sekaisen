import type { Definition, RetryEnding } from "../format/types.js";

/** How the engine classified the end of a stage run that did not complete. */
export type Ending = RetryEnding | "usage_limited";

export type RunStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled";

export type StageRunState =
  | "submitted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

/** The provider and model of a stage run's last turn, as the adapter reported them. */
export interface RuntimeInfo {
  provider?: string;
  model?: string;
}

export interface DefinitionRow {
  pipelineId: string;
  hash: string;
  version: number;
  parsed: Definition;
  /** Brief texts by the path the definition names, so a pinned run renders its own version. */
  briefs: Record<string, string>;
  loadedAt: number;
}

export interface RunRow {
  runId: string;
  pipelineId: string;
  defHash: string;
  inputs: unknown;
  status: RunStatus;
  currentStage: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export interface StageRunRow {
  stageRunId: string;
  runId: string;
  stage: string;
  /** Cumulative attempt number for (run, stage) across every visit and retry. */
  attempt: number;
  /** How many times the run had entered the stage when this row was created; a retry keeps it. */
  visit: number;
  /** 0 for the first attempt of a visit, plus one per retry. */
  retryIndex: number;
  state: StageRunState;
  /**
   * SHA-256 of the completion token. It stays once the attempt ends, so a
   * late call is recognised and refused rather than taken as unknown.
   */
  tokenHash: string | null;
  /**
   * `${runId}:${stage}:${attempt}`, derived by the store on insert and
   * immutable; the definition's cancel action is keyed `${runId}:cancel`.
   */
  idempotencyKey: string;
  adapterRunId: string | null;
  sessionKey: string | null;
  turnsUsed: number;
  /** Turns dispatched on this row; bumped in the transaction that records each start. */
  dispatchSeq: number;
  deadlineAt: number | null;
  /** Creation time; the scheduler admits stage runs oldest first. */
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: string | null;
  /** The engine-classified ending of a non-completed attempt; unset otherwise. */
  ending?: Ending;
  fields: unknown;
  progressNote: string | null;
  /** When the last progress note was written. */
  progressAt: number | null;
  /** The dispatch sequence the last progress note was written under. */
  progressSeq: number | null;
  /**
   * When the turn now in flight was recorded as started; null when no turn
   * is in flight, or once the engine has read that turn's end.
   */
  dispatchedAt: number | null;
  /**
   * When a provider or policy pause began holding this submitted stage run;
   * null when nothing holds it. The held span is added to the deadline on
   * release.
   */
  heldSince: number | null;
  runtime: RuntimeInfo | null;
  waitReason: string | null;
  /**
   * When the tick next runs this stage run itself: set for every stage type
   * but `agent` while the stage run is live (a new check or action, a wait's
   * wake time, a gate's next poll, reminder or timeout); null otherwise.
   */
  wakeAt: number | null;
  /**
   * A harness turn the engine decided to abort and has not yet heard back
   * about; null when none. Kept in the store so a restart, or a harness
   * whose capabilities cannot be read yet, does not lose the request.
   */
  abortRunId: string | null;
  /** Abort calls for `abortRunId` that failed so far. */
  abortAttempts: number;
  /** When the abort of `abortRunId` is next asked for; null when none is pending. */
  abortNextAt: number | null;
  /**
   * When the tick last took this stage run's turn up to read; null when it
   * never has. Turns in flight are read least recently observed first, so
   * every one of them is read in turn however many there are.
   */
  observedAt: number | null;
  /**
   * The error of the last failed attempt to start this stage run's turn;
   * null once a turn starts. A repeat of the same error is not logged again.
   */
  startError: string | null;
}

export interface TransitionRow {
  id: number;
  runId: string;
  stageRunId: string | null;
  fromState: string | null;
  toState: string;
  event: string;
  outcome: string | null;
  actor: string;
  at: number;
  detail: unknown;
}

export interface GateRow {
  stageRunId: string;
  kind: string;
  waitingOn: string;
  remindAt: number | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  prompt: string | null;
  outcomes: string[] | null;
  /** A poll gate's next poll; null for an operator gate. */
  pollAt: number | null;
  /** Polls in a row whose fact threw; 0 after any poll that answered. */
  pollFailures: number;
  /** The error text of the last poll that threw. */
  pollError: string | null;
}

export interface LimitRow {
  scope: string;
  key: string;
  pausedUntil: number;
  reason: string;
  setAt: number;
}

/** A stage run as a caller supplies it; the store adds the idempotency key (see `insertStageRun`). */
export type NewStageRun = Omit<StageRunRow, "idempotencyKey">;

/** How the store keys a new stage run. */
export interface InsertStageRunOptions {
  /**
   * Key the row `${runId}:cancel` instead of by attempt: the one run of the
   * definition's cancel action. The key is unique, so it runs once per run.
   */
  cancelAction?: boolean;
}

/** Columns a compare-and-set may change on a run. */
export type RunPatch = Partial<
  Pick<RunRow, "status" | "currentStage" | "priority" | "updatedAt" | "endedAt">
>;

/** Columns a compare-and-set may change on a stage run. */
export type StageRunPatch = Partial<
  Omit<
    StageRunRow,
    | "stageRunId"
    | "runId"
    | "stage"
    | "attempt"
    | "visit"
    | "retryIndex"
    | "idempotencyKey"
    | "createdAt"
  >
>;

/**
 * Everything the engine does to storage. There is deliberately no update or
 * delete for transitions: the log only grows.
 */
export interface StoreTx {
  /** Records a definition version; a hash already stored is left untouched. */
  putDefinition(row: DefinitionRow): void;
  getDefinition(pipelineId: string, hash: string): DefinitionRow | undefined;

  insertRun(row: RunRow): void;
  getRun(runId: string): RunRow | undefined;
  /**
   * Queue order (the default): higher priority first, then oldest first.
   * `order: "recent"` lists the most recently updated first instead.
   */
  listRuns(filter: {
    status?: RunStatus[];
    pipelineId?: string;
    order?: "queue" | "recent";
    limit: number;
  }): RunRow[];
  /** False when the run no longer matches `expect`; the caller re-reads. */
  updateRunIf(
    runId: string,
    expect: { status: RunStatus; currentStage: string },
    patch: RunPatch,
  ): boolean;

  /**
   * The store derives `idempotencyKey` from run, stage and attempt, except
   * for the cancel action (`opts.cancelAction`), keyed `${runId}:cancel`.
   */
  insertStageRun(row: NewStageRun, opts?: InsertStageRunOptions): void;
  getStageRun(stageRunId: string): StageRunRow | undefined;
  /** The newest stage run of the run that is submitted, working or input_required. */
  liveStageRun(runId: string): StageRunRow | undefined;
  /** The stage run of one visit's retry index, or undefined when there is none. */
  findStageRun(key: {
    runId: string;
    stage: string;
    visit: number;
    retryIndex: number;
  }): StageRunRow | undefined;
  /**
   * Oldest first. `inFlight` keeps only stage runs with a turn in flight,
   * least recently observed first (never observed before any).
   * `wakes: false` keeps only stage runs without a wake time (agent stages).
   * `wakeBy` keeps only stage runs whose wake time is at or before it, and
   * orders them by wake time, earliest first. `abortDueBy` keeps only stage
   * runs with a harness turn to abort whose next attempt is due at or before
   * it, and orders them by that time, earliest first.
   */
  listStageRuns(filter: {
    /** Keeps only the stage runs of this run. */
    runId?: string;
    state?: StageRunState[];
    inFlight?: boolean;
    wakes?: false;
    wakeBy?: number;
    abortDueBy?: number;
    limit: number;
  }): StageRunRow[];
  /** False when the stage run no longer matches `expect`; the caller re-reads. */
  updateStageRunIf(
    stageRunId: string,
    expect: { state: StageRunState; attempt: number },
    patch: StageRunPatch,
  ): boolean;
  findStageRunByTokenHash(hash: string): StageRunRow | undefined;
  /**
   * Submitted stage runs without a wake time (agent stages) of working runs,
   * in admission order: higher run priority first, then oldest first, then
   * by stage run id. `offset` skips that many, for the next page.
   */
  listDispatchable(limit: number, offset?: number): StageRunRow[];
  /**
   * Every working stage run without a wake time (agent stages), oldest
   * first. Unbounded, so a count of the turns taking a lane is never short.
   */
  listWorking(): StageRunRow[];
  /**
   * Every stage run not working that may still hold a harness turn: one
   * completed with a turn in flight, or one with an abort pending. Oldest
   * first and unbounded, like `listWorking`.
   */
  listLaneHolders(): StageRunRow[];
  /**
   * Every working agent stage run with a harness turn in flight, by id,
   * oldest first. Ids only and unbounded, so a restart sees all of them.
   */
  inFlightTurnIds(): string[];

  /** Returns the new row id. */
  appendTransition(row: Omit<TransitionRow, "id">): number;
  /** Oldest first; with `limit`, the most recent `limit` rows, still oldest first. */
  transitions(runId: string, limit?: number): TransitionRow[];

  upsertGate(row: GateRow): void;
  getGate(stageRunId: string): GateRow | undefined;

  /** Limits still in force at `now`. */
  listLimits(now: number): LimitRow[];
  /** Upserts a limit; a pause in force is never shortened (the later end wins). */
  putLimit(row: LimitRow): void;
  clearLimit(scope: string, key: string): void;

  /** The most recently completed stage run of `stage` in the run. */
  latestCompleted(runId: string, stage: string): StageRunRow | undefined;
  /** Highest attempt number used for `stage` in the run; 0 when none. */
  maxAttempt(runId: string, stage: string): number;
  /** Highest visit number recorded for `stage` in the run; 0 when none. */
  countVisits(runId: string, stage: string): number;
  /** Completed stage runs of `stage` in the run that ended with `outcome`. */
  countOutcome(runId: string, stage: string, outcome: string): number;
  /** Stage runs ever created for `stage` in the run, across every visit. */
  countAttempts(runId: string, stage: string): number;
}

/**
 * The key handed to the harness for the `dispatchSeq`-th turn on a stage run:
 * the base key for the first, `${base}:${n}` after that.
 */
export function turnKey(base: string, dispatchSeq: number): string {
  return dispatchSeq <= 1 ? base : `${base}:${dispatchSeq}`;
}

/** A transaction body is synchronous: a Promise-returning function does not type-check. */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface Store {
  /**
   * Runs `fn` in one immediate transaction: commit on return, roll back and
   * rethrow on throw. A call made inside `fn` joins the open transaction.
   */
  tx<T>(fn: (t: StoreTx) => SyncResult<T>): T;
  close(): void;
}

export interface OpenOptions {
  /** Refuse every write; the file must already exist. */
  readonly?: boolean;
}
