import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../../src/cli/main.js";

const DIR = path.resolve("test/fixtures/defs/fix-loop");
const FILE = path.join(DIR, "pipeline.yaml");
const HAPPY = path.join(DIR, "scripts/happy.yaml");
const STUCK = path.join(DIR, "scripts/stuck.yaml");

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
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-sim-"));
  const file = path.join(dir, "script.yaml");
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

  test("a failed end still exits 0", async () => {
    const r = await cli("simulate", FILE, "--script", STUCK);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[review] gate_timeout: input_required -> failed");
    expect(r.out).toContain("status: failed\n");
  });

  test("a run that does not reach an end exits 1 and names the problem", async () => {
    // No deadline: a turn that never answers holds the run for ever.
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-sim-"));
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
  });

  test("simulate --help prints its usage and exits 0", async () => {
    const r = await cli("simulate", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("sekaisen simulate <file> --script <yaml>");
    expect((await cli("--help")).out).toContain("simulate <file> --script");
  });
});
