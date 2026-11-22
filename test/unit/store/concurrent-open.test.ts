import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../../src/store/migrations.js";
import { retryWhileBusy } from "../../../src/store/sqlite.js";

const root = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");

let scratch: string;
let built: string;

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "sekaisen-open-"));
  built = path.join(scratch, "build");
  // Compile the store into a scratch directory so the child processes run
  // plain JavaScript on any supported Node, without relying on a prior build.
  const result = await run(process.execPath, [
    tsc,
    "-p",
    "tsconfig.build.json",
    "--outDir",
    built,
    "--declaration",
    "false",
  ]);
  expect(result.out).toBe("");
  writeFileSync(path.join(built, "package.json"), '{"type":"module"}');
  // As in the package, the compiled sources read their version from the
  // package.json one folder up.
  copyFileSync(
    path.join(root, "package.json"),
    path.join(scratch, "package.json"),
  );
  writeFileSync(
    path.join(built, "open.mjs"),
    `import { openSqliteStore } from "./store/sqlite.js";
const [file, start] = process.argv.slice(2);
while (Date.now() < Number(start)) {}
const store = openSqliteStore(file);
store.close();
`,
  );
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("opening one new store file from several processes", () => {
  it("all six succeed and the schema is applied once", async () => {
    const file = path.join(scratch, "shared.db");
    const start = String(Date.now() + 500);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, [path.join(built, "open.mjs"), file, start]),
      ),
    );
    for (const r of results) {
      expect(r.out.replace(/^.*ExperimentalWarning.*\n?/gm, "")).not.toMatch(
        /locked|Error/,
      );
      expect(r.code).toBe(0);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    db.close();
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });
});

describe("retryWhileBusy", () => {
  const fake = (step: number) => {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      clock: {
        now: () => t,
        sleep: (ms: number) => {
          slept.push(ms);
          t += step;
        },
      },
    };
  };
  const locked = () => new Error("database is locked");

  it("retries a locked database with growing backoff, then succeeds", () => {
    const { clock, slept } = fake(1);
    let calls = 0;
    retryWhileBusy(
      () => {
        if (++calls < 4) throw locked();
      },
      5000,
      clock,
    );
    expect(calls).toBe(4);
    expect(slept).toEqual([5, 10, 20]);
  });

  it("gives up once the budget has elapsed", () => {
    const { clock } = fake(2000);
    let calls = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          calls++;
          throw locked();
        },
        5000,
        clock,
      ),
    ).toThrow(/locked/);
    expect(calls).toBe(4);
  });

  it("does not retry other errors", () => {
    const { clock } = fake(1);
    let calls = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          calls++;
          throw new Error("disk I/O error");
        },
        5000,
        clock,
      ),
    ).toThrow(/disk/);
    expect(calls).toBe(1);
  });
});
