import type { RunStatus, StageRunState } from "../store/types.js";

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

/** Queues an event; queued events are emitted once the transaction commits. */
export type EmitFn = <E extends EngineEvent>(
  event: E,
  payload: EngineEvents[E],
) => void;

type Listener = (payload: never) => void;

/** A typed emitter whose listeners can never break the engine. */
export class Emitter {
  private readonly listeners = new Map<EngineEvent, Set<Listener>>();

  on<E extends EngineEvent>(
    event: E,
    fn: (e: EngineEvents[E]) => void,
  ): Disposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const listener = fn as Listener;
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  }

  emit<E extends EngineEvent>(event: E, payload: EngineEvents[E]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as (e: EngineEvents[E]) => void)(payload);
      } catch {
        // A listener's failure is its own; the engine carries on.
      }
    }
  }

  /** A queue to fill inside a transaction and the function that emits it after. */
  queue(): { emit: EmitFn; flush(): void } {
    const queued: Array<() => void> = [];
    return {
      emit: (event, payload) => {
        queued.push(() => this.emit(event, payload));
      },
      flush: () => {
        for (const e of queued) e();
      },
    };
  }
}
