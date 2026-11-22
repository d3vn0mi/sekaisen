import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSqliteStore } from "../../../src/store/sqlite.js";
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

  test("text output strips control characters from agent-derived text; --json keeps it raw", async () => {
    const topic = "go\u001b[2J\nstatus: completed\u009b31m\u0007";
    const provider = "demo\u001b]0;title\u0007-provider";
    const own = await makeStore({ gatedTopic: topic, provider });
    const store = openSqliteStore(own.file);
    store.tx((t) => {
      t.appendTransition({
        runId: own.gated,
        stageRunId: null,
        fromState: "input_required",
        toState: "input_required",
        event: "note\u001b[1m",
        outcome: null,
        actor: "agent:intruder\u001b[31m\r\u0085",
        at: 1_700_000_100_000,
        detail: null,
      });
    });
    store.close();
    const hasControl = (text: string) =>
      [...text].some((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c !== 0x0a && (c < 0x20 || (c >= 0x7f && c <= 0x9f));
      });
    const gated = await cli("status", own.gated, "--store", own.file);
    expect(gated.code).toBe(0);
    expect(hasControl(gated.out)).toBe(false);
    expect(gated.out).toContain(
      "gate: Checks keep failing for go[2J status: completed31m. Publish anyway?\n",
    );
    expect(gated.lines.filter((l) => l.startsWith("status:"))).toEqual([
      "status: input_required",
    ]);
    expect(gated.out).toContain(" note[1m agent:intruder[31m ");
    const done = await cli("status", own.done, "--store", own.file);
    expect(hasControl(done.out)).toBe(false);
    expect(done.out).toContain(
      "  draft attempt 1: demo]0;title-provider demo-model\n",
    );
    const json = JSON.parse(
      (await cli("status", own.gated, "--store", own.file, "--json")).out,
    );
    expect(json.gate.prompt).toContain(topic);
    const raw = JSON.parse(
      (await cli("status", own.done, "--store", own.file, "--json")).out,
    );
    expect(raw.providers[0].provider).toBe(provider);
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
