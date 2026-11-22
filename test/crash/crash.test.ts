import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapter/fake.js";
import type { StartTurn } from "../../src/adapter/types.js";
import { Engine } from "../../src/engine/engine.js";
import { hashToken } from "../../src/engine/tokens.js";
import { createRegistry } from "../../src/host/registry.js";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { StageRunRow, Store } from "../../src/store/types.js";

const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const child = path.join(root, "test/crash/child.mjs");
const definition = path.join(
  root,
  "test/fixtures/defs/review-loop/pipeline.yaml",
);
const SECRET = Buffer.alloc(32, 7);

let scratch: string;
let built: string;

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: root });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.stderr.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "sekaisen-crash-"));
  built = path.join(scratch, "build");
  // The child runs plain JavaScript compiled here, so it needs no loader
  // for TypeScript and no prior build, on any supported Node.
  const compiled = await run(process.execPath, [
    tsc,
    "-p",
    "tsconfig.build.json",
    "--outDir",
    built,
    "--declaration",
    "false",
  ]);
  expect(compiled.out).toBe("");
  const schema = await run(process.execPath, [
    path.join(root, "scripts/copy-schema.mjs"),
    built,
  ]);
  expect(schema.out).toBe("");
  writeFileSync(path.join(built, "package.json"), '{"type":"module"}');
  // As in the package, the compiled sources read their version from the
  // package.json one folder up.
  copyFileSync(
    path.join(root, "package.json"),
    path.join(scratch, "package.json"),
  );
  // The compiled loader imports `yaml`; resolve it from the repository.
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(scratch, "node_modules"),
  );
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const stores: Store[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const s of stores.splice(0)) s.close();
});

type Accepted = StartTurn & { runId: string };

/** Runs the child in `mode` until it kills itself; returns what it left. */
async function crash(
  mode: "before-record" | "after-record",
): Promise<{ file: string; accepted: Accepted }> {
  const file = path.join(scratch, `${mode}.db`);
  const record = path.join(scratch, `${mode}.json`);
  const result = await run(process.execPath, [
    child,
    built,
    file,
    definition,
    record,
    mode,
    SECRET.toString("hex"),
  ]);
  const out = result.out.replace(
    /^.*(ExperimentalWarning|--trace-warnings).*\n?/gm,
    "",
  );
  expect(out).toBe("");
  expect(result.signal).toBe("SIGKILL");
  expect(existsSync(record)).toBe(true);
  return { file, accepted: JSON.parse(readFileSync(record, "utf8")) };
}

/** The engine of the restarted process, on the same store and secret. */
function reopen(
  file: string,
  adapter: FakeAdapter,
): { engine: Engine; store: Store } {
  const store = openSqliteStore(file);
  stores.push(store);
  const engine = new Engine({
    store,
    adapter,
    registry: createRegistry(),
    // The run goes on from the definition version pinned in the store.
    definitions: { current: () => undefined },
    tokenSecret: SECRET,
  });
  engines.push(engine);
  return { engine, store };
}

const stageRuns = (store: Store): StageRunRow[] =>
  store.tx((t) => t.listStageRuns({ limit: 100 }));

const tokenOf = (message: string): string => {
  const m = /Your completion token is: (\S+)/.exec(message);
  if (!m?.[1]) throw new Error("no token in message");
  return m[1];
};

describe("a process killed in the middle of a dispatch", () => {
  it("after the harness accepted the turn: the restart resends it under the same key", async () => {
    const { file, accepted } = await crash("before-record");
    // The harness outlived the engine and still holds the turn.
    const adapter = new FakeAdapter();
    adapter.adopt(accepted.idempotencyKey, accepted.runId);
    const { engine, store } = reopen(file, adapter);

    const [left] = stageRuns(store);
    if (!left) throw new Error("the child left no stage run");
    const runId = left.runId;
    expect(accepted.idempotencyKey).toBe(`${runId}:draft:1`);
    // The dispatch was recorded, the turn was not.
    expect(left).toMatchObject({
      state: "submitted",
      dispatchSeq: 1,
      adapterRunId: null,
    });
    expect(left.tokenHash).toBe(hashToken(tokenOf(accepted.message)));

    await engine.reconcile();
    await engine.tick();

    expect(adapter.calls).toHaveLength(1);
    const resent = adapter.calls[0];
    expect(resent?.idempotencyKey).toBe(`${runId}:draft:1`);
    // The token is derived from the attempt, so the brief is the same bytes.
    expect(resent?.message).toBe(accepted.message);
    const rows = stageRuns(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "working",
      dispatchSeq: 1,
      // The harness deduplicated the resend into the turn it already had.
      adapterRunId: accepted.runId,
    });
    expect(accepted.runId).toBe("fr_1");
    const log = store.tx((t) => t.transitions(runId));
    expect(log.map((x) => [x.event, x.actor])).toEqual([
      ["run_created", "api"],
      ["stage_submitted", "api"],
      ["turn_started", "engine"],
    ]);
  });

  it("after the engine recorded the turn: the restart loses it and retries", async () => {
    const { file, accepted } = await crash("after-record");
    // The harness restarted too: it knows nothing of the turn.
    const adapter = new FakeAdapter();
    const { engine, store } = reopen(file, adapter);
    const [before] = stageRuns(store);
    if (!before) throw new Error("the child left no stage run");
    const runId = before.runId;
    expect(before).toMatchObject({
      state: "working",
      adapterRunId: accepted.runId,
      idempotencyKey: `${runId}:draft:1`,
    });

    await engine.reconcile();

    const [lost, retry] = stageRuns(store);
    expect(lost).toMatchObject({ state: "failed", ending: "lost" });
    expect(lost?.tokenHash).toBe(hashToken(tokenOf(accepted.message)));
    expect(retry).toMatchObject({
      state: "submitted",
      attempt: 2,
      retryIndex: 1,
      idempotencyKey: `${runId}:draft:2`,
    });
    const log = store.tx((t) => t.transitions(runId));
    expect(log.slice(-2).map((x) => [x.event, x.actor])).toEqual([
      ["lost", "engine:reconcile"],
      ["stage_submitted", "engine:reconcile"],
    ]);

    await engine.tick();
    expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual([
      `${runId}:draft:2`,
    ]);
    expect(stageRuns(store)[1]).toMatchObject({ state: "working" });
  });
});
