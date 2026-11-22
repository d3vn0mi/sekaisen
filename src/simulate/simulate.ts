import { FakeAdapter } from "../adapter/fake.js";
import type { StartTurn } from "../adapter/types.js";
import { guardContext } from "../engine/advance.js";
import { BRIEF_FOOTER } from "../engine/brief.js";
import { VirtualClock } from "../engine/clock.js";
import { Engine } from "../engine/engine.js";
import type { LoadedDefinition } from "../format/load.js";
import type { Definition } from "../format/types.js";
import type { GuardContext } from "../guard/eval.js";
import { createRegistry, type HostRegistry } from "../host/registry.js";
import { openSqliteStore } from "../store/sqlite.js";
import type {
  RunStatus,
  StageRunRow,
  Store,
  StoreTx,
  SyncResult,
  TransitionRow,
} from "../store/types.js";
import {
  type Coverage,
  coverage,
  logLine,
  type TransitionLogLine,
} from "./coverage.js";
import { minimalFields } from "./minimal.js";
import {
  hostNames,
  type Script,
  type SimEnding,
  type Visit,
} from "./script.js";

export type { TransitionLogLine } from "./coverage.js";

/**
 * A choice the script leaves open, offered to `SimulateOptions.decide`: an
 * agent turn started (`turn`), an operator gate opened (`gate`), a polling
 * gate polled for the first time in an opening (`poll`; the answer holds
 * for every poll of that opening), or a check or an action called.
 */
export interface Decision {
  kind: "turn" | "gate" | "poll" | "check" | "action";
  stage: string;
  stageRunId: string;
  /** 0 for the first attempt of a visit, plus one per retry. */
  retryIndex: number;
  /** Turns dispatched on this attempt so far. */
  turnsUsed: number;
  /** What the run's guards read at this moment. */
  guard: GuardContext;
  /** Ends the simulation once this decision is answered; the result then carries a `stopped` problem. */
  stop(): void;
}

/**
 * How a decision goes: a visit for a turn or a gate, else a check's
 * outcome, whether an action succeeds, whether a polled fact holds.
 */
export type Answer =
  | Visit
  | { kind: "check"; outcome: string }
  | { kind: "action"; ok: boolean }
  | { kind: "poll"; holds: boolean };

export interface SimulationResult {
  status: RunStatus;
  /** True when the run ended on one of the definition's `end` stages. */
  reachedEnd: boolean;
  log: TransitionLogLine[];
  /** Edge ids (`<stage>.<outcome>[<branch>]`) in definition order; `onCancel` is left out. */
  coverage: Coverage;
  /**
   * What kept the simulation from running as scripted: `stalled` (nothing
   * is due and the run has not ended), `max_steps`, `completion_refused`,
   * `stopped` (a decision asked to stop).
   */
  problems: string[];
  /**
   * Scripted entries that never took effect because the run moved past
   * them first (a turn that timed out, a gate that timed out): worth
   * knowing, not a problem.
   */
  notes: string[];
  /** Virtual time from the start of the run to the end of the simulation. */
  elapsedMs: number;
}

export interface SimulateOptions {
  /** Most ticks before the simulation gives up; 1000 by default. */
  maxSteps?: number;
  /**
   * Answers each decision the script has no entry for; undefined keeps the
   * default (the first outcome, success, a fact that holds).
   */
  decide?: (d: Decision) => Answer | undefined;
}

/** Who the simulator's own transitions (start, gate answers) name. */
export const SIMULATOR_ACTOR = "simulator";

const DEFAULT_MAX_STEPS = 1000;
/** Where the virtual clock starts: 2026-01-01T00:00:00Z. */
const START = Date.UTC(2026, 0, 1);
/** Tokens never leave the simulation, so a fixed secret is enough. */
const TOKEN_SECRET = new Uint8Array(32);
const LIVE = ["submitted", "working", "input_required"] as const;
const ENDED: RunStatus[] = ["completed", "failed", "canceled"];

/**
 * Runs `script` against the real engine: an in-memory store, a virtual
 * clock and a harness whose turns answer as the script says. Time only
 * moves when nothing is left to do now, straight to the next moment
 * something is due, so a simulation never sleeps.
 */
export async function simulate(
  loaded: LoadedDefinition,
  script: Script,
  opts: SimulateOptions = {},
): Promise<SimulationResult> {
  if (loaded.problems.length > 0) {
    throw new Error(
      `definition ${loaded.def.id} has problems: ${loaded.problems.join("; ")}`,
    );
  }
  const store = openSqliteStore(":memory:");
  try {
    return await new Simulation(loaded, script, store, opts.decide).run(
      opts.maxSteps ?? DEFAULT_MAX_STEPS,
    );
  } finally {
    store.close();
  }
}

/** A harness that notes each turn it starts for the first time. */
class ScriptedAdapter extends FakeAdapter {
  readonly newTurns: Array<{ runId: string; message: string }> = [];
  private readonly seen = new Set<string>();

  override async startTurn(p: StartTurn): Promise<{ runId: string }> {
    const r = await super.startTurn(p);
    // A resend under a key the harness knows is not a new turn.
    if (!this.seen.has(r.runId)) {
      this.seen.add(r.runId);
      this.newTurns.push({ runId: r.runId, message: p.message });
    }
    return r;
  }
}

/** A turn's visit the simulator plays: an outcome, or an ending other than a timeout. */
type Played =
  | Extract<Visit, { kind: "outcome" }>
  | (Extract<Visit, { kind: "ending" }> & {
      ending: Exclude<SimEnding, "timeout">;
    });

/** A scripted answer waiting for its time. */
type Pending =
  | {
      kind: "turn";
      dueAt: number;
      stageRunId: string;
      stage: string;
      adapterRunId: string;
      token: string;
      visit: Played;
    }
  | {
      kind: "gate";
      dueAt: number;
      stageRunId: string;
      stage: string;
      outcome: string;
    };

class Simulation {
  private readonly def: Definition;
  private readonly clock = new VirtualClock(START);
  private readonly adapter = new ScriptedAdapter();
  private readonly registry: HostRegistry;
  private engine: Engine;
  private readonly cursors = new Map<string, number>();
  private pending: Pending[] = [];
  private turnsTaken = 0;
  private readonly gatesTaken = new Set<string>();
  private readonly problems: string[] = [];
  private readonly notes: string[] = [];
  /** Whether a polled fact holds, by stage run, once a decision said so. */
  private readonly polls = new Map<string, boolean>();
  private stopRequested = false;

  constructor(
    private readonly loaded: LoadedDefinition,
    private readonly script: Script,
    private readonly store: Store,
    private readonly decide: SimulateOptions["decide"],
  ) {
    this.def = loaded.def;
    this.registry = this.hostFunctions();
    this.engine = this.newEngine();
  }

  async run(maxSteps: number): Promise<SimulationResult> {
    const { runId } = await this.engine.startRun(
      this.def.id,
      this.script.inputs,
      { actor: SIMULATOR_ACTOR },
    );
    let steps = 0;
    while (!this.ended(runId)) {
      if (this.stopRequested) {
        this.problems.push("stopped: a decision ended the simulation");
        break;
      }
      if (steps >= maxSteps) {
        this.problems.push(
          `max_steps: the run did not end within ${maxSteps} ticks`,
        );
        break;
      }
      steps++;
      const before = this.transitionCount(runId);
      await this.engine.tick();
      this.take(runId);
      const resolved = await this.resolveDue();
      if (resolved || this.transitionCount(runId) !== before) continue;
      const next = this.nextWake();
      if (next === undefined) {
        this.problems.push("stalled: nothing is due and the run has not ended");
        break;
      }
      this.clock.set(next);
    }
    for (const p of this.pending) if (!this.stillWaiting(p)) this.drop(p);
    return this.result(runId);
  }

  // --- the scripted world -------------------------------------------------

  private newEngine(): Engine {
    return new Engine({
      store: this.store,
      adapter: this.adapter,
      registry: this.registry,
      clock: this.clock,
      definitions: {
        current: (id) => (id === this.def.id ? this.loaded : undefined),
      },
      tokenSecret: TOKEN_SECRET,
    });
  }

  /**
   * Checks, actions and facts for every name the definition calls,
   * answering from the script, then from `decide`, then by default.
   */
  private hostFunctions(): HostRegistry {
    const registry = createRegistry();
    for (const name of hostNames(this.def, "check")) {
      registry.checks.set(name, async (ctx) => {
        const scripted = this.nextOf(`check:${name}`, this.script.checks[name]);
        if (scripted !== undefined) return scripted;
        const decided = this.decided("check", ctx.runId, ctx.stage);
        if (decided !== undefined) return decided.outcome;
        const stage = this.def.stages[ctx.stage];
        return stage?.type === "check"
          ? (Object.keys(stage.outcomes)[0] ?? "")
          : "";
      });
    }
    for (const name of hostNames(this.def, "action")) {
      registry.actions.set(name, async (ctx) => {
        const scripted =
          this.nextOf(`action:${name}`, this.script.actions[name]) ??
          (this.decided("action", ctx.runId, ctx.stage)?.ok === false
            ? "fail"
            : "ok");
        if (scripted === "fail") throw new Error(`action ${name} failed`);
      });
    }
    for (const name of hostNames(this.def, "fact")) {
      registry.facts.set(name, async (ctx) => {
        const scripted = this.nextOf(`fact:${name}`, this.script.facts[name]);
        if (scripted !== undefined) return scripted;
        const row = this.liveRow(ctx.runId, ctx.stage);
        if (row === undefined) return true;
        let holds = this.polls.get(row.stageRunId);
        if (holds === undefined) {
          holds =
            this.decided("poll", ctx.runId, ctx.stage, row)?.holds ?? true;
          this.polls.set(row.stageRunId, holds);
        }
        return holds;
      });
    }
    return registry;
  }

  /** The live stage run of `stage` in the run, if any. */
  private liveRow(runId: string, stage: string): StageRunRow | undefined {
    return this.store.tx((t) =>
      t
        .listStageRuns({ state: [...LIVE], limit: 1000 })
        .find((row) => row.runId === runId && row.stage === stage),
    );
  }

  /**
   * Asks `decide` how a decision goes. Undefined without `decide`, when it
   * keeps the default, or when the stage run is gone; throws when it
   * answers with the wrong kind.
   */
  private decided<K extends "check" | "action" | "poll">(
    kind: K,
    runId: string,
    stage: string,
    row = this.liveRow(runId, stage),
  ): Extract<Answer, { kind: K }> | undefined {
    const answer = this.ask(kind, row);
    if (answer === undefined) return undefined;
    if (answer.kind !== kind) {
      throw new Error(
        `decide answered a ${kind} at ${stage} with a ${answer.kind}`,
      );
    }
    return answer as Extract<Answer, { kind: K }>;
  }

  private ask(
    kind: Decision["kind"],
    row: StageRunRow | undefined,
  ): Answer | undefined {
    if (this.decide === undefined || row === undefined) return undefined;
    return this.decide({
      kind,
      stage: row.stage,
      stageRunId: row.stageRunId,
      retryIndex: row.retryIndex,
      turnsUsed: row.turnsUsed,
      guard: this.guardView(row.runId),
      stop: () => {
        this.stopRequested = true;
      },
    });
  }

  /** The run's guard view, each read in a transaction of its own. */
  private guardView(runId: string): GuardContext {
    const inTx = (t: StoreTx): GuardContext => {
      const run = t.getRun(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      return guardContext(t, run);
    };
    return {
      count: (stage, outcome) =>
        this.store.tx((t) => inTx(t).count(stage, outcome)),
      attempts: (stage) => this.store.tx((t) => inTx(t).attempts(stage)),
      field: (stage, name) =>
        this.store.tx((t) => inTx(t).field(stage, name) as SyncResult<unknown>),
      input: (path) =>
        this.store.tx((t) => inTx(t).input(path) as SyncResult<unknown>),
    };
  }

  /** The next unused entry of a scripted list, or undefined once it runs out. */
  private nextOf<T>(key: string, list: T[] | undefined): T | undefined {
    const i = this.cursors.get(key) ?? 0;
    this.cursors.set(key, i + 1);
    return list?.[i];
  }

  /**
   * The stage run's next visit: scripted, decided, or the default (the
   * first outcome, at once, with the smallest fields its schema accepts).
   */
  private visitOf(row: StageRunRow): Visit {
    const scripted = this.nextOf(
      `stage:${row.stage}`,
      this.script.stages[row.stage],
    );
    if (scripted) return scripted;
    const gate = this.def.stages[row.stage]?.type === "gate";
    const answer = this.ask(gate ? "gate" : "turn", row);
    if (answer === undefined) return defaultVisit(this.def, row.stage);
    const fits = gate
      ? answer.kind === "resolve" ||
        (answer.kind === "ending" && answer.ending === "timeout")
      : answer.kind === "outcome" || answer.kind === "ending";
    if (!fits) {
      throw new Error(
        `decide answered a ${gate ? "gate" : "turn"} at ${row.stage} with a ${answer.kind}`,
      );
    }
    return answer as Visit;
  }

  /** Gives each turn started and each operator gate opened since the last step its scripted answer. */
  private take(runId: string): void {
    const now = this.clock.now();
    const live = this.store.tx((t) =>
      t
        .listStageRuns({ state: [...LIVE], limit: 1000 })
        .filter((row) => row.runId === runId),
    );
    for (const turn of this.adapter.newTurns.slice(this.turnsTaken)) {
      const row = live.find((r) => r.adapterRunId === turn.runId);
      if (!row) continue;
      const visit = this.visitOf(row);
      // A turn scripted to time out is left running until its deadline.
      if (!isPlayed(visit)) continue;
      this.pending.push({
        kind: "turn",
        dueAt: now + visit.after,
        stageRunId: row.stageRunId,
        stage: row.stage,
        adapterRunId: turn.runId,
        token: tokenOf(turn.message),
        visit,
      });
    }
    this.turnsTaken = this.adapter.newTurns.length;
    for (const row of live) {
      if (
        row.state !== "input_required" ||
        this.gatesTaken.has(row.stageRunId)
      ) {
        continue;
      }
      this.gatesTaken.add(row.stageRunId);
      const visit = this.visitOf(row);
      // A gate scripted to time out is never answered.
      if (visit.kind !== "resolve") continue;
      this.pending.push({
        kind: "gate",
        dueAt: now + visit.after,
        stageRunId: row.stageRunId,
        stage: row.stage,
        outcome: visit.outcome,
      });
    }
  }

  /**
   * Plays every scripted answer that is due, earliest first. One the run
   * has moved past (its turn timed out, its gate timed out) is dropped with
   * a note. True when any was played.
   */
  private async resolveDue(): Promise<boolean> {
    const now = this.clock.now();
    const due = this.pending
      .filter((p) => p.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
    this.pending = this.pending.filter((p) => p.dueAt > now);
    let played = false;
    for (const p of due) {
      if (!this.stillWaiting(p)) {
        this.drop(p);
        continue;
      }
      played = true;
      if (p.kind === "gate") {
        await this.engine.resolveGate(p.stageRunId, p.outcome, SIMULATOR_ACTOR);
        continue;
      }
      await this.answer(p);
    }
    return played;
  }

  /** Ends a turn as its visit says. */
  private async answer(p: Extract<Pending, { kind: "turn" }>): Promise<void> {
    const { visit, adapterRunId } = p;
    if (visit.kind === "outcome") {
      const r = await this.engine.complete({
        token: p.token,
        outcome: visit.outcome,
        fields: visit.fields,
      });
      if (!r.ok) {
        this.problems.push(`completion_refused: ${p.stage}: ${r.error}`);
      }
      this.adapter.setOutcome(adapterRunId, { state: "ended", ending: "ok" });
      return;
    }
    switch (visit.ending) {
      case "no_result":
        this.adapter.setOutcome(adapterRunId, { state: "ended", ending: "ok" });
        return;
      case "turn_error":
        this.adapter.setOutcome(adapterRunId, {
          state: "ended",
          ending: "error",
          error: "the simulated turn failed",
        });
        return;
      case "usage_limited": {
        const resets =
          visit.resets === undefined
            ? ""
            : ` · resets ${new Date(this.clock.now() + visit.resets).toISOString()}`;
        this.adapter.setOutcome(adapterRunId, {
          state: "ended",
          ending: "error",
          error: `You've hit your usage limit${resets}`,
        });
        return;
      }
      case "lost":
        // The harness forgets the turn and the engine restarts: only the
        // start-up reconciliation classifies a turn as lost.
        this.adapter.setOutcome(adapterRunId, { state: "unknown" });
        this.engine = this.newEngine();
        await this.engine.reconcile();
        return;
    }
  }

  /** Notes a scripted answer the run moved past before it was due. */
  private drop(p: Pending): void {
    const what =
      p.kind === "gate"
        ? `resolve ${p.outcome}`
        : p.visit.kind === "outcome"
          ? `outcome ${p.visit.outcome}`
          : `ending ${p.visit.ending}`;
    this.notes.push(
      `overtaken: ${p.stage}: ${what} was due after the stage run had moved on`,
    );
  }

  /** True while the stage run a scripted answer is for still waits for it. */
  private stillWaiting(p: Pending): boolean {
    const row = this.store.tx((t) => t.getStageRun(p.stageRunId));
    if (!row) return false;
    return p.kind === "gate"
      ? row.state === "input_required"
      : row.state === "working" && row.adapterRunId === p.adapterRunId;
  }

  /** The next moment after now when anything is due, if any. */
  private nextWake(): number | undefined {
    const now = this.clock.now();
    this.pending = this.pending.filter((p) => {
      if (this.stillWaiting(p)) return true;
      this.drop(p);
      return false;
    });
    const times = this.pending.map((p) => p.dueAt);
    this.store.tx((t) => {
      for (const row of t.listStageRuns({ state: [...LIVE], limit: 1000 })) {
        times.push(...wakeTimes(row));
        const gate = t.getGate(row.stageRunId);
        if (gate?.remindAt != null) times.push(gate.remindAt);
        if (gate?.pollAt != null) times.push(gate.pollAt);
      }
      for (const limit of t.listLimits(now)) times.push(limit.pausedUntil);
    });
    const future = times.filter((x) => x > now);
    return future.length === 0 ? undefined : Math.min(...future);
  }

  // --- the result ---------------------------------------------------------

  private ended(runId: string): boolean {
    const run = this.store.tx((t) => t.getRun(runId));
    return run !== undefined && ENDED.includes(run.status);
  }

  private transitionCount(runId: string): number {
    return this.store.tx((t) => t.transitions(runId, 1)[0]?.id ?? 0);
  }

  private result(runId: string): SimulationResult {
    return this.store.tx((t) => {
      const run = t.getRun(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      const rows = t.transitions(runId);
      const stages = new Map<string, string>();
      const stageOf = (row: TransitionRow): string | undefined => {
        if (row.stageRunId === null) return undefined;
        if (!stages.has(row.stageRunId)) {
          const sr = t.getStageRun(row.stageRunId);
          if (sr) stages.set(row.stageRunId, sr.stage);
        }
        return stages.get(row.stageRunId);
      };
      const log = rows.map((row, i) => logLine(i + 1, row, stageOf(row)));
      return {
        status: run.status,
        reachedEnd: rows.some((row) => row.event === "run_ended"),
        log,
        coverage: coverage(this.def, rows, stageOf),
        problems: [...this.problems],
        notes: [...this.notes],
        elapsedMs: this.clock.now() - START,
      };
    });
  }
}

/** A stage's default visit: its first outcome, at once, with minimal fields. */
function defaultVisit(def: Definition, stageId: string): Visit {
  const stage = def.stages[stageId];
  if (stage?.type === "gate") {
    const first = Object.keys(stage.outcomes)[0] ?? "";
    return { kind: "resolve", outcome: first, after: 0 };
  }
  const [first = "", outcome] =
    stage?.type === "agent" ? (Object.entries(stage.outcomes)[0] ?? []) : [];
  return {
    kind: "outcome",
    outcome: first,
    fields: outcome?.fields
      ? (minimalFields(outcome.fields) as Record<string, unknown>)
      : {},
    after: 0,
  };
}

function isPlayed(visit: Visit): visit is Played {
  return (
    visit.kind === "outcome" ||
    (visit.kind === "ending" && visit.ending !== "timeout")
  );
}

/** The completion token in a turn's message, read from the brief footer's token line. */
function tokenOf(message: string): string {
  const line = BRIEF_FOOTER.split("\n").find((l) => l.includes("{token}"));
  const [prefix = "", suffix = ""] = (line ?? "").split("{token}");
  const found = message
    .split("\n")
    .filter((l) => l.startsWith(prefix) && l.endsWith(suffix))
    .at(-1);
  if (found === undefined) throw new Error("a turn's message carries no token");
  return found.slice(prefix.length, found.length - suffix.length);
}

/** When the engine next acts on a live stage run by itself. */
function wakeTimes(row: StageRunRow): number[] {
  const times: number[] = [];
  if (row.wakeAt !== null) times.push(row.wakeAt);
  // A pause holding the row stops its deadline; the pause's end is a wake.
  if (row.deadlineAt !== null && row.heldSince === null) {
    times.push(row.deadlineAt);
  }
  if (row.abortNextAt !== null) times.push(row.abortNextAt);
  return times;
}
