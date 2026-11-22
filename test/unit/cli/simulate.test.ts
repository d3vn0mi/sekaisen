import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { main } from "../../../src/cli/main.js";

const DIR = path.resolve("test/fixtures/defs/fix-loop");
const FILE = path.join(DIR, "pipeline.yaml");
const HAPPY = path.join(DIR, "scripts/happy.yaml");
const STUCK = path.join(DIR, "scripts/stuck.yaml");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-sim-"));
  dirs.push(dir);
  return dir;
}

async function cli(...argv: string[]) {
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

function scriptFile(text: string): string {
  const file = path.join(tempDir(), "script.yaml");
  writeFileSync(file, text);
  return file;
}

describe("sekaisen simulate", () => {
  test("prints the log, the status and the coverage; exit 0 at an end", async () => {
    const r = await cli("simulate", FILE, "--script", HAPPY);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("1 [run] run_created: - -> working by simulator");
    expect(r.lines).toContain(
      "4 [draft] stage_completed drafted: working -> completed by agent:drafter",
    );
    expect(r.lines.slice(-3)).toEqual([
      "status: completed",
      "edges: 3/9",
      "untaken: draft.blocked, check.fail[0], check.fail[1], review.approve, review.reject, review.on_timeout",
    ]);
  });

  test("an entry the run moved past is printed as a note", async () => {
    const r = await cli(
      "simulate",
      FILE,
      "--script",
      scriptFile(
        "inputs: { topic: rust }\nstages:\n  check: [ { outcome: pass, after: 1h } ]",
      ),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "note: overtaken: check: outcome pass was due after the stage run had moved on\n",
    );
  });

  test("a failed end still exits 0", async () => {
    const r = await cli("simulate", FILE, "--script", STUCK);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[review] gate_timeout: input_required -> failed");
    expect(r.out).toContain("status: failed\n");
  });

  test("a run that does not reach an end exits 1 and names the problem", async () => {
    // No deadline: a turn that never answers holds the run for ever.
    const dir = tempDir();
    const file = path.join(dir, "pipeline.yaml");
    writeFileSync(
      file,
      [
        "format: 1",
        "id: hang",
        "version: 1",
        "start: a",
        "stages:",
        "  a:",
        "    type: agent",
        "    agent: drafter",
        "    session: run",
        "    brief: a.md",
        "    outcomes: { done: { next: done } }",
        "  done: { type: end, status: completed }",
        "  failed: { type: end, status: failed }",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(dir, "a.md"), "Do it.\n");
    const script = scriptFile("stages:\n  a: [ { ending: timeout } ]\n");
    const r = await cli("simulate", file, "--script", script);
    expect(r.code).toBe(1);
    expect(r.out).toContain("status: working (did not reach an end)\n");
    expect(r.out).toMatch(/^problem: stalled: /m);
  });

  test("--json prints the whole result", async () => {
    const r = await cli("simulate", "--json", FILE, "--script", HAPPY);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    expect(result).toMatchObject({
      status: "completed",
      reachedEnd: true,
      coverage: { taken: ["draft.drafted", "check.pass", "publish.next"] },
      problems: [],
    });
    expect(result.log[0]).toEqual({
      seq: 1,
      run_stage: "run",
      from: null,
      to: "working",
      event: "run_created",
      actor: "simulator",
    });
  });

  test("a script that names unknown things is an error, exit 1", async () => {
    const script = scriptFile(
      "inputs: { topic: rust }\nstages:\n  nope: [ { outcome: x } ]\n  draft: [ { outcome: maybe } ]\n",
    );
    const r = await cli("simulate", FILE, "--script", script);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      `${script}: error script stages.nope: no stage named nope\n` +
        `${script}: error script stages.draft[0]: unknown outcome "maybe"; declared: drafted, blocked\n`,
    );
    expect(r.out).toBe("");
  });

  test("a missing file is a load error, exit 1", async () => {
    const r = await cli("simulate", "/nonexistent/p.yaml", "--script", HAPPY);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^\/nonexistent\/p\.yaml: error load /);
    const s = await cli("simulate", FILE, "--script", "/nonexistent/s.yaml");
    expect(s.code).toBe(1);
    expect(s.err).toMatch(/^\/nonexistent\/s\.yaml: error load /);
  });

  test("usage errors exit 2", async () => {
    expect((await cli("simulate")).code).toBe(2);
    expect((await cli("simulate", FILE)).code).toBe(2);
    expect((await cli("simulate", FILE, "extra", "--script", HAPPY)).code).toBe(
      2,
    );
    expect(
      (await cli("simulate", FILE, "--script", HAPPY, "--nope")).code,
    ).toBe(2);
    expect(
      (await cli("simulate", FILE, "--script", HAPPY, "--explore")).code,
    ).toBe(2);
    expect(
      (await cli("simulate", FILE, "--script", HAPPY, "--max-paths", "5")).code,
    ).toBe(2);
    for (const bad of [
      ["--max-depth", "-1"],
      ["--max-depth", "x"],
      ["--max-paths", "0"],
      ["--max-paths", "1.5"],
      ["--max-steps", "0"],
    ]) {
      expect((await cli("simulate", FILE, "--explore", ...bad)).code).toBe(2);
    }
  });

  test("--explore prints the paths, the problems and the merged coverage; exit 0 when clean", async () => {
    const r = await cli("simulate", FILE, "--explore");
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^explore: \d+ paths, 0 problems$/);
    expect(r.lines.slice(1)).toEqual(["edges: 9/9"]);
  });

  test("--explore exits 1 on a problem and prints its path", async () => {
    const r = await cli(
      "simulate",
      path.resolve("test/fixtures/defs/unbounded/pipeline.yaml"),
      "--explore",
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^explore: \d+ paths, [1-9]\d* problems$/);
    // Grouped by kind and stage, with the shortest path of each group.
    expect(r.lines).toContain(
      "problem: step_limit at b (4 paths): a:ok → b:bad → a:ok",
    );
    expect(r.lines.at(-1)).toBe("edges: 3/3");
  });

  test("--explore --max-steps bounds each path", async () => {
    const r = await cli("simulate", FILE, "--explore", "--max-steps", "1");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^problem: step_limit at /m);
  });

  test("--explore cut short by --max-paths warns and still exits 0", async () => {
    const r = await cli("simulate", FILE, "--explore", "--max-paths", "2");
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual([
      "explore: 2 paths, 0 problems",
      "explore: truncated at 2 paths",
    ]);
  });

  test("--explore --json prints the result as JSON", async () => {
    const r = await cli(
      "simulate",
      FILE,
      "--explore",
      "--max-depth",
      "0",
      "--json",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      paths: 1,
      truncated: false,
      problems: [],
      coverage: {
        taken: ["draft.drafted", "check.pass", "publish.next"],
        untaken: expect.any(Array),
      },
    });
  });

  test("simulate --help prints its usage and exits 0", async () => {
    const r = await cli("simulate", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "sekaisen simulate <file> (--script <yaml> | --explore [--max-depth N] [--max-paths N] [--max-steps N]) [--json]",
    );
    expect((await cli("--help")).out).toContain("simulate <file> --script");
  });
});
