import type { Capabilities, HarnessAdapter } from "../adapter/types.js";
import { validateJson } from "../format/jsonschema.js";
import type { LoadedDefinition } from "../format/load.js";
import type { AgentStage, Definition, Next, Stage } from "../format/types.js";
import { evalGuard, type GuardContext } from "../guard/eval.js";
import { type GuardAst, parseGuard } from "../guard/parse.js";
import type { HostRegistry } from "../host/registry.js";
import type {
  GateRow,
  RunRow,
  RunStatus,
  StageRunRow,
  StageRunState,
  Store,
  StoreTx,
  SyncResult,
  TransitionRow,
} from "../store/types.js";
import { turnKey } from "../store/types.js";
import {
  fieldsShorthand,
  outcomesList,
  renderBrief,
  renderContinuation,
} from "./brief.js";
import { type Clock, systemClock } from "./clock.js";
import { newRunId, newStageRunId } from "./ids.js";
import { hashesEqual, hashToken, mintToken } from "./tokens.js";

/** Where the engine finds the definition a new run starts on. */
export interface DefinitionSource {
  current(pipelineId: string): LoadedDefinition | undefined;
}

export interface EngineOptions {
  store: Store;
  adapter: HarnessAdapter;
  registry: HostRegistry;
  clock?: Clock;
  /** Milliseconds between ticks; 5000 by default. */
  tickMs?: number;
  definitions: DefinitionSource;
  /**
   * False runs the engine for completions only: no tick loop and no turns
   * started. True by default.
   */
  dispatch?: boolean;
}

export interface CompleteParams {
  token: string;
  outcome: string;
  fields?: unknown;
  artifacts?: string[];
  /** The agent the harness says is calling; checked against the stage's agent when given. */
  callerAgent?: string;
}

/**
 * `next` is the stage the run moved to (an `end` stage's id when the run
 * ended there), or null when the run failed without reaching one.
 */
export type CompletionResult =
  | { ok: true; next: string | null; applied: "now" | "already" }
  | { ok: false; error: string };

export interface RunStatusView {
  run: RunRow;
  live?: StageRunRow;
  gate?: GateRow;
  /** The most recent 20, oldest first. */
  transitions: TransitionRow[];
}

export interface EngineEvents {
  stage_changed: {
    runId: string;
    stageRunId: string;
    stage: string;
    from: StageRunState | null;
    to: StageRunState;
  };
  run_ended: { runId: string; status: RunStatus; stage: string };
  gate: {
    runId: string;
    stageRunId: string;
    stage: string;
    prompt: string | null;
    outcomes: string[];
  };
}

export type EngineEvent = keyof EngineEvents;

export interface Disposable {
  dispose(): void;
}

/** The tools a dispatched turn needs to report back. */
export const COMPLETION_TOOLS = ["stage_complete", "stage_progress"];

/** Largest `fields` object a completion may carry, as JSON. */
export const MAX_FIELDS_BYTES = 64 * 1024;
/** Largest progress note. */
export const MAX_NOTE_BYTES = 64 * 1024;

const DEFAULT_TICK_MS = 5000;
const TICK_BATCH = 100;
const ENGINE = "engine";

type Draft = Omit<TransitionRow, "id" | "runId" | "at">;
type Emit = Array<() => void>;

/** A definition version a run is pinned to, with its parsed guards. */
interface Pinned {
  def: Definition;
  briefs: Record<string, string>;
  guards: Map<string, GuardAst | Error>;
}

/** A dispatch whose turn was not yet recorded, kept to resend it unchanged. */
interface PendingDispatch {
  dispatchSeq: number;
  tokenHash: string;
  message: string;
}

interface Prepared {
  stageRunId: string;
  attempt: number;
  dispatchSeq: number;
  agent: string;
  sessionKey: string;
  message: string;
  capMs: number;
  idempotencyKey: string;
}

const fail = (error: string): CompletionResult => ({ ok: false, error });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with object keys sorted, so equal values compare equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function descend(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split(".")) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `next` an outcome of a stage leads to, whatever the stage type. */
function nextOf(stage: Stage, outcome: string): Next | undefined {
  switch (stage.type) {
    case "agent":
    case "gate":
      return Object.hasOwn(stage.outcomes, outcome)
        ? stage.outcomes[outcome]?.next
        : undefined;
    case "check":
      return Object.hasOwn(stage.outcomes, outcome)
        ? stage.outcomes[outcome]
        : undefined;
    case "action":
    case "wait":
      return stage.next;
    case "end":
      return undefined;
  }
}

export class Engine {
  private readonly store: Store;
  private readonly adapter: HarnessAdapter;
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly dispatching: boolean;
  private readonly pinnedCache = new Map<string, Pinned>();
  private readonly pending = new Map<string, PendingDispatch>();
  private readonly listeners = new Map<EngineEvent, Set<(e: never) => void>>();
  private caps?: Promise<Capabilities>;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;

  constructor(private readonly o: EngineOptions) {
    this.store = o.store;
    this.adapter = o.adapter;
    this.clock = o.clock ?? systemClock;
    this.tickMs = o.tickMs ?? DEFAULT_TICK_MS;
    this.dispatching = o.dispatch !== false;
  }

  /** Reconciles stored work, then ticks every `tickMs` unless dispatch is off. */
  async start(): Promise<void> {
    await this.reconcile();
    if (!this.dispatching || this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.report(err));
    }, this.tickMs);
    this.timer.unref?.();
    this.tick().catch((err) => this.report(err));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => undefined);
  }

  /** One pass over the work. Concurrent calls share the pass in flight. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.walk().finally(() => {
        this.ticking = undefined;
      });
    }
    return this.ticking;
  }

  async startRun(
    pipelineId: string,
    inputs: unknown,
    opts: { priority?: number; actor?: string } = {},
  ): Promise<{ runId: string }> {
    const loaded = this.o.definitions.current(pipelineId);
    if (!loaded) throw new Error(`no definition is loaded for ${pipelineId}`);
    if (loaded.problems.length > 0) {
      throw new Error(
        `definition ${pipelineId} has problems: ${loaded.problems.join("; ")}`,
      );
    }
    const { def } = loaded;
    const given = inputs === undefined ? {} : inputs;
    const errors = def.inputs
      ? validateJson(def.inputs, given)
      : isPlainObject(given)
        ? []
        : ["inputs must be an object"];
    if (errors.length > 0) {
      throw new Error(`invalid inputs: ${errors.slice(0, 10).join("; ")}`);
    }
    const actor = opts.actor ?? "api";
    const runId = newRunId();
    this.commit((t, emit) => {
      const now = this.clock.now();
      t.putDefinition({
        pipelineId,
        hash: loaded.hash,
        version: def.version,
        parsed: def,
        briefs: loaded.briefs,
        loadedAt: now,
      });
      const run: RunRow = {
        runId,
        pipelineId,
        defHash: loaded.hash,
        inputs: given,
        status: "working",
        currentStage: def.start,
        priority: opts.priority ?? def.defaults?.priority ?? 0,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      t.insertRun(run);
      t.appendTransition({
        runId,
        stageRunId: null,
        fromState: null,
        toState: "working",
        event: "run_created",
        outcome: null,
        actor,
        at: now,
        detail: { pipeline: pipelineId, hash: loaded.hash },
      });
      this.enter(t, run, def.start, actor, emit);
    });
    return { runId };
  }

  async complete(p: CompleteParams): Promise<CompletionResult> {
    if (typeof p.token !== "string" || p.token === "") {
      return fail("token is required");
    }
    if (typeof p.outcome !== "string" || p.outcome === "") {
      return fail("outcome is required");
    }
    return this.commit((t, emit) => {
      const found = this.byToken(t, p.token, p.callerAgent);
      if (found.kind === "refused") return fail(found.error);
      if (found.kind === "completed") return this.repeated(t, found.row, p);
      const { row, run, stage } = found;
      const outcome = stage.outcomes[p.outcome];
      if (!Object.hasOwn(stage.outcomes, p.outcome) || !outcome) {
        return fail(
          `unknown outcome "${p.outcome}". Declared outcomes:\n${outcomesList(stage.outcomes)}`,
        );
      }
      const fields = p.fields === undefined ? {} : p.fields;
      const invalid = this.checkFields(p.outcome, outcome.fields, fields);
      if (invalid) return fail(invalid);

      const now = this.clock.now();
      const ok = t.updateStageRunIf(
        row.stageRunId,
        { state: row.state, attempt: row.attempt },
        { state: "completed", outcome: p.outcome, fields, endedAt: now },
      );
      if (!ok) return fail("the stage changed meanwhile; call again");
      emit.push(() =>
        this.emit("stage_changed", {
          runId: run.runId,
          stageRunId: row.stageRunId,
          stage: row.stage,
          from: row.state,
          to: "completed",
        }),
      );
      const detail = p.artifacts?.length ? { artifacts: p.artifacts } : {};
      const next = this.advance(
        t,
        run,
        row,
        p.outcome,
        {
          stageRunId: row.stageRunId,
          fromState: row.state,
          toState: "completed",
          event: "stage_completed",
          outcome: p.outcome,
          actor: `agent:${stage.agent}`,
          detail,
        },
        emit,
      );
      return { ok: true, next, applied: "now" };
    });
  }

  async progress(p: {
    token: string;
    note: string;
    callerAgent?: string;
  }): Promise<CompletionResult> {
    if (typeof p.token !== "string" || p.token === "") {
      return fail("token is required");
    }
    if (typeof p.note !== "string" || p.note.trim() === "") {
      return fail("note is required: say what is done and what is next");
    }
    if (Buffer.byteLength(p.note) > MAX_NOTE_BYTES) {
      return fail("note is larger than 64 KiB; shorten it");
    }
    return this.commit((t) => {
      const found = this.byToken(t, p.token, p.callerAgent);
      if (found.kind === "refused") return fail(found.error);
      if (found.kind === "completed") {
        return fail(
          `this stage was already completed with outcome ${found.row.outcome}`,
        );
      }
      const { row, stage } = found;
      const ok = t.updateStageRunIf(
        row.stageRunId,
        { state: row.state, attempt: row.attempt },
        { progressNote: p.note },
      );
      if (!ok) return fail("the stage changed meanwhile; call again");
      t.appendTransition({
        runId: row.runId,
        stageRunId: row.stageRunId,
        fromState: row.state,
        toState: row.state,
        event: "progress",
        outcome: null,
        actor: `agent:${stage.agent}`,
        at: this.clock.now(),
        detail: { bytes: Buffer.byteLength(p.note) },
      });
      return { ok: true, next: null, applied: "now" };
    });
  }

  async cancel(_runId: string, _actor: string): Promise<void> {
    throw new Error("cancel is not supported by this engine version");
  }

  async resolveGate(
    _stageRunId: string,
    _outcome: string,
    _by: string,
    _note?: string,
  ): Promise<void> {
    throw new Error("gates are not supported by this engine version");
  }

  status(runId: string): RunStatusView {
    return this.store.tx((t) => {
      const run = t.getRun(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      const view: RunStatusView = {
        run,
        transitions: t.transitions(runId, 20),
      };
      const live = t.liveStageRun(runId);
      if (live) {
        view.live = live;
        const gate = t.getGate(live.stageRunId);
        if (gate) view.gate = gate;
      }
      return view;
    });
  }

  on<E extends EngineEvent>(
    event: E,
    fn: (e: EngineEvents[E]) => void,
  ): Disposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const listener = fn as (e: never) => void;
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  }

  // --- the tick -----------------------------------------------------------

  /** Restart reconciliation of stored work; nothing to reconcile yet. */
  private async reconcile(): Promise<void> {}

  private async walk(): Promise<void> {
    if (!this.dispatching) return;
    const rows = this.store.tx((t) =>
      t.listStageRuns({ state: ["submitted"], limit: TICK_BATCH }),
    );
    for (const row of rows) {
      try {
        await this.dispatch(row.stageRunId);
      } catch (err) {
        // One broken stage run must not hold up the others.
        this.report(err);
      }
    }
  }

  /**
   * Starts a turn for a submitted agent stage run, in three steps so a crash
   * at any point is recoverable: record the dispatch (sequence and token),
   * call the harness outside any transaction, then record the turn.
   */
  private async dispatch(stageRunId: string): Promise<void> {
    this.caps ??= this.adapter.capabilities().catch((err) => {
      // A failed read is not cached; the next dispatch asks again.
      this.caps = undefined;
      throw err;
    });
    const caps = await this.caps;
    const prep = this.store.tx((t) => this.prepare(t, stageRunId, caps));
    if (!prep) return;

    let adapterRunId: string;
    try {
      await this.adapter.openSession(prep.agent, prep.sessionKey);
      ({ runId: adapterRunId } = await this.adapter.startTurn({
        agent: prep.agent,
        sessionKey: prep.sessionKey,
        message: prep.message,
        capMs: prep.capMs,
        idempotencyKey: prep.idempotencyKey,
        tools: [...COMPLETION_TOOLS],
      }));
    } catch (err) {
      // The row stays submitted with its dispatch sequence; the next tick
      // resends the same message under the same key.
      this.store.tx((t) => {
        t.appendTransition({
          runId: this.runOf(t, stageRunId),
          stageRunId,
          fromState: "submitted",
          toState: "submitted",
          event: "turn_start_failed",
          outcome: null,
          actor: ENGINE,
          at: this.clock.now(),
          detail: { dispatchSeq: prep.dispatchSeq, error: message(err) },
        });
      });
      return;
    }

    const abort = this.commit((t, emit) =>
      this.recordTurn(t, prep, adapterRunId, emit),
    );
    if (abort && this.adapter.abortTurn) {
      await this.adapter.abortTurn(abort).catch(() => false);
    }
  }

  /** Step one of a dispatch. Returns undefined when there is nothing to start. */
  private prepare(
    t: StoreTx,
    stageRunId: string,
    caps: Capabilities,
  ): Prepared | undefined {
    const row = t.getStageRun(stageRunId);
    if (row?.state !== "submitted") return undefined;
    const run = t.getRun(row.runId);
    if (run?.status !== "working") return undefined;
    const pinned = this.pinned(t, run);
    const stage = pinned.def.stages[row.stage];
    // Other stage types are not run by this engine version.
    if (stage?.type !== "agent") return undefined;

    const sessionKey = this.sessionKey(run, stage);
    // A dispatch recorded but whose turn was never recorded is resent under
    // the same key, so a harness that did accept it does not start it twice.
    const unrecorded = row.dispatchSeq > 0 && row.adapterRunId === null;
    const held = this.pending.get(stageRunId);
    let dispatchSeq = row.dispatchSeq;
    let text: string;
    if (
      unrecorded &&
      held &&
      held.dispatchSeq === row.dispatchSeq &&
      row.tokenHash !== null &&
      hashesEqual(held.tokenHash, row.tokenHash)
    ) {
      text = held.message;
    } else {
      // A fresh token. After a crash between steps, a harness that had
      // accepted the earlier turn runs it with the earlier token, which this
      // replaces; that turn then ends without a result.
      if (!unrecorded) dispatchSeq = row.dispatchSeq + 1;
      const { token, hash } = mintToken();
      const ok = t.updateStageRunIf(
        stageRunId,
        { state: "submitted", attempt: row.attempt },
        { dispatchSeq, tokenHash: hash, adapterRunId: null },
      );
      if (!ok) return undefined;
      text =
        row.turnsUsed === 0
          ? this.renderFor(t, run, pinned, stage, token)
          : renderContinuation(row.progressNote, token, stage.outcomes);
      this.pending.set(stageRunId, {
        dispatchSeq,
        tokenHash: hash,
        message: text,
      });
    }
    return {
      stageRunId,
      attempt: row.attempt,
      dispatchSeq,
      agent: stage.agent,
      sessionKey,
      message: text,
      capMs: stage.turns.capMs ?? caps.turnCapMs,
      idempotencyKey: turnKey(row.idempotencyKey, dispatchSeq),
    };
  }

  /**
   * Step three of a dispatch. Returns the harness run id to abort when the
   * stage run moved on while the turn was being started.
   */
  private recordTurn(
    t: StoreTx,
    prep: Prepared,
    adapterRunId: string,
    emit: Emit,
  ): string | undefined {
    this.pending.delete(prep.stageRunId);
    const row = t.getStageRun(prep.stageRunId);
    if (!row) return undefined;
    const run = t.getRun(row.runId);
    const now = this.clock.now();
    const stage = run && this.pinned(t, run).def.stages[row.stage];
    const deadline = stage?.type === "agent" ? stage.deadline : undefined;
    const detail = {
      adapterRunId,
      dispatchSeq: prep.dispatchSeq,
      idempotencyKey: prep.idempotencyKey,
    };
    const ok =
      row.dispatchSeq === prep.dispatchSeq &&
      t.updateStageRunIf(
        row.stageRunId,
        { state: "submitted", attempt: prep.attempt },
        {
          state: "working",
          adapterRunId,
          sessionKey: prep.sessionKey,
          turnsUsed: row.turnsUsed + 1,
          startedAt: row.startedAt ?? now,
          deadlineAt:
            row.deadlineAt ?? (deadline === undefined ? null : now + deadline),
        },
      );
    if (ok) {
      t.appendTransition({
        runId: row.runId,
        stageRunId: row.stageRunId,
        fromState: "submitted",
        toState: "working",
        event: "turn_started",
        outcome: null,
        actor: ENGINE,
        at: now,
        detail,
      });
      emit.push(() =>
        this.emit("stage_changed", {
          runId: row.runId,
          stageRunId: row.stageRunId,
          stage: row.stage,
          from: "submitted",
          to: "working",
        }),
      );
      return undefined;
    }
    // The stage run moved on while the harness was starting the turn. An
    // agent that already completed it keeps its turn; anything else is
    // aborted where the harness can.
    const completed = row.state === "completed";
    if (completed) {
      t.updateStageRunIf(
        row.stageRunId,
        { state: "completed", attempt: row.attempt },
        {
          adapterRunId,
          sessionKey: prep.sessionKey,
          turnsUsed: row.turnsUsed + 1,
        },
      );
    }
    t.appendTransition({
      runId: row.runId,
      stageRunId: row.stageRunId,
      fromState: row.state,
      toState: row.state,
      event: "turn_start_superseded",
      outcome: null,
      actor: ENGINE,
      at: now,
      detail,
    });
    return completed ? undefined : adapterRunId;
  }

  private renderFor(
    t: StoreTx,
    run: RunRow,
    pinned: Pinned,
    stage: AgentStage,
    token: string,
  ): string {
    const template = pinned.briefs[stage.brief];
    if (template === undefined) {
      throw new Error(`brief ${stage.brief} is missing from the definition`);
    }
    const stages: Record<string, Record<string, unknown>> = {};
    for (const id of Object.keys(pinned.def.stages)) {
      const done = t.latestCompleted(run.runId, id);
      if (done && isPlainObject(done.fields)) stages[id] = done.fields;
    }
    return renderBrief(template, {
      inputs: run.inputs,
      runId: run.runId,
      stages,
      outcomes: stage.outcomes,
      token,
    });
  }

  private sessionKey(run: RunRow, stage: AgentStage): string {
    if (stage.session === "project") {
      const project = descend(run.inputs, "project");
      const scope =
        typeof project === "string" || typeof project === "number"
          ? String(project)
          : run.runId;
      return `project:${scope}:${stage.agent}`;
    }
    return `run:${run.runId}:${stage.agent}`;
  }

  // --- completion ---------------------------------------------------------

  /**
   * Finds the agent stage run a token belongs to. In order: the token is
   * known, its attempt has not ended (a refusal is logged), the caller is the
   * stage's agent, then either the attempt is already completed or the run
   * is still working.
   */
  private byToken(
    t: StoreTx,
    token: string,
    callerAgent: string | undefined,
  ):
    | { kind: "live"; row: StageRunRow; run: RunRow; stage: AgentStage }
    | { kind: "completed"; row: StageRunRow }
    | { kind: "refused"; error: string } {
    const refused = (error: string) => ({ kind: "refused" as const, error });
    const hash = hashToken(token);
    const row = t.findStageRunByTokenHash(hash);
    if (!row || row.tokenHash === null || !hashesEqual(row.tokenHash, hash)) {
      return refused(
        "this token is not live: it is unknown or belongs to an earlier attempt",
      );
    }
    const run = t.getRun(row.runId);
    const stage = run && this.pinned(t, run).def.stages[row.stage];
    if (!run || stage?.type !== "agent") {
      return refused("this token does not belong to an agent stage");
    }
    const ended = !["submitted", "working", "completed"].includes(row.state);
    if (ended) {
      t.appendTransition({
        runId: row.runId,
        stageRunId: row.stageRunId,
        fromState: row.state,
        toState: row.state,
        event: "completion_refused",
        outcome: null,
        actor: `agent:${callerAgent ?? stage.agent}`,
        at: this.clock.now(),
        detail: { reason: "attempt ended" },
      });
      return refused(`this attempt has ended (${row.state})`);
    }
    if (callerAgent !== undefined && callerAgent !== stage.agent) {
      return refused(
        `this stage belongs to agent ${stage.agent}, not ${callerAgent}`,
      );
    }
    if (row.state === "completed") return { kind: "completed", row };
    if (run.status !== "working") return refused(`the run is ${run.status}`);
    return { kind: "live", row, run, stage };
  }

  /** A completion for an attempt already completed: idempotent when identical. */
  private repeated(
    t: StoreTx,
    row: StageRunRow,
    p: CompleteParams,
  ): CompletionResult {
    if (row.outcome !== p.outcome) {
      return fail(
        `this stage was already completed with outcome ${row.outcome}`,
      );
    }
    const fields = p.fields === undefined ? {} : p.fields;
    if (stableJson(fields) !== stableJson(row.fields)) {
      return fail(
        `this stage was already completed with outcome ${row.outcome} and other fields`,
      );
    }
    const done = t
      .transitions(row.runId)
      .find(
        (x) => x.stageRunId === row.stageRunId && x.event === "stage_completed",
      );
    const next = isPlainObject(done?.detail) ? done.detail.next : null;
    return {
      ok: true,
      next: typeof next === "string" ? next : null,
      applied: "already",
    };
  }

  private checkFields(
    outcome: string,
    schema: AgentStage["outcomes"][string]["fields"],
    fields: unknown,
  ): string | undefined {
    if (!isPlainObject(fields)) {
      return `fields must be an object; outcome ${outcome} takes ${fieldsShorthand(schema)}`;
    }
    if (Buffer.byteLength(JSON.stringify(fields)) > MAX_FIELDS_BYTES) {
      return "fields are larger than 64 KiB; put large content in an artifact and pass its location";
    }
    if (!schema) {
      return Object.keys(fields).length === 0
        ? undefined
        : `outcome ${outcome} declares no fields; pass {} or leave fields out`;
    }
    const errors = validateJson(schema, fields);
    if (errors.length === 0) return undefined;
    const shown = errors.slice(0, 10).join("; ");
    return `fields for outcome ${outcome} are invalid: ${shown}. Declared ${fieldsShorthand(schema)}`;
  }

  // --- advancing ----------------------------------------------------------

  /**
   * Records `done` (the transition that ended `from`) with the stage chosen
   * by `outcome`, then enters that stage or ends the run. Returns the stage
   * entered, or null when the run failed without reaching one. Never throws
   * for a guard; a guard that cannot be evaluated fails the run.
   */
  private advance(
    t: StoreTx,
    run: RunRow,
    from: StageRunRow,
    outcome: string,
    done: Draft,
    emit: Emit,
  ): string | null {
    const pinned = this.pinned(t, run);
    const stage = pinned.def.stages[from.stage];
    const next = stage && nextOf(stage, outcome);
    const chosen =
      next === undefined
        ? { error: `stage ${from.stage} has no next for outcome ${outcome}` }
        : this.choose(t, run, pinned, from.stage, outcome, next);
    const now = this.clock.now();
    const target = "to" in chosen ? chosen.to : null;
    t.appendTransition({
      ...done,
      runId: run.runId,
      at: now,
      detail: { ...(done.detail as object), next: target },
    });
    if ("error" in chosen) {
      this.failRun(t, run, "guard_error", ENGINE, emit, {
        ...(chosen.branch === undefined ? {} : { branch: chosen.branch }),
        error: chosen.error,
      });
      return null;
    }
    this.enter(t, run, chosen.to, ENGINE, emit);
    return chosen.to;
  }

  /** The first branch whose guard holds. */
  private choose(
    t: StoreTx,
    run: RunRow,
    pinned: Pinned,
    stage: string,
    outcome: string,
    next: Next,
  ): { to: string } | { error: string; branch?: string } {
    if (typeof next === "string") return { to: next };
    const ctx = this.guardContext(t, run);
    for (const [i, b] of next.entries()) {
      if (b.if === undefined) return { to: b.to };
      const branch = `${stage}.${outcome}[${i}]`;
      try {
        const ast = this.guard(pinned, b.if);
        if (evalGuard(ast, ctx)) return { to: b.to };
      } catch (err) {
        return { error: message(err), branch };
      }
    }
    return { error: `no branch of ${stage}.${outcome} matched` };
  }

  private guard(pinned: Pinned, source: string): GuardAst {
    let ast = pinned.guards.get(source);
    if (ast === undefined) {
      try {
        ast = parseGuard(source);
      } catch (err) {
        ast = err instanceof Error ? err : new Error(String(err));
      }
      pinned.guards.set(source, ast);
    }
    if (ast instanceof Error) throw ast;
    return ast;
  }

  private guardContext(t: StoreTx, run: RunRow): GuardContext {
    return {
      count: (stage, outcome) => t.countOutcome(run.runId, stage, outcome),
      attempts: (stage) => t.countAttempts(run.runId, stage),
      field: (stage, name) =>
        descend(t.latestCompleted(run.runId, stage)?.fields, name),
      input: (path) => descend(run.inputs, path),
    };
  }

  /** Creates the stage's submitted stage run, or ends the run on an `end` stage. */
  private enter(
    t: StoreTx,
    run: RunRow,
    stageId: string,
    actor: string,
    emit: Emit,
  ): void {
    const stage = this.pinned(t, run).def.stages[stageId];
    const now = this.clock.now();
    if (!stage) {
      this.failRun(t, run, "unknown_stage", actor, emit, { stage: stageId });
      return;
    }
    if (stage.type === "end") {
      this.endRun(t, run, stageId, stage.status, actor, emit);
      return;
    }
    const stageRunId = newStageRunId();
    t.insertStageRun({
      stageRunId,
      runId: run.runId,
      stage: stageId,
      attempt: t.maxAttempt(run.runId, stageId) + 1,
      visit: t.countVisits(run.runId, stageId) + 1,
      retryIndex: 0,
      state: "submitted",
      tokenHash: null,
      adapterRunId: null,
      sessionKey: null,
      turnsUsed: 0,
      dispatchSeq: 0,
      deadlineAt: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      outcome: null,
      fields: null,
      progressNote: null,
      runtime: null,
      waitReason: null,
    });
    t.appendTransition({
      runId: run.runId,
      stageRunId,
      fromState: null,
      toState: "submitted",
      event: "stage_submitted",
      outcome: null,
      actor,
      at: now,
      detail: null,
    });
    this.moveRun(t, run, { currentStage: stageId, updatedAt: now });
    emit.push(() =>
      this.emit("stage_changed", {
        runId: run.runId,
        stageRunId,
        stage: stageId,
        from: null,
        to: "submitted",
      }),
    );
  }

  private endRun(
    t: StoreTx,
    run: RunRow,
    stageId: string,
    status: RunStatus,
    actor: string,
    emit: Emit,
    event = "run_ended",
    detail: unknown = { stage: stageId },
  ): void {
    const now = this.clock.now();
    this.moveRun(t, run, {
      status,
      currentStage: stageId,
      updatedAt: now,
      endedAt: now,
    });
    t.appendTransition({
      runId: run.runId,
      stageRunId: null,
      fromState: run.status,
      toState: status,
      event,
      outcome: null,
      actor,
      at: now,
      detail,
    });
    emit.push(() =>
      this.emit("run_ended", { runId: run.runId, status, stage: stageId }),
    );
  }

  private failRun(
    t: StoreTx,
    run: RunRow,
    event: string,
    actor: string,
    emit: Emit,
    detail: Record<string, unknown>,
  ): void {
    const current = t.getRun(run.runId) ?? run;
    this.endRun(
      t,
      run,
      current.currentStage,
      "failed",
      actor,
      emit,
      event,
      detail,
    );
  }

  /** Compare-and-set on the run; it cannot lose inside the transaction that read it. */
  private moveRun(
    t: StoreTx,
    run: RunRow,
    patch: Parameters<StoreTx["updateRunIf"]>[2],
  ): void {
    const current = t.getRun(run.runId);
    if (!current || current.status !== run.status) {
      throw new Error(`run ${run.runId} changed state during the transaction`);
    }
    const ok = t.updateRunIf(
      run.runId,
      { status: current.status, currentStage: current.currentStage },
      patch,
    );
    if (!ok) throw new Error(`run ${run.runId} could not be updated`);
  }

  // --- plumbing -----------------------------------------------------------

  /** The definition version a run is pinned to, from memory or the store. */
  private pinned(t: StoreTx, run: RunRow): Pinned {
    const key = `${run.pipelineId}\0${run.defHash}`;
    let p = this.pinnedCache.get(key);
    if (!p) {
      const row = t.getDefinition(run.pipelineId, run.defHash);
      if (!row) {
        throw new Error(
          `definition ${run.pipelineId}@${run.defHash} of run ${run.runId} is missing from the store`,
        );
      }
      p = { def: row.parsed, briefs: row.briefs, guards: new Map() };
      this.pinnedCache.set(key, p);
    }
    return p;
  }

  private runOf(t: StoreTx, stageRunId: string): string {
    const row = t.getStageRun(stageRunId);
    if (!row) throw new Error(`unknown stage run ${stageRunId}`);
    return row.runId;
  }

  /** Runs `fn` in one transaction and emits its events after the commit. */
  private commit<T>(fn: (t: StoreTx, emit: Emit) => SyncResult<T>): T {
    const emit: Emit = [];
    const result = this.store.tx((t) => fn(t, emit));
    for (const e of emit) e();
    return result;
  }

  private emit<E extends EngineEvent>(
    event: E,
    payload: EngineEvents[E],
  ): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as (e: EngineEvents[E]) => void)(payload);
      } catch {
        // A listener's failure is its own; the engine carries on.
      }
    }
  }

  private report(err: unknown): void {
    console.error(`sekaisen: ${message(err)}`);
  }
}
