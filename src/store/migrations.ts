/**
 * Schema steps, applied in order. Step N takes a store from version N-1 to N,
 * so the schema version is the length of this list. Never edit a shipped step;
 * append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE definitions (
    pipeline_id TEXT NOT NULL,
    hash        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    parsed_json TEXT NOT NULL,
    briefs_json TEXT NOT NULL,
    loaded_at   INTEGER NOT NULL,
    PRIMARY KEY (pipeline_id, hash)
  );

  CREATE TABLE runs (
    run_id        TEXT PRIMARY KEY,
    pipeline_id   TEXT NOT NULL,
    def_hash      TEXT NOT NULL,
    inputs_json   TEXT NOT NULL,
    status        TEXT NOT NULL,
    current_stage TEXT NOT NULL,
    priority      INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    FOREIGN KEY (pipeline_id, def_hash) REFERENCES definitions (pipeline_id, hash)
  );
  CREATE INDEX runs_queue ON runs (status, priority, created_at);

  CREATE TABLE stage_runs (
    stage_run_id    TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs (run_id),
    stage           TEXT NOT NULL,
    attempt         INTEGER NOT NULL,
    visit           INTEGER NOT NULL,
    retry_index     INTEGER NOT NULL,
    dispatch_seq    INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL,
    token_hash      TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    adapter_run_id  TEXT,
    session_key     TEXT,
    turns_used      INTEGER NOT NULL,
    deadline_at     INTEGER,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    ended_at        INTEGER,
    outcome         TEXT,
    ending          TEXT,
    fields_json     TEXT,
    progress_note   TEXT,
    progress_at     INTEGER,
    progress_seq    INTEGER,
    dispatched_at   INTEGER,
    held_since      INTEGER,
    runtime_json    TEXT,
    wait_reason     TEXT,
    wake_at         INTEGER,
    abort_run_id    TEXT
  );
  CREATE INDEX stage_runs_state ON stage_runs (state);
  CREATE INDEX stage_runs_token_hash ON stage_runs (token_hash);
  CREATE INDEX stage_runs_run ON stage_runs (run_id, stage);
  CREATE INDEX stage_runs_in_flight ON stage_runs (dispatched_at)
    WHERE dispatched_at IS NOT NULL;
  CREATE INDEX stage_runs_wake ON stage_runs (wake_at)
    WHERE wake_at IS NOT NULL;
  CREATE INDEX stage_runs_abort ON stage_runs (abort_run_id)
    WHERE abort_run_id IS NOT NULL;

  CREATE TABLE transitions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs (run_id),
    stage_run_id TEXT REFERENCES stage_runs (stage_run_id),
    from_state   TEXT,
    to_state     TEXT NOT NULL,
    event        TEXT NOT NULL,
    outcome      TEXT,
    actor        TEXT NOT NULL,
    at           INTEGER NOT NULL,
    detail_json  TEXT
  );
  CREATE INDEX transitions_run ON transitions (run_id, id);

  CREATE TABLE gates (
    stage_run_id  TEXT PRIMARY KEY REFERENCES stage_runs (stage_run_id),
    kind          TEXT NOT NULL,
    waiting_on    TEXT NOT NULL,
    remind_at     INTEGER,
    resolved_by   TEXT,
    resolved_at   INTEGER,
    prompt        TEXT,
    outcomes_json TEXT,
    poll_at       INTEGER,
    poll_failures INTEGER NOT NULL DEFAULT 0,
    poll_error    TEXT
  );

  CREATE TABLE limits (
    scope        TEXT NOT NULL,
    key          TEXT NOT NULL,
    paused_until INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    set_at       INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
