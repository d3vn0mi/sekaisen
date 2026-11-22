import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeAdapter } from "../../../src/adapter/fake.js";
import { main } from "../../../src/cli/main.js";
import { VirtualClock } from "../../../src/engine/clock.js";
import { Engine } from "../../../src/engine/engine.js";
import { loadDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import { lastToken } from "../engine/engine-helpers.js";

const FIX_LOOP = path.resolve("test/fixtures/defs/fix-loop/pipeline.yaml");

const dirs: string[] = [];

/** Removes every directory `tempDir` made; call from `afterAll`. */
export function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-cli-"));
  dirs.push(dir);
  return dir;
}

export async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err, lines: out.trimEnd().split("\n") };
}

export interface Fixture {
  file: string;
  /** Ended `completed`, its drafter turn reported on a provider. */
  done: string;
  /** Waiting at the review gate after three failed checks. */
  gated: string;
}

/**
 * A store file written by the real engine on the fix-loop definition: one
 * run that completed and one that waits at an operator gate.
 */
export async function makeStore(): Promise<Fixture> {
  const file = path.join(tempDir(), "runs.sqlite");
  const store = openSqliteStore(file);
  const adapter = new FakeAdapter();
  const clock = new VirtualClock(1_700_000_000_000);
  const loaded = await loadDefinition(FIX_LOOP);
  const registry = createRegistry();
  registry.actions.set("demo.publish", async () => undefined);
  const engine = new Engine({
    store,
    adapter,
    registry,
    clock,
    definitions: {
      current: (id) => (id === loaded.def.id ? loaded : undefined),
    },
  });
  const finish = async (outcome: string, fields?: unknown) => {
    await engine.tick();
    const r = await engine.complete({
      token: lastToken(adapter),
      outcome,
      ...(fields === undefined ? {} : { fields }),
    });
    if (!r.ok) throw new Error(r.error);
  };

  const done = (await engine.startRun("fix-loop", { topic: "rust" })).runId;
  await engine.tick();
  adapter.setOutcome("fr_1", {
    state: "ended",
    ending: "ok",
    runtime: { provider: "demo-provider", model: "demo-model" },
  });
  await engine.tick();
  await finish("drafted");
  await finish("pass");
  await engine.tick();

  clock.advance(60_000);
  const gated = (await engine.startRun("fix-loop", { topic: "go" })).runId;
  for (let i = 0; i < 3; i++) {
    await finish("drafted");
    await finish("fail");
  }
  await engine.tick();
  store.close();
  return { file, done, gated };
}
