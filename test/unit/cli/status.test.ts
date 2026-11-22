import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanup, cli, type Fixture, makeStore } from "./store-fixture.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await makeStore();
});
afterAll(cleanup);

describe("sekaisen status", () => {
  test("a run at a gate: header, live stage, gate, transitions", async () => {
    const r = await cli("status", fx.gated, "--store", fx.file);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`run: ${fx.gated}\n`);
    expect(r.out).toMatch(/pipeline: fix-loop \([0-9a-f]{12}\)\n/);
    expect(r.out).toContain("status: input_required\nstage: review\n");
    expect(r.out).toContain(
      "live: review input_required attempt 1 visit 1 retry 0\n",
    );
    expect(r.out).toContain("  wait_reason: ");
    expect(r.out).toMatch(/ {2}deadline: \d{4}-/);
    expect(r.out).toContain(
      "gate: Checks keep failing for go. Publish anyway?\n",
    );
    expect(r.out).toContain("  outcomes: approve, reject\n");
    expect(r.out).toContain("[fail] agent:checker");
    expect(r.out).toContain("transitions (last 20 of 21):");
    expect(r.out).not.toContain(" run_created ");
    const full = await cli("status", fx.done, "--store", fx.file);
    expect(full.out).toMatch(/\n {2}1 run: - → working run_created api\n/);
  });

  test("shows only the last 20 transitions, numbered from the log", async () => {
    const r = await cli("status", fx.gated, "--store", fx.file, "--json");
    const v = JSON.parse(r.out);
    expect(v.transitions).toHaveLength(20);
    expect(v.transitions[19].seq).toBeGreaterThan(20);
    expect(v.transitions[0].seq).toBe(v.transitions[19].seq - 19);
  });

  test("providers used per turn come from the stage runs", async () => {
    const r = await cli("status", fx.done, "--store", fx.file);
    expect(r.out).toContain(
      "providers (per stage run):\n  draft attempt 1: demo-provider demo-model\n",
    );
    const j = JSON.parse(
      (await cli("status", fx.done, "--store", fx.file, "--json")).out,
    );
    expect(j.providers).toEqual([
      {
        stage: "draft",
        attempt: 1,
        provider: "demo-provider",
        model: "demo-model",
      },
    ]);
  });

  test("--json is a stable object", async () => {
    const r = await cli("status", fx.gated, "--store", fx.file, "--json");
    const v = JSON.parse(r.out);
    expect(Object.keys(v)).toEqual([
      "run_id",
      "pipeline",
      "def_hash",
      "status",
      "current_stage",
      "created_at",
      "updated_at",
      "live",
      "gate",
      "providers",
      "transitions",
      "edges",
    ]);
    expect(v.live).toMatchObject({
      stage: "review",
      state: "input_required",
      attempt: 1,
      visit: 1,
      retry_index: 0,
    });
    expect(v.gate.outcomes).toEqual(["approve", "reject"]);
    expect(v.edges.taken).toContain("check.fail[1]");
    expect(v.edges.untaken).toContain("review.approve");
    const done = JSON.parse(
      (await cli("status", fx.done, "--store", fx.file, "--json")).out,
    );
    expect(done.live).toBeNull();
    expect(done.gate).toBeNull();
  });

  test("--mermaid marks the current stage and the edges taken, with no YAML on disk", async () => {
    const r = await cli("status", fx.gated, "--store", fx.file, "--mermaid");
    expect(r.code).toBe(0);
    expect(r.out.startsWith("stateDiagram-v2\n")).toBe(true);
    expect(r.out).toContain("class s_review current");
    expect(r.out).toContain("✓ drafted");
    expect(r.out).toMatch(/s_check --> s_review : ✓ fail/);
    expect(r.out).not.toContain("✓ approve");
  });

  test("never writes: size and mtime are unchanged", async () => {
    const before = statSync(fx.file);
    await cli("status", fx.gated, "--store", fx.file, "--mermaid");
    await cli("status", fx.done, "--store", fx.file, "--json");
    const after = statSync(fx.file);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  test("an unknown run id is `run <id> not found`, exit 1", async () => {
    const r = await cli("status", "nope", "--store", fx.file);
    expect(r.code).toBe(1);
    expect(r.err).toBe("run nope not found\n");
  });

  test("a missing store is `<path>: error store …`, exit 1", async () => {
    const r = await cli("status", "x", "--store", "/nonexistent/x.sqlite");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^\/nonexistent\/x\.sqlite: error store /);
  });

  test.each([
    [["status"]],
    [["status", "x"]],
    [["status", "x", "y", "--store", "s"]],
    [["status", "--nope"]],
  ])("usage error exits 2: %j", async (argv) => {
    const r = await cli(...argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: sekaisen status");
  });

  test("--help exits 0", async () => {
    const r = await cli("status", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: sekaisen status");
  });
});
