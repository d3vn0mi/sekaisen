import path from "node:path";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import { VirtualClock } from "../../../src/engine/clock.js";
import {
  type DefinitionSource,
  Engine,
  type EngineOptions,
} from "../../../src/engine/engine.js";
import {
  type LoadedDefinition,
  loadDefinition,
} from "../../../src/format/load.js";
import type { Definition, Stage } from "../../../src/format/types.js";
import { createRegistry } from "../../../src/host/registry.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type { Store } from "../../../src/store/types.js";

export const REVIEW_LOOP = path.resolve(
  "test/fixtures/defs/review-loop/pipeline.yaml",
);

export async function reviewLoop(): Promise<LoadedDefinition> {
  const loaded = await loadDefinition(REVIEW_LOOP);
  if (loaded.problems.length > 0) throw new Error(loaded.problems.join("\n"));
  return loaded;
}

/** A definition source a test can swap under a running engine. */
export class SwapSource implements DefinitionSource {
  readonly defs = new Map<string, LoadedDefinition>();

  constructor(...loaded: LoadedDefinition[]) {
    for (const l of loaded) this.defs.set(l.def.id, l);
  }

  current(pipelineId: string): LoadedDefinition | undefined {
    return this.defs.get(pipelineId);
  }
}

export interface Rig {
  engine: Engine;
  adapter: FakeAdapter;
  store: Store;
  clock: VirtualClock;
  source: SwapSource;
}

export async function rig(over: Partial<EngineOptions> = {}): Promise<Rig> {
  const adapter = new FakeAdapter();
  const store = openSqliteStore(":memory:");
  const clock = new VirtualClock(1_000_000);
  const source = new SwapSource(await reviewLoop());
  const engine = new Engine({
    store,
    adapter,
    registry: createRegistry(),
    clock,
    definitions: source,
    ...over,
  });
  return { engine, adapter, store, clock, source };
}

/** The completion token a dispatched message carries. */
export function tokenOf(message: string): string {
  const m = /Your completion token is: (\S+)/.exec(message);
  if (!m?.[1]) throw new Error("no token in message");
  return m[1];
}

/** The token of the most recent `startTurn` call. */
export function lastToken(adapter: FakeAdapter): string {
  const call = adapter.calls.at(-1);
  if (!call) throw new Error("no turn was started");
  return tokenOf(call.message);
}

/** The review-loop definition under another hash, edited by `edit`. */
export async function variant(
  hash: string,
  edit: (def: Definition, briefs: Record<string, string>) => void,
): Promise<LoadedDefinition> {
  const base = await reviewLoop();
  const def = structuredClone(base.def);
  const briefs = { ...base.briefs };
  edit(def, briefs);
  return { ...base, hash, def, briefs };
}

/** A loaded definition written inline, already in its parsed shape. */
export function inline(
  def: Partial<Definition> & {
    id: string;
    start: string;
    stages: Record<string, Stage>;
  },
  briefs: Record<string, string> = {},
): LoadedDefinition {
  return {
    file: `${def.id}/pipeline.yaml`,
    dir: def.id,
    def: { format: 1, version: 1, providers: "fleet", extensions: {}, ...def },
    hash: `inline-${def.id}`,
    briefs,
    problems: [],
  };
}
