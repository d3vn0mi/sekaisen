import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { MemoryAdapter } from "../../../docs/examples/memory-adapter.js";
import { VirtualClock } from "../../../src/engine/clock.js";
import { Engine } from "../../../src/engine/engine.js";
import { loadDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import { tokenOf } from "../engine/engine-helpers.js";

test("the example adapter in docs/adapter.md runs a pipeline", async () => {
  const loaded = await loadDefinition(
    path.resolve("test/fixtures/defs/fix-loop/pipeline.yaml"),
  );
  const adapter = new MemoryAdapter();
  const registry = createRegistry();
  registry.actions.set("demo.publish", async () => undefined);
  const store = openSqliteStore(":memory:");
  const engine = new Engine({
    store,
    adapter,
    registry,
    clock: new VirtualClock(1_000_000),
    definitions: { current: () => loaded },
  });
  const { runId } = await engine.startRun("fix-loop", { topic: "rust" });
  for (const outcome of ["drafted", "pass"]) {
    await engine.tick();
    const turn = [...adapter.turns.values()].at(-1);
    if (!turn) throw new Error("no turn started");
    expect(turn.start.sessionKey).toBe(`run:${runId}:${turn.start.agent}`);
    const r = await engine.complete({
      token: tokenOf(turn.start.message),
      outcome,
    });
    expect(r.ok).toBe(true);
  }
  await engine.tick();
  expect(engine.status(runId).run.status).toBe("completed");
  expect(
    [...adapter.turns.values()].map((t) => t.start.idempotencyKey),
  ).toEqual([`${runId}:draft:1`, `${runId}:check:1`]);
  store.close();
});

test("docs/adapter.md embeds the example file verbatim", () => {
  const doc = readFileSync("docs/adapter.md", "utf8");
  const example = readFileSync("docs/examples/memory-adapter.ts", "utf8");
  expect(doc).toContain(`\`\`\`ts\n${example}\`\`\`\n`);
});
