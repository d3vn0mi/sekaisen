import { randomBytes } from "node:crypto";
import type {
  Capabilities,
  HarnessAdapter,
  RunOutcome,
} from "../adapter/types.js";
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
import { realTimers, type Timers, withTimeout } from "./calls.js";
import { cancelRun } from "./cancel.js";
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
import { resolveGate } from "./gates.js";
import { invoke, rejectStageRun, stageFields } from "./hostcalls.js";
import { newRunId } from "./ids.js";
import { deadlinePassed } from "./lifecycle.js";
import { type Pinned, PinnedDefinitions } from "./pinned.js";
import { recordCallError, recordCallResult, stepStage } from "./stages.js";
import { deriveToken, hashToken, MIN_TOKEN_SECRET_BYTES } from "./tokens.js";
import {
  admission,
  forgetTurn,
  recordTimeout,
  recordTurnEnd,
  type TxCtx,
} from "./turns.js";
import { descend, errorMessage, isPlainObject } from "./values.js";

export type { Timers } from "./calls.js";
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
   * a turn resent after a restart carries a new token under a new turn key
   * (logged as `token_rederived`), and a turn the harness had already
   * started under the old token cannot complete.
   */
  tokenSecret?: Uint8Array;
  /**
   * Longest the engine waits on any one harness call or host function (a
   * check, action or fact), in milliseconds; 30000 by default. A call that
   * takes longer is treated as one that failed, so a hung harness or host
   * function cannot stall the tick. A host function past it ends its attempt
   * as `timeout` (a thrown error is `turn_error`).
   */
  adapterCallTimeoutMs?: number;
  /** The timers behind `adapterCallTimeoutMs`; real ones by default. */
  timers?: Timers;
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
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
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
  private readonly callTimeoutMs: number;
  private readonly timers: Timers;
  private caps?: Promise<Capabilities>;
  /** Turns to abort once the harness's capabilities can be read. */
  private readonly pendingAborts: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;

  constructor(private readonly o: EngineOptions) {
    this.store = o.store;
    this.adapter = o.adapter;
    this.clock = o.clock ?? systemClock;
    this.tickMs = o.tickMs ?? DEFAULT_TICK_MS;
    this.dispatching = o.dispatch !== false;
    this.callTimeoutMs = o.adapterCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.timers = o.timers ?? realTimers;
    if (!(Number.isFinite(this.callTimeoutMs) && this.callTimeoutMs > 0)) {
      throw new Error("adapterCallTimeoutMs must be a positive number");
    }
    if (
      o.tokenSecret !== undefined &&
      (!(o.tokenSecret instanceof Uint8Array) ||
        o.tokenSecret.byteLength < MIN_TOKEN_SECRET_BYTES)
    ) {
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
        { progressNote: p.note, progressAt: now, progressSeq: row.dispatchSeq },
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

  /**
   * Cancels a run and its live stage run, asks the harness to abort a turn
   * in flight where it can, and submits the definition's `onCancel` action
   * for the tick to run once. Throws when the run has already ended.
   */
  async cancel(runId: string, actor: string): Promise<void> {
    const abort = this.commit((t, emit) =>
      cancelRun(this.txCtx(t, emit), runId, actor),
    );
    if (abort === undefined) return;
    let caps: Capabilities;
    try {
      caps = await this.capabilities();
    } catch {
      this.pendingAborts.push(abort);
      return;
    }
    await this.abort(abort, caps);
  }

  /**
   * An operator's answer to a gate: records `by` in the gate row and as the
   * transition's actor, then moves the run on by `outcome`. Throws for an
   * outcome the gate does not declare or a gate already resolved.
   */
  async resolveGate(
    stageRunId: string,
    outcome: string,
    by: string,
    note?: string,
  ): Promise<void> {
    this.commit((t, emit) =>
      resolveGate(this.txCtx(t, emit), stageRunId, outcome, by, note),
    );
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
    let caps: Capabilities | undefined;
    try {
      caps = await this.capabilities();
    } catch (err) {
      // Deadlines are still enforced; aborts, turn ends and dispatch wait
      // for the capabilities.
      this.report(err);
    }
    if (caps) await this.flushAborts(caps);
    // Turns first, so a continuation or retry they submit is dispatched in
    // the same pass.
    const inFlight = this.store.tx((t) =>
      t.listStageRuns({ inFlight: true, limit: TICK_BATCH }),
    );
    for (const row of inFlight) {
      try {
        await this.observe(row, caps);
      } catch (err) {
        // One broken stage run must not hold up the others.
        this.report(err);
      }
    }
    // The stages the tick runs itself need nothing from the harness.
    await this.runStages();
    if (!caps) return;
    // Agent stage runs only: every other stage type has a wake time.
    const submitted = this.store.tx((t) =>
      t.listStageRuns({
        state: ["submitted"],
        wakes: false,
        limit: TICK_BATCH,
      }),
    );
    for (const row of submitted) {
      try {
        await this.admit(row, caps);
      } catch (err) {
        this.report(err);
      }
    }
  }

  /**
   * Checks, actions, waits and gates whose wake time has come, earliest
   * first. Kept apart from agent dispatch: they take no lane.
   */
  private async runStages(): Promise<void> {
    const due = this.store.tx((t) =>
      t.listStageRuns({
        state: ["submitted", "working", "input_required"],
        wakeBy: this.clock.now(),
        limit: TICK_BATCH,
      }),
    );
    for (const row of due) {
      try {
        await this.runStage(row);
      } catch (err) {
        this.report(err);
      }
    }
  }

  /** One due stage run: prepare in a transaction, call the host, record in another. */
  private async runStage(seen: StageRunRow): Promise<void> {
    const call = this.commit((t, emit) =>
      stepStage({ ...this.txCtx(t, emit), registry: this.o.registry }, seen),
    );
    if (!call) return;
    let value: unknown;
    try {
      value = await this.call(`${call.kind} ${call.name}`, () => invoke(call));
    } catch (err) {
      this.commit((t, emit) => recordCallError(this.txCtx(t, emit), call, err));
      return;
    }
    this.commit((t, emit) =>
      recordCallResult(this.txCtx(t, emit), call, value),
    );
  }

  /** The harness's capabilities, read once; a failed read is asked again. */
  private capabilities(): Promise<Capabilities> {
    this.caps ??= this.call("capabilities", () =>
      this.adapter.capabilities(),
    ).catch((err) => {
      this.caps = undefined;
      throw err;
    });
    return this.caps;
  }

  /** A harness or host call bounded by `adapterCallTimeoutMs`. */
  private call<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withTimeout(name, fn, this.callTimeoutMs, this.timers);
  }

  /**
   * One stage run with a turn in flight: an attempt past its deadline times
   * out; otherwise the turn's end, once the harness reports it, is recorded.
   */
  private async observe(
    row: StageRunRow,
    caps: Capabilities | undefined,
  ): Promise<void> {
    if (row.state === "working" && deadlinePassed(row, this.clock.now())) {
      await this.timeOut(row, caps);
      return;
    }
    if (!caps) return;
    const adapterRunId = row.adapterRunId;
    if (
      adapterRunId === null ||
      !["working", "completed"].includes(row.state)
    ) {
      this.commit((t, emit) => forgetTurn(this.txCtx(t, emit), row));
      return;
    }
    let outcome: RunOutcome;
    try {
      outcome = await this.call("readRunOutcome", () =>
        this.adapter.readRunOutcome(adapterRunId),
      );
    } catch {
      // Read again on the next tick.
      return;
    }
    if (outcome.state === "running") return;
    if (outcome.state === "unknown") {
      // A working turn the harness no longer knows is for restart
      // reconciliation; a completed one has nothing left to tell.
      if (row.state === "completed") {
        this.commit((t, emit) => forgetTurn(this.txCtx(t, emit), row));
      }
      return;
    }
    const ended = outcome;
    this.commit((t, emit) =>
      recordTurnEnd({ ...this.txCtx(t, emit), caps }, row, ended),
    );
  }

  private async timeOut(
    row: StageRunRow,
    caps: Capabilities | undefined,
  ): Promise<void> {
    const abort = this.commit((t, emit) =>
      recordTimeout(this.txCtx(t, emit), row),
    );
    if (abort === undefined) return;
    if (caps) await this.abort(abort, caps);
    else this.pendingAborts.push(abort);
  }

  /** Aborts turns whose attempts timed out while capabilities were unknown. */
  private async flushAborts(caps: Capabilities): Promise<void> {
    for (const id of this.pendingAborts.splice(0)) await this.abort(id, caps);
  }

  /** Asks the harness to stop a turn, where it can; a failure changes nothing. */
  private async abort(adapterRunId: string, caps: Capabilities): Promise<void> {
    const abortTurn = this.adapter.abortTurn?.bind(this.adapter);
    if (!caps.canAbort || !abortTurn) return;
    await this.call("abortTurn", () => abortTurn(adapterRunId)).catch(
      () => false,
    );
  }

  /**
   * A submitted stage run: held by a pause (which keeps its deadline from
   * running), else timed out, else dispatched.
   */
  private async admit(seen: StageRunRow, caps: Capabilities): Promise<void> {
    const found = this.commit((t, emit) =>
      admission({ ...this.txCtx(t, emit), caps }, seen),
    );
    if (!found || "held" in found) return;
    if (deadlinePassed(found.row, this.clock.now())) {
      await this.timeOut(found.row, caps);
      return;
    }
    await this.dispatch(found.row.stageRunId, caps);
  }

  /**
   * Starts a turn for a submitted agent stage run, in three steps so a crash
   * at any point is recoverable: record the dispatch (sequence and token hash),
   * call the harness outside any transaction, then record the turn.
   */
  private async dispatch(
    stageRunId: string,
    caps: Capabilities,
  ): Promise<void> {
    const prep = this.commit((t, emit) =>
      this.prepare(t, stageRunId, caps, emit),
    );
    if (!prep) return;

    let adapterRunId: string;
    try {
      await this.call("openSession", () =>
        this.adapter.openSession(prep.agent, prep.sessionKey),
      );
      ({ runId: adapterRunId } = await this.call("startTurn", () =>
        this.adapter.startTurn({
          agent: prep.agent,
          sessionKey: prep.sessionKey,
          message: prep.message,
          capMs: prep.capMs,
          idempotencyKey: prep.idempotencyKey,
          tools: [...COMPLETION_TOOLS],
        }),
      ));
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
    if (abort) await this.abort(abort, caps);
  }

  /** Step one of a dispatch. Returns undefined when there is nothing to start. */
  private prepare(
    t: StoreTx,
    stageRunId: string,
    caps: Capabilities,
    emit: EmitFn,
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
    const token = deriveToken(this.tokenSecret, row.idempotencyKey);
    const hash = hashToken(token);
    // Store reads happen out here: a store error propagates and the row is
    // tried again on the next tick. Only a brief that can never be rendered
    // refuses the stage run.
    const message =
      row.turnsUsed === 0
        ? this.briefFor(
            run,
            pinned,
            stage,
            token,
            stageFields(t, run.runId, pinned.def),
          )
        : { text: renderContinuation(row.progressNote, token, stage.outcomes) };
    if ("refused" in message) {
      rejectStageRun(this.ctx(t, run, emit), row, message.refused);
      return undefined;
    }
    const text = message.text;
    // The hash is set when the attempt is first dispatched. A different one
    // means the secret changed (a restart without a configured secret). A
    // turn the harness may already hold carries the old token, so the new
    // brief goes out under a new turn key rather than being deduplicated
    // into that turn, and the change is logged.
    const rederived = row.tokenHash !== null && row.tokenHash !== hash;
    const unrecorded = row.dispatchSeq > 0 && row.adapterRunId === null;
    const dispatchSeq =
      unrecorded && !rederived ? row.dispatchSeq : row.dispatchSeq + 1;
    const patch: StageRunPatch = {};
    if (row.tokenHash !== hash) patch.tokenHash = hash;
    if (dispatchSeq !== row.dispatchSeq) {
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
    if (rederived) {
      t.appendTransition({
        runId: row.runId,
        stageRunId,
        fromState: row.state,
        toState: row.state,
        event: "token_rederived",
        outcome: null,
        actor: ENGINE_ACTOR,
        at: this.clock.now(),
        detail: { fromSeq: row.dispatchSeq, toSeq: dispatchSeq },
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
          dispatchedAt: now,
          waitReason: null,
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
          // Its turn's end is still read, for the provider it ran on.
          dispatchedAt: now,
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

  /** The first turn's brief, or why it can never be rendered. */
  private briefFor(
    run: RunRow,
    pinned: Pinned,
    stage: AgentStage,
    token: string,
    stages: Record<string, Record<string, unknown>>,
  ): { text: string } | { refused: string } {
    const template = pinned.briefs[stage.brief];
    if (template === undefined) {
      return { refused: `brief ${stage.brief} is missing from the definition` };
    }
    try {
      return {
        text: renderBrief(template, {
          inputs: run.inputs,
          runId: run.runId,
          stages,
          outcomes: stage.outcomes,
          token,
        }),
      };
    } catch (err) {
      return {
        refused: `brief ${stage.brief} cannot be rendered: ${errorMessage(err)}`,
      };
    }
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

  private txCtx(t: StoreTx, emit: EmitFn): TxCtx {
    return { t, pinned: this.pinned, now: this.clock.now(), emit };
  }

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
