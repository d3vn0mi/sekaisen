import { randomBytes } from "node:crypto";
import type { Capabilities, HarnessAdapter } from "../adapter/types.js";
import { validateJson } from "../format/jsonschema.js";
import type { LoadedDefinition } from "../format/load.js";
import type { AgentStage } from "../format/types.js";
import type { HostRegistry } from "../host/registry.js";
import type {
  GateRow,
  RunRow,
  StageRunPatch,
  StageRunRow,
  Store,
  StoreTx,
  SyncResult,
  TransitionRow,
} from "../store/types.js";
import { turnKey } from "../store/types.js";
import { advance, ENGINE_ACTOR, enter, type RunCtx } from "./advance.js";
import { outcomesList, renderBrief, renderContinuation } from "./brief.js";
import { type Clock, systemClock } from "./clock.js";
import {
  byToken,
  type CompleteParams,
  type CompletionResult,
  checkFields,
  fail,
  MAX_NOTE_BYTES,
  repeated,
} from "./completion.js";
import {
  type Disposable,
  type EmitFn,
  Emitter,
  type EngineEvent,
  type EngineEvents,
} from "./events.js";
import { newRunId } from "./ids.js";
import { type Pinned, PinnedDefinitions } from "./pinned.js";
import { deriveToken, hashToken, MIN_TOKEN_SECRET_BYTES } from "./tokens.js";
import { descend, errorMessage, isPlainObject } from "./values.js";

export {
  type CompleteParams,
  type CompletionResult,
  MAX_FIELDS_BYTES,
  MAX_NOTE_BYTES,
} from "./completion.js";
export type {
  Disposable,
  EngineEvent,
  EngineEvents,
} from "./events.js";

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
  /**
   * At least 32 bytes, from which each attempt's completion token is
   * derived. Keep it out of the store (a host reads it from a file only it
   * can read). Without it the engine uses a random secret held in memory, so
   * a turn resent after a restart carries a new token and a turn that the
   * harness had already started under the old one cannot complete.
   */
  tokenSecret?: Uint8Array;
}

export interface RunStatusView {
  run: RunRow;
  live?: StageRunRow;
  gate?: GateRow;
  /** The most recent 20, oldest first. */
  transitions: TransitionRow[];
}

/** The tools a dispatched turn needs to report back. */
export const COMPLETION_TOOLS = ["stage_complete", "stage_progress"];

const DEFAULT_TICK_MS = 5000;
const TICK_BATCH = 100;

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

export class Engine {
  private readonly store: Store;
  private readonly adapter: HarnessAdapter;
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly dispatching: boolean;
  private readonly pinned = new PinnedDefinitions();
  private readonly events = new Emitter();
  private readonly tokenSecret: Uint8Array;
  private caps?: Promise<Capabilities>;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;

  constructor(private readonly o: EngineOptions) {
    this.store = o.store;
    this.adapter = o.adapter;
    this.clock = o.clock ?? systemClock;
    this.tickMs = o.tickMs ?? DEFAULT_TICK_MS;
    this.dispatching = o.dispatch !== false;
    if (o.tokenSecret && o.tokenSecret.length < MIN_TOKEN_SECRET_BYTES) {
      throw new Error(
        `tokenSecret must be at least ${MIN_TOKEN_SECRET_BYTES} bytes`,
      );
    }
    this.tokenSecret = o.tokenSecret
      ? Uint8Array.from(o.tokenSecret)
      : randomBytes(MIN_TOKEN_SECRET_BYTES);
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
      enter(this.ctx(t, run, emit), def.start, actor);
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
      const found = byToken(
        t,
        this.pinned,
        this.clock.now(),
        p.token,
        p.callerAgent,
        "completion_refused",
      );
      if (found.kind === "refused") return fail(found.error);
      if (found.kind === "completed") return repeated(t, found.row, p);
      const { row, run, stage } = found;
      const outcome = stage.outcomes[p.outcome];
      if (!Object.hasOwn(stage.outcomes, p.outcome) || !outcome) {
        return fail(
          `unknown outcome "${p.outcome}". Declared outcomes:\n${outcomesList(stage.outcomes)}`,
        );
      }
      const fields = p.fields === undefined ? {} : p.fields;
      const invalid = checkFields(p.outcome, outcome.fields, fields);
      if (invalid) return fail(invalid);

      const ctx = this.ctx(t, run, emit);
      const ok = t.updateStageRunIf(
        row.stageRunId,
        { state: row.state, attempt: row.attempt },
        { state: "completed", outcome: p.outcome, fields, endedAt: ctx.now },
      );
      if (!ok) return fail("the stage changed meanwhile; call again");
      emit("stage_changed", {
        runId: run.runId,
        stageRunId: row.stageRunId,
        stage: row.stage,
        from: row.state,
        to: "completed",
      });
      const detail = p.artifacts?.length ? { artifacts: p.artifacts } : {};
      const next = advance(ctx, row, p.outcome, {
        stageRunId: row.stageRunId,
        fromState: row.state,
        toState: "completed",
        event: "stage_completed",
        outcome: p.outcome,
        actor: `agent:${stage.agent}`,
        detail,
      });
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
      const now = this.clock.now();
      const found = byToken(
        t,
        this.pinned,
        now,
        p.token,
        p.callerAgent,
        "progress_refused",
      );
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
        at: now,
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
    return this.events.on(event, fn);
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
   * at any point is recoverable: record the dispatch (sequence and token hash),
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
      // The row keeps its dispatch sequence; the next tick resends the same
      // message under the same key.
      this.store.tx((t) => {
        const row = t.getStageRun(stageRunId);
        if (!row) return;
        t.appendTransition({
          runId: row.runId,
          stageRunId,
          fromState: row.state,
          toState: row.state,
          event: "turn_start_failed",
          outcome: null,
          actor: ENGINE_ACTOR,
          at: this.clock.now(),
          detail: { dispatchSeq: prep.dispatchSeq, error: errorMessage(err) },
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
    const pinned = this.pinned.of(t, run);
    const stage = pinned.def.stages[row.stage];
    // Other stage types are not run by this engine version.
    if (stage?.type !== "agent") return undefined;

    const sessionKey = this.sessionKey(run, stage);
    // A dispatch recorded but whose turn was never recorded is resent under
    // the same key, so a harness that did accept it does not start it twice.
    // The token is derived from the attempt, so the resent message is the
    // same one, and a continuation carries the first turn's token.
    const unrecorded = row.dispatchSeq > 0 && row.adapterRunId === null;
    const dispatchSeq = unrecorded ? row.dispatchSeq : row.dispatchSeq + 1;
    const token = deriveToken(this.tokenSecret, row.idempotencyKey);
    const hash = hashToken(token);
    // The hash is set when the attempt is first dispatched. It differs only
    // when the secret changed (a restart without a configured secret); the
    // new hash then replaces it, so this turn can complete.
    const patch: StageRunPatch = {};
    if (row.tokenHash !== hash) patch.tokenHash = hash;
    if (!unrecorded) {
      patch.dispatchSeq = dispatchSeq;
      patch.adapterRunId = null;
    }
    if (Object.keys(patch).length > 0) {
      const ok = t.updateStageRunIf(
        stageRunId,
        { state: "submitted", attempt: row.attempt },
        patch,
      );
      if (!ok) return undefined;
    }
    const text =
      row.turnsUsed === 0
        ? this.renderFor(t, run, pinned, stage, token)
        : renderContinuation(row.progressNote, token, stage.outcomes);
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
    emit: EmitFn,
  ): string | undefined {
    const row = t.getStageRun(prep.stageRunId);
    if (!row) return undefined;
    const run = t.getRun(row.runId);
    const now = this.clock.now();
    const stage = run && this.pinned.of(t, run).def.stages[row.stage];
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
        actor: ENGINE_ACTOR,
        at: now,
        detail,
      });
      emit("stage_changed", {
        runId: row.runId,
        stageRunId: row.stageRunId,
        stage: row.stage,
        from: "submitted",
        to: "working",
      });
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
          startedAt: row.startedAt ?? now,
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
      actor: ENGINE_ACTOR,
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

  // --- plumbing -----------------------------------------------------------

  private ctx(t: StoreTx, run: RunRow, emit: EmitFn): RunCtx {
    return {
      t,
      pinned: this.pinned.of(t, run),
      run,
      now: this.clock.now(),
      emit,
    };
  }

  /** Runs `fn` in one transaction and emits its events after the commit. */
  private commit<T>(fn: (t: StoreTx, emit: EmitFn) => SyncResult<T>): T {
    const queue = this.events.queue();
    const result = this.store.tx((t) => fn(t, queue.emit));
    queue.flush();
    return result;
  }

  private report(err: unknown): void {
    console.error(`sekaisen: ${errorMessage(err)}`);
  }
}
