import { existsSync } from "node:fs";
import {
  DatabaseSync,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
import { VERSION } from "../index.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.js";
import type {
  DefinitionRow,
  GateRow,
  LimitRow,
  OpenOptions,
  RunPatch,
  RunRow,
  RunStatus,
  StageRunPatch,
  StageRunRow,
  StageRunState,
  Store,
  StoreTx,
  SyncResult,
  TransitionRow,
} from "./types.js";

type Row = Record<string, unknown>;
type Param = string | number | null;

const LIVE_STATES = ["submitted", "working", "input_required"];

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  currentStage: "current_stage",
  priority: "priority",
  updatedAt: "updated_at",
  endedAt: "ended_at",
};

const STAGE_RUN_COLUMNS: Record<keyof StageRunPatch, string> = {
  state: "state",
  tokenHash: "token_hash",
  adapterRunId: "adapter_run_id",
  sessionKey: "session_key",
  turnsUsed: "turns_used",
  dispatchSeq: "dispatch_seq",
  deadlineAt: "deadline_at",
  startedAt: "started_at",
  endedAt: "ended_at",
  outcome: "outcome",
  fields: "fields_json",
  progressNote: "progress_note",
  runtime: "runtime_json",
  waitReason: "wait_reason",
};

const JSON_PATCH_KEYS = new Set(["fields", "runtime"]);

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson(text: unknown): unknown {
  return typeof text === "string" ? JSON.parse(text) : null;
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function runFromRow(r: Row): RunRow {
  return {
    runId: r.run_id as string,
    pipelineId: r.pipeline_id as string,
    defHash: r.def_hash as string,
    inputs: fromJson(r.inputs_json),
    status: r.status as RunStatus,
    currentStage: r.current_stage as string,
    priority: r.priority as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    endedAt: r.ended_at as number | null,
  };
}

function stageRunFromRow(r: Row): StageRunRow {
  return {
    stageRunId: r.stage_run_id as string,
    runId: r.run_id as string,
    stage: r.stage as string,
    attempt: r.attempt as number,
    visit: r.visit as number,
    retryIndex: r.retry_index as number,
    state: r.state as StageRunState,
    tokenHash: r.token_hash as string | null,
    idempotencyKey: r.idempotency_key as string,
    adapterRunId: r.adapter_run_id as string | null,
    sessionKey: r.session_key as string | null,
    turnsUsed: r.turns_used as number,
    dispatchSeq: r.dispatch_seq as number,
    deadlineAt: r.deadline_at as number | null,
    createdAt: r.created_at as number,
    startedAt: r.started_at as number | null,
    endedAt: r.ended_at as number | null,
    outcome: r.outcome as string | null,
    fields: fromJson(r.fields_json),
    progressNote: r.progress_note as string | null,
    runtime: fromJson(r.runtime_json) as StageRunRow["runtime"],
    waitReason: r.wait_reason as string | null,
  };
}

function transitionFromRow(r: Row): TransitionRow {
  return {
    id: r.id as number,
    runId: r.run_id as string,
    stageRunId: r.stage_run_id as string | null,
    fromState: r.from_state as string | null,
    toState: r.to_state as string,
    event: r.event as string,
    outcome: r.outcome as string | null,
    actor: r.actor as string,
    at: r.at as number,
    detail: fromJson(r.detail_json),
  };
}

function gateFromRow(r: Row): GateRow {
  return {
    stageRunId: r.stage_run_id as string,
    kind: r.kind as string,
    waitingOn: r.waiting_on as string,
    remindAt: r.remind_at as number | null,
    resolvedBy: r.resolved_by as string | null,
    resolvedAt: r.resolved_at as number | null,
    prompt: r.prompt as string | null,
    outcomes: fromJson(r.outcomes_json) as string[] | null,
  };
}

function limitFromRow(r: Row): LimitRow {
  return {
    scope: r.scope as string,
    key: r.key as string,
    pausedUntil: r.paused_until as number,
    reason: r.reason as string,
    setAt: r.set_at as number,
  };
}

function definitionFromRow(r: Row): DefinitionRow {
  return {
    pipelineId: r.pipeline_id as string,
    hash: r.hash as string,
    version: r.version as number,
    parsed: fromJson(r.parsed_json) as DefinitionRow["parsed"],
    loadedAt: r.loaded_at as number,
  };
}

/** Builds `SET a = ?, b = ?` from a patch, refusing keys that are not patchable. */
function buildSet(
  patch: object,
  columns: Record<string, string>,
): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
    if (!column) throw new Error(`cannot update column "${key}"`);
    parts.push(`${column} = ?`);
    params.push(
      JSON_PATCH_KEYS.has(key) ? toJson(value) : (value as Param | null),
    );
  }
  if (parts.length === 0) throw new Error("update has no columns to change");
  return { sql: parts.join(", "), params };
}

class SqliteTx implements StoreTx {
  private readonly cache = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly active: () => boolean,
  ) {}

  private stmt(sql: string): StatementSync {
    if (!this.active()) {
      throw new Error("store calls must run inside a transaction");
    }
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: Param[]): StatementResultingChanges {
    return this.stmt(sql).run(...params);
  }

  putDefinition(row: DefinitionRow): void {
    this.run(
      `INSERT OR IGNORE INTO definitions
         (pipeline_id, hash, version, parsed_json, loaded_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.pipelineId,
      row.hash,
      row.version,
      JSON.stringify(row.parsed),
      row.loadedAt,
    );
  }

  getDefinition(pipelineId: string, hash: string): DefinitionRow | undefined {
    const r = this.get(
      "SELECT * FROM definitions WHERE pipeline_id = ? AND hash = ?",
      pipelineId,
      hash,
    );
    return r && definitionFromRow(r);
  }

  insertRun(row: RunRow): void {
    this.run(
      `INSERT INTO runs
         (run_id, pipeline_id, def_hash, inputs_json, status, current_stage,
          priority, created_at, updated_at, ended_at)
       VALUES (${placeholders(10)})`,
      row.runId,
      row.pipelineId,
      row.defHash,
      JSON.stringify(row.inputs ?? null),
      row.status,
      row.currentStage,
      row.priority,
      row.createdAt,
      row.updatedAt,
      row.endedAt,
    );
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.get("SELECT * FROM runs WHERE run_id = ?", runId);
    return r && runFromRow(r);
  }

  listRuns(filter: {
    status?: RunStatus[];
    pipelineId?: string;
    limit: number;
  }): RunRow[] {
    checkLimit(filter.limit);
    const where: string[] = [];
    const params: Param[] = [];
    if (filter.status) {
      where.push(`status IN (${placeholders(filter.status.length)})`);
      params.push(...filter.status);
    }
    if (filter.pipelineId !== undefined) {
      where.push("pipeline_id = ?");
      params.push(filter.pipelineId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(
      `SELECT * FROM runs ${clause}
       ORDER BY priority DESC, created_at ASC, run_id ASC LIMIT ?`,
      ...params,
      filter.limit,
    ).map(runFromRow);
  }

  updateRunIf(
    runId: string,
    expect: { status: RunStatus; currentStage: string },
    patch: RunPatch,
  ): boolean {
    const set = buildSet(patch, RUN_COLUMNS);
    const result = this.run(
      `UPDATE runs SET ${set.sql}
       WHERE run_id = ? AND status = ? AND current_stage = ?`,
      ...set.params,
      runId,
      expect.status,
      expect.currentStage,
    );
    return Number(result.changes) === 1;
  }

  insertStageRun(row: StageRunRow): void {
    this.run(
      `INSERT INTO stage_runs
         (stage_run_id, run_id, stage, attempt, visit, retry_index, state,
          token_hash, idempotency_key, adapter_run_id, session_key, turns_used,
          dispatch_seq,
          deadline_at, created_at, started_at, ended_at, outcome, fields_json,
          progress_note, runtime_json, wait_reason)
       VALUES (${placeholders(22)})`,
      row.stageRunId,
      row.runId,
      row.stage,
      row.attempt,
      row.visit,
      row.retryIndex,
      row.state,
      row.tokenHash,
      row.idempotencyKey,
      row.adapterRunId,
      row.sessionKey,
      row.turnsUsed,
      row.dispatchSeq,
      row.deadlineAt,
      row.createdAt,
      row.startedAt,
      row.endedAt,
      row.outcome,
      toJson(row.fields),
      row.progressNote,
      toJson(row.runtime),
      row.waitReason,
    );
  }

  getStageRun(stageRunId: string): StageRunRow | undefined {
    const r = this.get(
      "SELECT * FROM stage_runs WHERE stage_run_id = ?",
      stageRunId,
    );
    return r && stageRunFromRow(r);
  }

  liveStageRun(runId: string): StageRunRow | undefined {
    const r = this.get(
      `SELECT * FROM stage_runs
       WHERE run_id = ? AND state IN (${placeholders(LIVE_STATES.length)})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      runId,
      ...LIVE_STATES,
    );
    return r && stageRunFromRow(r);
  }

  listStageRuns(filter: {
    state?: StageRunState[];
    limit: number;
  }): StageRunRow[] {
    checkLimit(filter.limit);
    const params: Param[] = [];
    let clause = "";
    if (filter.state) {
      clause = `WHERE state IN (${placeholders(filter.state.length)})`;
      params.push(...filter.state);
    }
    return this.all(
      `SELECT * FROM stage_runs ${clause}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      ...params,
      filter.limit,
    ).map(stageRunFromRow);
  }

  updateStageRunIf(
    stageRunId: string,
    expect: { state: StageRunState; attempt: number },
    patch: StageRunPatch,
  ): boolean {
    const set = buildSet(patch, STAGE_RUN_COLUMNS);
    const result = this.run(
      `UPDATE stage_runs SET ${set.sql}
       WHERE stage_run_id = ? AND state = ? AND attempt = ?`,
      ...set.params,
      stageRunId,
      expect.state,
      expect.attempt,
    );
    return Number(result.changes) === 1;
  }

  findStageRunByTokenHash(hash: string): StageRunRow | undefined {
    const r = this.get("SELECT * FROM stage_runs WHERE token_hash = ?", hash);
    return r && stageRunFromRow(r);
  }

  appendTransition(row: Omit<TransitionRow, "id">): number {
    const result = this.run(
      `INSERT INTO transitions
         (run_id, stage_run_id, from_state, to_state, event, outcome, actor,
          at, detail_json)
       VALUES (${placeholders(9)})`,
      row.runId,
      row.stageRunId,
      row.fromState,
      row.toState,
      row.event,
      row.outcome,
      row.actor,
      row.at,
      toJson(row.detail),
    );
    return Number(result.lastInsertRowid);
  }

  transitions(runId: string, limit?: number): TransitionRow[] {
    if (limit !== undefined) checkLimit(limit);
    return this.all(
      `SELECT * FROM (
         SELECT * FROM transitions WHERE run_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
      runId,
      limit ?? -1,
    ).map(transitionFromRow);
  }

  upsertGate(row: GateRow): void {
    this.run(
      `INSERT INTO gates
         (stage_run_id, kind, waiting_on, remind_at, resolved_by, resolved_at,
          prompt, outcomes_json)
       VALUES (${placeholders(8)})
       ON CONFLICT (stage_run_id) DO UPDATE SET
         kind = excluded.kind,
         waiting_on = excluded.waiting_on,
         remind_at = excluded.remind_at,
         resolved_by = excluded.resolved_by,
         resolved_at = excluded.resolved_at,
         prompt = excluded.prompt,
         outcomes_json = excluded.outcomes_json`,
      row.stageRunId,
      row.kind,
      row.waitingOn,
      row.remindAt,
      row.resolvedBy,
      row.resolvedAt,
      row.prompt,
      toJson(row.outcomes),
    );
  }

  getGate(stageRunId: string): GateRow | undefined {
    const r = this.get(
      "SELECT * FROM gates WHERE stage_run_id = ?",
      stageRunId,
    );
    return r && gateFromRow(r);
  }

  listLimits(now: number): LimitRow[] {
    return this.all(
      "SELECT * FROM limits WHERE paused_until > ? ORDER BY scope, key",
      now,
    ).map(limitFromRow);
  }

  putLimit(row: LimitRow): void {
    this.run(
      `INSERT INTO limits (scope, key, paused_until, reason, set_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET
         paused_until = excluded.paused_until,
         reason = excluded.reason,
         set_at = excluded.set_at`,
      row.scope,
      row.key,
      row.pausedUntil,
      row.reason,
      row.setAt,
    );
  }

  clearLimit(scope: string, key: string): void {
    this.run("DELETE FROM limits WHERE scope = ? AND key = ?", scope, key);
  }

  countOutcome(runId: string, stage: string, outcome: string): number {
    const r = this.get(
      `SELECT COUNT(*) AS n FROM stage_runs
       WHERE run_id = ? AND stage = ? AND state = 'completed' AND outcome = ?`,
      runId,
      stage,
      outcome,
    );
    return Number(r?.n ?? 0);
  }

  maxAttempt(runId: string, stage: string): number {
    const r = this.get(
      "SELECT MAX(attempt) AS n FROM stage_runs WHERE run_id = ? AND stage = ?",
      runId,
      stage,
    );
    return Number(r?.n ?? 0);
  }

  countVisits(runId: string, stage: string): number {
    const r = this.get(
      "SELECT MAX(visit) AS n FROM stage_runs WHERE run_id = ? AND stage = ?",
      runId,
      stage,
    );
    return Number(r?.n ?? 0);
  }

  countAttempts(runId: string, stage: string): number {
    const r = this.get(
      "SELECT COUNT(*) AS n FROM stage_runs WHERE run_id = ? AND stage = ?",
      runId,
      stage,
    );
    return Number(r?.n ?? 0);
  }
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

class SqliteStore implements Store {
  private readonly txApi: SqliteTx;
  private depth = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly readonly: boolean,
  ) {
    this.txApi = new SqliteTx(db, () => this.depth > 0);
  }

  tx<T>(fn: (t: StoreTx) => SyncResult<T>): T {
    if (this.depth > 0) return this.inline(fn);
    // A read-only handle never needs the write lock.
    this.db.exec(this.readonly ? "BEGIN" : "BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = this.inline(fn);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failed statement already ended the transaction.
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  private inline<T>(fn: (t: StoreTx) => SyncResult<T>): T {
    const result = fn(this.txApi);
    if (isThenable(result)) {
      throw new TypeError("a store transaction must be synchronous");
    }
    return result as T;
  }

  close(): void {
    this.db.close();
  }
}

function currentVersion(db: DatabaseSync): number {
  const hasMeta = db
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'",
    )
    .get();
  if (!hasMeta) return 0;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(db: DatabaseSync): void {
  // Read the version under the write lock: another process may be creating
  // the same file at the same moment.
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = currentVersion(db);
    assertNotNewer(from);
    for (let v = from; v < SCHEMA_VERSION; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(String(v + 1));
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed statement already ended the transaction.
    }
    throw err;
  }
}

function assertNotNewer(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `store schema ${version} is newer than this engine (${SCHEMA_VERSION})`,
    );
  }
}

/**
 * Opens (creating and migrating, unless read-only) the store at `path`.
 * Refuses a store written by a newer engine.
 */
export function openSqliteStore(
  path: string | ":memory:",
  options: OpenOptions = {},
): Store {
  const readonly = options.readonly === true;
  if (readonly && path !== ":memory:" && !existsSync(path)) {
    throw new Error(`store ${path} does not exist`);
  }
  if (readonly && path === ":memory:") {
    throw new Error("an in-memory store cannot be opened read-only");
  }
  const db = new DatabaseSync(path, { readOnly: readonly });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (readonly) {
      db.exec("PRAGMA query_only = ON");
    } else {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
    }
    const version = currentVersion(db);
    assertNotNewer(version);
    if (readonly) {
      if (version < SCHEMA_VERSION) {
        throw new Error(
          `store schema ${version} is older than this engine (${SCHEMA_VERSION}); open it once without readonly to migrate`,
        );
      }
    } else {
      migrate(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('engine_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(VERSION);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return new SqliteStore(db, readonly);
}
