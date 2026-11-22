import type { Definition } from "../format/types.js";

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
  attempt: number;
  state: StageRunState;
  /** SHA-256 of the completion token; null once the token is retired. */
  tokenHash: string | null;
  idempotencyKey: string;
  adapterRunId: string | null;
  sessionKey: string | null;
  turnsUsed: number;
  deadlineAt: number | null;
  /** Creation time; the scheduler admits stage runs oldest first. */
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: string | null;
  fields: unknown;
  progressNote: string | null;
  runtime: RuntimeInfo | null;
  waitReason: string | null;
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
}

export interface LimitRow {
  scope: string;
  key: string;
  pausedUntil: number;
  reason: string;
  setAt: number;
}

/** Columns a compare-and-set may change on a run. */
export type RunPatch = Partial<
  Pick<RunRow, "status" | "currentStage" | "priority" | "updatedAt" | "endedAt">
>;

/** Columns a compare-and-set may change on a stage run. */
export type StageRunPatch = Partial<
  Omit<
    StageRunRow,
    "stageRunId" | "runId" | "stage" | "idempotencyKey" | "createdAt"
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
  /** Queue order: higher priority first, then oldest first. */
  listRuns(filter: {
    status?: RunStatus[];
    pipelineId?: string;
    limit: number;
  }): RunRow[];
  /** False when the run no longer matches `expect`; the caller re-reads. */
  updateRunIf(
    runId: string,
    expect: { status: RunStatus; currentStage: string },
    patch: RunPatch,
  ): boolean;

  insertStageRun(row: StageRunRow): void;
  getStageRun(stageRunId: string): StageRunRow | undefined;
  /** The newest stage run of the run that is submitted, working or input_required. */
  liveStageRun(runId: string): StageRunRow | undefined;
  /** Oldest first. */
  listStageRuns(filter: {
    state?: StageRunState[];
    limit: number;
  }): StageRunRow[];
  /** False when the stage run no longer matches `expect`; the caller re-reads. */
  updateStageRunIf(
    stageRunId: string,
    expect: { state: StageRunState; attempt: number },
    patch: StageRunPatch,
  ): boolean;
  findStageRunByTokenHash(hash: string): StageRunRow | undefined;

  /** Returns the new row id. */
  appendTransition(row: Omit<TransitionRow, "id">): number;
  /** Oldest first; with `limit`, the most recent `limit` rows, still oldest first. */
  transitions(runId: string, limit?: number): TransitionRow[];

  upsertGate(row: GateRow): void;
  getGate(stageRunId: string): GateRow | undefined;

  /** Limits still in force at `now`. */
  listLimits(now: number): LimitRow[];
  putLimit(row: LimitRow): void;
  clearLimit(scope: string, key: string): void;

  /** Completed stage runs of `stage` in the run that ended with `outcome`. */
  countOutcome(runId: string, stage: string, outcome: string): number;
  /** Stage runs ever created for `stage` in the run, across every visit. */
  countAttempts(runId: string, stage: string): number;
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
