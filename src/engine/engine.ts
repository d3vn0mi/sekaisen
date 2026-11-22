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
import {
  type AgentSlot,
  admit,
  isPause,
  lanesTaken,
  pauseReason,
} from "../scheduler/scheduler.js";
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
import {
  advance,
  ENGINE_ACTOR,
  enter,
  RECONCILE_ACTOR,
  type RunCtx,
} from "./advance.js";
import { outcomesList, renderBrief, renderContinuation } from "./brief.js";
import { eachLimit, realTimers, type Timers, withTimeout } from "./calls.js";
import { cancelRun } from "./cancel.js";
import { type Clock, systemClock } from "./clock.js";
import {
  byToken,
  type CompleteParams,
  type CompletionResult,
  checkArtifacts,
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
import { sessionKeyOf } from "./sessions.js";
import { recordCallError, recordCallResult, stepStage } from "./stages.js";
import { deriveToken, hashToken, MIN_TOKEN_SECRET_BYTES } from "./tokens.js";
import {
  type AbortRequest,
  abortRequest,
  failAbort,
  forgetTurn,
  logAbort,
  recordAdmit,
  recordLost,
  recordTimeout,
  recordTurnEnd,
  recordWait,
  settleAbort,
  type TxCtx,
} from "./turns.js";
import { errorMessage, isPlainObject } from "./values.js";

export type { Timers } from "./calls.js";
export {
  type CompleteParams,
  type CompletionResult,
  MAX_ARTIFACT_CHARS,
  MAX_ARTIFACTS,
  MAX_FIELDS_BYTES,
  MAX_NOTE_BYTES,
} from "./completion.js";
export type {
  Disposable,
  EngineEvent,
  EngineEvents,
} from "./events.js";
export { abortBackoffMs, MAX_ABORT_ATTEMPTS } from "./turns.js";

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
   * derived. Only the dispatching process needs it: completions are checked
   * against the token hash in the store, so an engine with `dispatch: false`
   * ignores it. Keep it out of the store (a host reads it from a file only
   * it can read). Without it a dispatching engine uses a random secret held
   * in memory, so a turn resent after a restart carries a new token under a
   * new turn key (logged as `token_rederived`), and a turn the harness had
   * already started under the old token cannot complete.
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
  /**
   * Most working stage runs an agent may have on one session key, by agent;
   * 1 for an agent not named. Further stage runs wait as `wip:<agent>`.
   */
  wip?: Record<string, number>;
  /**
   * Most turns the tick reads, and host functions it calls, at the same
   * time; 4 by default. Each is still bounded by `adapterCallTimeoutMs`.
   */
  concurrency?: number;
  /**
   * Receives what the engine could not do and carried on past: a harness
   * call that failed, a stage run it had to skip this tick. `message` is
   * one line; `err` is the error behind it, when there is one. By default
   * the message goes to `console.error`, prefixed `sekaisen: `. A handler
   * that throws is ignored.
   */
  onError?: (message: string, err?: unknown) => void;
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
const DEFAULT_WIP = 1;
const DEFAULT_CONCURRENCY = 4;
const TICK_BATCH = 100;
/**
 * Pages of `TICK_BATCH` submitted stage runs one agent pass may look at, so
 * a deep queue of refused ones at the head cannot hide one that could run.
 */
const MAX_CANDIDATE_PAGES = 10;
/**
 * How long, on the engine's clock, a tick goes on starting abort calls once
 * its other work is done; the rest wait for the next tick.
 */
const ABORT_BUDGET_MS = 10_000;
/**
 * How many call timeouts past its deadline a turn found in flight at start
 * may wait for a harness that cannot be read, before it times out.
 */
const RECONCILE_GRACE_CALLS = 10;

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
  /** Set only when dispatching: a completion-only engine derives nothing. */
  private readonly tokenSecret: Uint8Array | undefined;
  private readonly callTimeoutMs: number;
  private readonly timers: Timers;
  private readonly concurrency: number;
  /** Whether the agent pass last hit its page cap, and said so. */
  private capReported = false;
  private caps?: Promise<Capabilities>;
  /**
   * Stage runs whose turn was in flight when the engine started and that
   * reconciliation has not settled yet (the harness could not be read).
   * The tick settles them as reconciliation would.
   */
  private readonly unreconciled = new Set<string>();
  /** Whether the start-up reconciliation has taken stock of the store. */
  private stocked = false;
  private reconciling?: Promise<void>;
  /** Harness turns an abort is being asked for right now. */
  private readonly aborting = new Set<string>();
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
    this.concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;
    if (!isPositiveInteger(this.concurrency)) {
      throw new Error("concurrency must be a positive integer");
    }
    for (const [agent, n] of Object.entries(o.wip ?? {})) {
      if (!isPositiveInteger(n)) {
        throw new Error(`wip for ${agent} must be a positive integer`);
      }
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
    this.tokenSecret = !this.dispatching
      ? undefined
      : o.tokenSecret
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
    const badArtifacts = checkArtifacts(p.artifacts);
    if (badArtifacts) return fail(badArtifacts);
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
      const invalid = checkFields(
        p.outcome,
        outcome.fields,
        fields,
        p.artifacts,
      );
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
      // The request is in the store; the tick asks once it can.
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

  /**
   * The start-up operation that settles what the store says was in flight
   * when the engine last stopped; `start()` calls it before the first tick.
   *
   * Every agent stage run with a turn in flight is read from the harness: a
   * turn that ended is classified as the tick would, one the harness no
   * longer knows ends its attempt `lost` (its retry policy applies, even
   * past its deadline), and one still running is kept. A turn that cannot
   * be read yet is kept and settled by a later tick; past its deadline it
   * waits for the harness at most ten call timeouts, then times out. Aborts
   * still due are asked again. Stage runs without a turn (waits, gates,
   * checks, actions) resume from their stored times and are not touched.
   * Every transition it writes names `engine:reconcile`.
   *
   * A later call only re-checks the turns the first one could not settle;
   * it never takes in turns started since, so their deadlines apply as on
   * any tick. Calling it again writes nothing new. A tick waits for a
   * reconciliation in progress. It does nothing when the engine only takes
   * completions.
   */
  reconcile(): Promise<void> {
    if (!this.dispatching) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    let ids: string[];
    try {
      // Taken in one synchronous step, before anything awaits, so a tick
      // never sees a start-up turn outside the set.
      if (!this.stocked) {
        for (const id of this.store.tx((t) => t.inFlightTurnIds())) {
          this.unreconciled.add(id);
        }
        this.stocked = true;
      }
      ids = [...this.unreconciled];
    } catch (err) {
      return Promise.reject(err);
    }
    this.reconciling = this.settleTurns(ids).finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async settleTurns(ids: string[]): Promise<void> {
    if (ids.length > TICK_BATCH) {
      this.report(`reconciling ${ids.length} turns in flight`);
    }
    let caps: Capabilities | undefined;
    try {
      caps = await this.capabilities();
    } catch (err) {
      this.report(err);
    }
    await eachLimit(ids, this.concurrency, async (id) => {
      try {
        const row = this.store.tx((t) => t.getStageRun(id));
        if (row?.state !== "working") {
          this.unreconciled.delete(id);
          return;
        }
        await this.observe(row, caps);
      } catch (err) {
        this.report(err);
      }
    });
    if (caps) await this.flushAborts(caps);
  }

  /** Forgets start-up turns that are no longer working. */
  private pruneUnreconciled(): void {
    if (this.unreconciled.size === 0) return;
    this.store.tx((t) => {
      for (const id of [...this.unreconciled]) {
        if (t.getStageRun(id)?.state !== "working") {
          this.unreconciled.delete(id);
        }
      }
    });
  }

  // --- the tick -----------------------------------------------------------

  private async walk(): Promise<void> {
    if (!this.dispatching) return;
    await this.reconciling?.catch(() => undefined);
    this.pruneUnreconciled();
    let caps: Capabilities | undefined;
    try {
      caps = await this.capabilities();
    } catch (err) {
      // Deadlines are still enforced, except that a turn found in flight at
      // start waits a grace past its own for the harness; aborts, turn ends
      // and dispatch wait for the capabilities.
      this.report(err);
    }
    // Turns first, so a continuation or retry they submit is dispatched in
    // the same pass. When more are in flight than one tick reads, the least
    // recently observed are taken, and marked, so every one is read in turn.
    const inFlight = this.store.tx((t) => {
      const now = this.clock.now();
      const rows = t.listStageRuns({ inFlight: true, limit: TICK_BATCH + 1 });
      if (rows.length <= TICK_BATCH) return rows;
      rows.length = TICK_BATCH;
      for (const row of rows) {
        t.updateStageRunIf(
          row.stageRunId,
          { state: row.state, attempt: row.attempt },
          { observedAt: now },
        );
      }
      return rows;
    });
    await eachLimit(inFlight, this.concurrency, async (row) => {
      try {
        await this.observe(row, caps);
      } catch (err) {
        // One broken stage run must not hold up the others.
        this.report(err);
      }
    });
    // The stages the tick runs itself need nothing from the harness.
    await this.runStages();
    if (!caps) return;
    try {
      await this.schedule(caps);
    } catch (err) {
      this.report(err);
    }
    // Last, so a harness slow to abort cannot hold up the work above.
    await this.flushAborts(caps);
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
    await eachLimit(due, this.concurrency, async (row) => {
      try {
        await this.runStage(row);
      } catch (err) {
        this.report(err);
      }
    });
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
   * A stage run reconciliation has not settled yet is settled here, as
   * reconciliation would: a turn the harness does not know is lost, even
   * past its deadline, since the restart killed it rather than the clock.
   */
  private async observe(
    row: StageRunRow,
    caps: Capabilities | undefined,
  ): Promise<void> {
    const id = row.stageRunId;
    const settling = this.unreconciled.has(id);
    const actor = settling ? RECONCILE_ACTOR : undefined;
    const now = this.clock.now();
    const overdue = row.state === "working" && deadlinePassed(row, now);
    if (overdue && !settling) {
      await this.timeOut(row, caps);
      return;
    }
    // A start-up turn waits for the harness past its deadline, but not for
    // ever: once the grace is over, a harness that cannot answer times it out.
    const graceOver =
      overdue &&
      row.deadlineAt !== null &&
      now > row.deadlineAt + RECONCILE_GRACE_CALLS * this.callTimeoutMs;
    const giveUp = async () => {
      this.unreconciled.delete(id);
      await this.timeOut(row, caps, actor);
    };
    if (!caps) {
      if (graceOver) await giveUp();
      return;
    }
    const adapterRunId = row.adapterRunId;
    if (
      adapterRunId === null ||
      !["working", "completed"].includes(row.state)
    ) {
      this.unreconciled.delete(id);
      this.commit((t, emit) => forgetTurn(this.txCtx(t, emit), row));
      return;
    }
    let outcome: RunOutcome;
    try {
      outcome = await this.call("readRunOutcome", () =>
        this.adapter.readRunOutcome(adapterRunId),
      );
    } catch (err) {
      // Read again on the next tick.
      if (settling) {
        this.report(`reading turn ${adapterRunId}: ${errorMessage(err)}`);
        if (graceOver) await giveUp();
      }
      return;
    }
    this.unreconciled.delete(id);
    if (outcome.state === "unknown") {
      // A completed turn has nothing left to tell. A working one the harness
      // no longer knows was lost in a restart; outside reconciliation it is
      // left to its deadline.
      if (row.state === "completed") {
        this.commit((t, emit) => forgetTurn(this.txCtx(t, emit), row));
      } else if (settling) {
        this.commit((t, emit) => recordLost(this.txCtx(t, emit, actor), row));
      }
      return;
    }
    if (overdue) {
      await this.timeOut(row, caps, actor);
      return;
    }
    if (outcome.state === "running") return;
    const ended = outcome;
    this.commit((t, emit) =>
      recordTurnEnd({ ...this.txCtx(t, emit, actor), caps }, row, ended),
    );
  }

  private async timeOut(
    row: StageRunRow,
    caps: Capabilities | undefined,
    actor?: string,
  ): Promise<void> {
    const abort = this.commit((t, emit) =>
      recordTimeout(this.txCtx(t, emit, actor), row),
    );
    // Without capabilities the request waits in the store for the tick.
    if (abort !== undefined && caps) await this.abort(abort, caps);
  }

  /**
   * Asks for the stored aborts that are due, earliest first, so one in
   * backoff never crowds out the others. Stops starting calls once
   * `ABORT_BUDGET_MS` have passed; the rest wait for the next tick.
   */
  private async flushAborts(caps: Capabilities): Promise<void> {
    const started = this.clock.now();
    const due = this.store.tx((t) =>
      t.listStageRuns({ abortDueBy: started, limit: TICK_BATCH }),
    );
    for (const row of due) {
      if (this.clock.now() - started >= ABORT_BUDGET_MS) return;
      if (row.abortRunId === null) continue;
      await this.abort(
        { stageRunId: row.stageRunId, adapterRunId: row.abortRunId },
        caps,
      );
    }
  }

  /**
   * Asks the harness to stop a turn, where it can. The request is dropped,
   * and logged, once the harness answers or when it cannot abort at all. A
   * call that fails is reported and asked again after a doubling backoff,
   * until `MAX_ABORT_ATTEMPTS` failures give it up.
   */
  private async abort(req: AbortRequest, caps: Capabilities): Promise<void> {
    if (this.aborting.has(req.adapterRunId)) return;
    this.aborting.add(req.adapterRunId);
    try {
      const abortTurn = this.adapter.abortTurn?.bind(this.adapter);
      if (!caps.canAbort || !abortTurn) {
        this.commit((t, emit) =>
          settleAbort(this.txCtx(t, emit), req, {
            aborted: false,
            reason: "the harness cannot abort turns",
          }),
        );
        return;
      }
      let aborted: boolean;
      try {
        aborted = await this.call("abortTurn", () =>
          abortTurn(req.adapterRunId),
        );
      } catch (err) {
        const error = errorMessage(err);
        this.report(`aborting turn ${req.adapterRunId}: ${error}`);
        this.commit((t, emit) => failAbort(this.txCtx(t, emit), req, error));
        return;
      }
      this.commit((t, emit) =>
        settleAbort(this.txCtx(t, emit), req, { aborted: aborted === true }),
      );
    } finally {
      this.aborting.delete(req.adapterRunId);
    }
  }

  /**
   * The agent pass: the submitted agent stage runs that may start a turn, in
   * admission order, as the scheduler decides. One whose deadline passed
   * while no pause held it times out first and takes no lane. A refused one
   * records why it waits (a pause also holds its deadline); an admitted one
   * is dispatched, one at a time.
   */
  private async schedule(caps: Capabilities): Promise<void> {
    const now = this.clock.now();
    const plan = this.store.tx((t) => {
      const working = t.listWorking();
      const holding = t.listLaneHolders();
      const limits = t.listLimits(now);
      const runs = new Map<string, RunRow>();
      const slots = new Map<string, AgentSlot>();
      const describe = (row: StageRunRow): AgentSlot | undefined => {
        if (slots.has(row.stageRunId)) return slots.get(row.stageRunId);
        try {
          const run = runs.get(row.runId) ?? t.getRun(row.runId);
          if (!run) return undefined;
          runs.set(run.runId, run);
          const pinned = this.pinned.of(t, run);
          const stage = pinned.def.stages[row.stage];
          if (stage?.type !== "agent") return undefined;
          const slot = {
            agent: stage.agent,
            sessionKey: sessionKeyOf(run, stage),
            providers: pinned.def.providers,
          };
          slots.set(row.stageRunId, slot);
          return slot;
        } catch (err) {
          // One stage run whose definition cannot be read must not stop
          // the pass; it is left out of it.
          this.report(`scheduling ${row.stageRunId}: ${errorMessage(err)}`);
          return undefined;
        }
      };
      for (const row of [...working, ...holding]) describe(row);
      const stageOf = (row: StageRunRow) => slots.get(row.stageRunId);
      const ctx = {
        working,
        holding,
        limits,
        capabilities: caps,
        wip: (agent: string) => this.wipOf(agent),
        runs,
        now,
        stageOf,
      };
      const free = caps.maxConcurrent - lanesTaken(ctx);
      const expired: StageRunRow[] = [];
      const open: StageRunRow[] = [];
      // Page on while lanes are free and refused stage runs fill the page:
      // the store's order is the scheduler's, so a later page never changes
      // what an earlier one decided.
      let decision = admit(open, ctx);
      let capped = false;
      for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
        const rows = t.listDispatchable(TICK_BATCH, page * TICK_BATCH);
        for (const row of rows) {
          const slot = describe(row);
          const due =
            slot !== undefined &&
            deadlinePassed(row, now) &&
            pauseReason(row, slot.providers, limits, caps, now) === undefined;
          (due ? expired : open).push(row);
        }
        decision = admit(open, ctx);
        if (rows.length < TICK_BATCH || decision.admit.length >= free) break;
        capped = page === MAX_CANDIDATE_PAGES - 1;
      }
      // Reported once, and again only after a pass below the cap.
      if (capped && !this.capReported) {
        this.report(
          `more than ${MAX_CANDIDATE_PAGES * TICK_BATCH} stage runs wait for dispatch; the rest wait for a later tick`,
        );
      }
      this.capReported = capped;
      const byId = new Map(open.map((row) => [row.stageRunId, row]));
      const waiting = decision.waiting.flatMap(({ id, reason }) => {
        const row = byId.get(id);
        return row ? [{ row, reason }] : [];
      });
      const admitted = decision.admit.flatMap((id) => {
        const row = byId.get(id);
        const slot = row && stageOf(row);
        return row && slot ? [{ row, providers: slot.providers }] : [];
      });
      return { expired, waiting, admitted };
    });
    for (const row of plan.expired) {
      try {
        await this.timeOut(row, caps);
      } catch (err) {
        this.report(err);
      }
    }
    this.commit((t, emit) => {
      const c = this.txCtx(t, emit);
      for (const { row, reason } of plan.waiting) {
        recordWait(c, row, reason, isPause(reason));
      }
    });
    for (const { row: seen, providers } of plan.admitted) {
      try {
        // A turn started earlier in this pass may have hit a usage limit:
        // pauses are read again before each start.
        const row = this.commit((t, emit) => {
          const c = this.txCtx(t, emit);
          return recordAdmit(c, seen, (now) =>
            pauseReason(now, providers, t.listLimits(c.now), caps, c.now),
          );
        });
        if (!row) continue;
        if (deadlinePassed(row, this.clock.now())) {
          await this.timeOut(row, caps);
          continue;
        }
        await this.dispatch(row.stageRunId, caps);
      } catch (err) {
        this.report(err);
      }
    }
  }

  /** Most working stage runs `agent` may have on one session key. */
  private wipOf(agent: string): number {
    const wip = this.o.wip;
    return wip && Object.hasOwn(wip, agent)
      ? (wip[agent] ?? DEFAULT_WIP)
      : DEFAULT_WIP;
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
      // message under the same key. A failure is logged once, and again only
      // when its error changes, so a harness down for hours does not grow
      // the log every tick.
      const error = errorMessage(err);
      this.store.tx((t) => {
        const row = t.getStageRun(stageRunId);
        if (!row || row.startError === error) return;
        t.updateStageRunIf(
          stageRunId,
          { state: row.state, attempt: row.attempt },
          { startError: error },
        );
        t.appendTransition({
          runId: row.runId,
          stageRunId,
          fromState: row.state,
          toState: row.state,
          event: "turn_start_failed",
          outcome: null,
          actor: ENGINE_ACTOR,
          at: this.clock.now(),
          detail: { dispatchSeq: prep.dispatchSeq, error },
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

    const sessionKey = sessionKeyOf(run, stage);
    // A dispatch recorded but whose turn was never recorded is resent under
    // the same key, so a harness that did accept it does not start it twice.
    // The token is derived from the attempt, so the resent message is the
    // same one, and a continuation carries the first turn's token.
    if (this.tokenSecret === undefined) {
      throw new Error("a completion-only engine starts no turns");
    }
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
   * Step three of a dispatch. Returns the harness turn to abort when the
   * stage run moved on while the turn was being started.
   */
  private recordTurn(
    t: StoreTx,
    prep: Prepared,
    adapterRunId: string,
    emit: EmitFn,
  ): AbortRequest | undefined {
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
          startError: null,
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
    } else {
      t.updateStageRunIf(
        row.stageRunId,
        { state: row.state, attempt: row.attempt },
        abortRequest(adapterRunId, now),
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
    if (!completed) {
      logAbort(t, row, "abort_requested", ENGINE_ACTOR, now, { adapterRunId });
    }
    return completed ? undefined : { stageRunId: row.stageRunId, adapterRunId };
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

  // --- plumbing -----------------------------------------------------------

  private txCtx(t: StoreTx, emit: EmitFn, actor?: string): TxCtx {
    const c: TxCtx = { t, pinned: this.pinned, now: this.clock.now(), emit };
    if (actor !== undefined) c.actor = actor;
    return c;
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
    const message = errorMessage(err);
    const onError = this.o.onError;
    if (!onError) {
      console.error(`sekaisen: ${message}`);
      return;
    }
    try {
      if (typeof err === "string") onError(message);
      else onError(message, err);
    } catch {
      // The handler's failure is its own; the engine carries on.
    }
  }
}

function isPositiveInteger(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}
