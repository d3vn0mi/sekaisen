import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type LoadedDefinition,
  loadDefinition,
} from "../../../src/format/load.js";
import { explore } from "../../../src/simulate/explore.js";

const LIMITS = { maxDepth: 40, maxPaths: 2000 };

async function fixture(name: string): Promise<LoadedDefinition> {
  const loaded = await loadDefinition(
    path.resolve(`test/fixtures/defs/${name}/pipeline.yaml`),
  );
  if (loaded.problems.length > 0) throw new Error(loaded.problems.join("\n"));
  return loaded;
}

describe("explore", () => {
  test("review-loop explores clean with 100% edge coverage", async () => {
    const r = await explore(await fixture("review-loop"), LIMITS);
    expect(r.problems).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.coverage.untaken).toEqual([]);
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "draft.blocked",
      "check.pass",
      "check.fail[0]",
      "check.fail[1]",
      "publish.approve",
      "publish.reject",
    ]);
    expect(r.paths).toBeGreaterThan(10);
  });

  test("a definition with an unbounded loop reports step_limit", async () => {
    const r = await explore(await fixture("unbounded"), LIMITS);
    expect(r.truncated).toBe(false);
    // All defaults: a answers ok, b answers bad, and a is back where it began.
    expect(r.problems).toContainEqual({
      problem: "step_limit",
      stage: "b",
      path: ["a:ok", "b:bad", "a:ok"],
    });
    expect(new Set(r.problems.map((p) => p.problem))).toEqual(
      new Set(["step_limit"]),
    );
    expect(r.coverage.untaken).toEqual([]);
  });

  test("a deploy reachable without the gate reports policy", async () => {
    const r = await explore(await fixture("deploy-ungated"), LIMITS);
    const policy = r.problems.filter((p) => p.problem === "policy");
    expect(policy.length).toBeGreaterThan(0);
    // Every such path skips the gate; the gated way in is never reported.
    for (const p of policy) expect(p.path[0]).toBe("check:ready");
    expect(policy).toContainEqual({
      problem: "policy",
      stage: "release",
      path: ["check:ready", "release:released"],
    });
    expect(r.problems.filter((p) => p.problem !== "policy")).toEqual([]);
    expect(r.coverage.untaken).toEqual([]);
  });

  test("a path that fails outside an end reports no_end", async () => {
    const loaded = await fixture("review-loop");
    const def = structuredClone(loaded.def);
    const check = def.stages.check;
    if (check?.type !== "agent") throw new Error("fixture changed");
    // findings is a string: comparing it with a number fails the guard.
    check.outcomes.fail = {
      ...check.outcomes.fail,
      next: [{ if: "check.findings > 1", to: "draft" }, { to: "failed" }],
    };
    const r = await explore({ ...loaded, def }, LIMITS);
    expect(r.problems).toContainEqual({
      problem: "no_end",
      stage: "check",
      path: ["draft:drafted", "check:fail"],
    });
    expect(new Set(r.problems.map((p) => p.problem))).toEqual(
      new Set(["no_end"]),
    );
  });

  test("a gate's timeout is no operator answer, and is labelled with ~", async () => {
    const loaded = await fixture("deploy-ungated");
    const def = structuredClone(loaded.def);
    const review = def.stages.review;
    if (review?.type !== "gate") throw new Error("fixture changed");
    review.onTimeout = { next: "release" };
    const r = await explore({ ...loaded, def }, LIMITS);
    expect(r.problems).toContainEqual({
      problem: "policy",
      stage: "release",
      path: ["check:unsure", "review:~timeout", "release:released"],
    });
    expect(r.problems).not.toContainEqual(
      expect.objectContaining({
        path: expect.arrayContaining(["review:approve"]),
      }),
    );
  });

  test("every ungated deploy on a path is reported, and pruning keeps a clean route apart from a dirty one", async () => {
    const r = await explore(await fixture("deploy-merge"), LIMITS);
    // Through rel, both deploys on the path are reported.
    const both = ["c:go", "rel:shipped", "m:bad", "rel2:shipped"];
    expect(r.problems).toContainEqual({
      problem: "policy",
      stage: "rel",
      path: both,
    });
    expect(r.problems).toContainEqual({
      problem: "policy",
      stage: "rel2",
      path: both,
    });
    // The route around rel reaches m in the same counters, but clean: it is
    // explored on its own and its deploy reported.
    expect(r.problems).toContainEqual({
      problem: "policy",
      stage: "rel2",
      path: ["c:alt", "x:ok", "m:bad", "rel2:shipped"],
    });
  });

  test("each path runs at most maxSteps ticks, 200 by default", async () => {
    const loaded = await fixture("review-loop");
    const r = await explore(loaded, { maxDepth: 0, maxPaths: 10, maxSteps: 1 });
    expect(r.problems).toEqual([
      expect.objectContaining({ problem: "step_limit" }),
    ]);
  });

  test("fields no minimal value satisfies are an error naming the stage and outcome", async () => {
    const loaded = await fixture("review-loop");
    const def = structuredClone(loaded.def);
    const check = def.stages.check;
    if (check?.type !== "agent") throw new Error("fixture changed");
    check.outcomes.fail = {
      ...check.outcomes.fail,
      fields: {
        type: "object",
        properties: { url: { type: "string", pattern: "^https://" } },
        required: ["url"],
      },
    };
    await expect(explore({ ...loaded, def }, LIMITS)).rejects.toThrow(
      "check:fail: field url: no minimal string matches pattern ^https://",
    );
  });

  test("maxPaths truncates the search", async () => {
    const r = await explore(await fixture("review-loop"), {
      maxDepth: 40,
      maxPaths: 3,
    });
    expect(r.paths).toBe(3);
    expect(r.truncated).toBe(true);
  });

  test("maxDepth 0 runs the all-defaults path only", async () => {
    const r = await explore(await fixture("review-loop"), {
      maxDepth: 0,
      maxPaths: 2000,
    });
    expect(r.paths).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "check.pass",
      "publish.approve",
    ]);
  });

  test("pruning repeated states changes neither coverage nor the problems found", async () => {
    for (const name of [
      "review-loop",
      "fix-loop",
      "deploy-ungated",
      "deploy-merge",
    ]) {
      const loaded = await fixture(name);
      const limits = { maxDepth: 3, maxPaths: 100_000 };
      const pruned = await explore(loaded, limits);
      const full = await explore(loaded, { ...limits, prune: false });
      expect(full.truncated).toBe(false);
      expect(pruned.paths).toBeLessThan(full.paths);
      expect(pruned.coverage).toEqual(full.coverage);
      const kinds = (r: typeof full) =>
        [
          ...new Set(r.problems.map((p) => `${p.problem} at ${p.stage}`)),
        ].sort();
      expect(kinds(pruned)).toEqual(kinds(full));
    }
  });
});
