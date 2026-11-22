import { describe, expect, test } from "vitest";
import { edgeId, edgesOf } from "../../../src/checks/edges.js";
import type { Finding } from "../../../src/checks/index.js";
import type { Stage } from "../../../src/format/types.js";
import { agent, end, loaded, run } from "./helpers.js";

const graph = (fs: Finding[]) => fs.filter((f) => f.check === "graph");

describe("graph", () => {
  test("an unreachable stage is an error", async () => {
    const l = loaded({
      a: agent({ ok: { next: "z" } }),
      z: end(),
      orphan: end(),
    });
    expect(graph(await run(l))).toEqual([
      {
        check: "graph",
        severity: "error",
        stage: "orphan",
        message: "stage orphan is not reachable from start",
      },
    ]);
  });

  test("the onCancel target counts as reachable", async () => {
    const l = loaded(
      { a: agent({ ok: { next: "z" } }), z: end(), c: end("failed") },
      { onCancel: "c" },
    );
    expect(graph(await run(l))).toEqual([]);
  });

  test("an agent with no outcomes has no exit", async () => {
    const l = loaded({ a: agent({}), z: end() });
    const fs = graph(await run(l));
    expect(fs).toContainEqual({
      check: "graph",
      severity: "error",
      stage: "a",
      message: "stage a has no exit",
    });
  });

  test("a loop with no way to an end is an error", async () => {
    const l = loaded({
      s: agent({ ok: { next: "a" }, done: { next: "z" } }, "briefs/a.md"),
      a: agent({ ok: { next: "b" } }),
      b: agent({ ok: { next: "a" } }),
      z: end(),
    });
    const fs = graph(await run(l)).filter(
      (f) => f.stage === "a" || f.stage === "b",
    );
    expect(fs).toEqual([
      {
        check: "graph",
        severity: "error",
        stage: "a",
        message: "no end is reachable from stage a",
      },
      {
        check: "graph",
        severity: "error",
        stage: "b",
        message: "no end is reachable from stage b",
      },
    ]);
  });

  test("an outcome without a next is an error", async () => {
    const l = loaded({
      a: agent({ ok: { next: "" }, bad: { next: [] } }),
      z: end(),
    });
    const fs = graph(await run(l));
    expect(fs).toContainEqual({
      check: "graph",
      severity: "error",
      stage: "a",
      message: "stage a outcome ok has no next",
    });
    expect(fs).toContainEqual({
      check: "graph",
      severity: "error",
      stage: "a",
      message: "stage a outcome bad has no next",
    });
  });

  test("a branch list must end with an unconditional branch", async () => {
    const l = loaded({
      a: agent({
        ok: {
          next: [
            { if: "attempts(a) < 2", to: "a" },
            { if: "attempts(a) < 5", to: "z" },
          ],
        },
      }),
      z: end(),
    });
    expect(graph(await run(l))).toEqual([
      {
        check: "graph",
        severity: "error",
        stage: "a",
        message: "stage a outcome ok: the last branch must be unconditional",
      },
    ]);
  });
});

describe("edges", () => {
  test("edgesOf covers every kind of transition with stable ids", () => {
    const gate: Stage = {
      type: "gate",
      timeout: 1,
      onTimeout: { next: "z" },
      outcomes: {
        go: { next: [{ if: "attempts(g) < 2", to: "g" }, { to: "z" }] },
      },
    };
    const ag = agent({ ok: { next: "g" } });
    (ag as { onExhausted?: string }).onExhausted = "z";
    const l = loaded(
      {
        a: ag,
        g: gate,
        c: { type: "check", check: "k", outcomes: { yes: "z" } },
        x: {
          type: "action",
          action: "n",
          next: "z",
          retry: { max: 0, on: [] },
        },
        w: { type: "wait", for: 1, next: "z" },
        z: end(),
      },
      { onCancel: "z" },
    );
    const edges = edgesOf(l.def);
    expect(edges.map(edgeId)).toEqual([
      "a.ok",
      "a.on_exhausted",
      "g.go[0]",
      "g.go[1]",
      "g.on_timeout",
      "c.yes",
      "x.next",
      "w.next",
      "*.on_cancel",
    ]);
    expect(edges[2]).toMatchObject({
      from: "g",
      outcome: "go",
      branch: 0,
      to: "g",
      guard: "attempts(g) < 2",
    });
  });
});
