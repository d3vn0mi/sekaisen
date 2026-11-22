import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanup, cli, type Fixture, makeStore } from "./store-fixture.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await makeStore();
});
afterAll(cleanup);

describe("sekaisen runs", () => {
  test("one line per run, most recently updated first", async () => {
    const r = await cli("runs", "--store", fx.file);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(2);
    const [first, second] = r.lines.map((l) => l.split(" "));
    expect(first?.slice(0, 4)).toEqual([
      fx.gated,
      "fix-loop",
      "input_required",
      "review",
    ]);
    expect(second?.slice(0, 4)).toEqual([
      fx.done,
      "fix-loop",
      "completed",
      "done",
    ]);
    expect(first?.[4]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(Date.parse(first?.[4] ?? "")).toBeGreaterThan(
      Date.parse(second?.[4] ?? ""),
    );
  });

  test("--status filters, repeated or comma separated", async () => {
    const one = await cli("runs", "--store", fx.file, "--status", "completed");
    expect(one.lines).toHaveLength(1);
    expect(one.out).toContain(fx.done);
    const both = await cli(
      "runs",
      "--store",
      fx.file,
      "--status",
      "completed",
      "--status",
      "input_required",
    );
    expect(both.lines).toHaveLength(2);
    const comma = await cli(
      "runs",
      "--store",
      fx.file,
      "--status",
      "completed,input_required",
    );
    expect(comma.lines).toHaveLength(2);
    const none = await cli("runs", "--store", fx.file, "--status", "failed");
    expect(none.code).toBe(0);
    expect(none.out).toBe("");
  });

  test("--limit bounds the list", async () => {
    const r = await cli("runs", "--store", fx.file, "--limit", "1");
    expect(r.lines).toEqual([expect.stringContaining(fx.gated)]);
  });

  test("--json prints an array of the same fields", async () => {
    const r = await cli("runs", "--store", fx.file, "--json");
    const rows = JSON.parse(r.out) as Array<Record<string, string>>;
    expect(rows.map((x) => x.run_id)).toEqual([fx.gated, fx.done]);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "run_id",
      "pipeline",
      "status",
      "current_stage",
      "updated_at",
    ]);
  });

  test("never writes: size and mtime are unchanged", async () => {
    const before = statSync(fx.file);
    await cli("runs", "--store", fx.file);
    const after = statSync(fx.file);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  test("a missing store is `<path>: error store …`, exit 1", async () => {
    const r = await cli("runs", "--store", "/nonexistent/x.sqlite");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^\/nonexistent\/x\.sqlite: error store .*does not exist/,
    );
  });

  test.each([
    [["runs"]],
    [["runs", "--store", "x", "--status", "bogus"]],
    [["runs", "--store", "x", "--limit", "0"]],
    [["runs", "--store", "x", "--limit", "abc"]],
    [["runs", "--store", "x", "extra"]],
    [["runs", "--nope"]],
  ])("usage error exits 2: %j", async (argv) => {
    const r = await cli(...argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: sekaisen runs");
  });

  test("--help exits 0", async () => {
    const r = await cli("runs", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: sekaisen runs");
  });
});
