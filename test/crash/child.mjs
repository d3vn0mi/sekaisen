// Starts a run on a file store and kills its own process in the middle of
// the first dispatch, as a crash would.
//
// Usage: node child.mjs <built> <store> <definition> <record> <mode> <secret>
//   built       directory holding the compiled sources
//   store       the store file
//   definition  the pipeline definition to start
//   record      where the turn the harness accepted is written, as JSON
//   mode        before-record: die once the harness accepted the turn, before
//               the engine records it; after-record: die once it is recorded
//   secret      the token secret, as hex
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [built, file, definition, record, mode, secret] = process.argv.slice(2);
if (!["before-record", "after-record"].includes(mode ?? "")) {
  throw new Error(`unknown mode ${mode}`);
}
const load = (name) => import(pathToFileURL(path.join(built, name)).href);
const { FakeAdapter } = await load("adapter/fake.js");
const { Engine } = await load("engine/engine.js");
const { loadDefinition } = await load("format/load.js");
const { createRegistry } = await load("host/registry.js");
const { openSqliteStore } = await load("store/sqlite.js");

const die = () => process.kill(process.pid, "SIGKILL");

class CrashingAdapter extends FakeAdapter {
  async startTurn(p) {
    const accepted = await super.startTurn(p);
    // The harness has the turn now; keep what it accepted for the parent.
    writeFileSync(record, JSON.stringify({ ...p, runId: accepted.runId }));
    if (mode === "before-record") die();
    return accepted;
  }
}

const loaded = await loadDefinition(definition);
if (loaded.problems.length > 0) throw new Error(loaded.problems.join("\n"));
const engine = new Engine({
  store: openSqliteStore(file),
  adapter: new CrashingAdapter(),
  registry: createRegistry(),
  definitions: { current: (id) => (id === loaded.def.id ? loaded : undefined) },
  tokenSecret: Buffer.from(secret, "hex"),
});
if (mode === "after-record") {
  engine.on("stage_changed", (e) => {
    if (e.to === "working") die();
  });
}
await engine.startRun(loaded.def.id, { topic: "rust" });
await engine.tick();
// Never reached: the tick's dispatch ends the process.
process.exit(3);
