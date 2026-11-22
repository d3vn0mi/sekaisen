import { describe, expect, test } from "vitest";
import type { Finding } from "../../../src/checks/index.js";
import type { AgentStage, Stage } from "../../../src/format/types.js";
import { agent, end, loaded, run } from "./helpers.js";

const term = (fs: Finding[]) => fs.filter((f) => f.check === "termination");
const gate = (next: string): Stage =>
  ({
    type: "gate",
    who: "operator",
    timeout: 1000,
    onTimeout: { remind: 1000 },
    outcomes: { retry: { next }, stop: { next: "z" } },
  }) as Stage;

describe("termination", () => {
  test("unbounded fix loop is an error", async () => {
    const l = loaded({
      a: agent({ ok: { next: "b" } }),
      b: agent({ bad: { next: "a" }, good: { next: "z" } }),
      z: end(),
    });
    expect(term(await run(l))).toEqual([
      {
        check: "termination",
        severity: "error",
        stage: "a",
        message: "cycle a → b → a is unbounded",
      },
    ]);
  });

  test("bounded by count() passes", async () => {
    const l = loaded({
      a: agent({ ok: { next: "b" } }),
      b: agent({
        bad: { next: [{ if: "count(b.bad) < 3", to: "a" }, { to: "z" }] },
      }),
      z: end(),
    });
    expect(term(await run(l))).toEqual([]);
  });

  test("bounded by attempts() on the cycle passes", async () => {
    const l = loaded({
      a: agent({
        again: { next: [{ if: "attempts(a) < 3", to: "a" }, { to: "z" }] },
      }),
      z: end(),
    });
    expect(term(await run(l))).toEqual([]);
  });

  test("a bound on a stage off the cycle does not count", async () => {
    const l = loaded({
      a: agent({ ok: { next: "b" } }),
      b: agent({
        bad: { next: [{ if: "attempts(z2) < 3", to: "a" }, { to: "z" }] },
      }),
      z2: agent({ ok: { next: "z" } }),
      z: end(),
    });
    expect(term(await run(l)).map((f) => f.message)).toEqual([
      "cycle a → b → a is unbounded",
    ]);
  });

  test("a bound that a second cycle avoids does not count", async () => {
    const l = loaded({
      a: agent({ ok: { next: "b" } }),
      b: agent({
        bad: { next: [{ if: "count(b.bad) < 3", to: "a" }, { to: "c" }] },
      }),
      c: agent({ again: { next: "a" }, done: { next: "z" } }),
      z: end(),
    });
    expect(term(await run(l)).map((f) => f.message)).toEqual([
      "cycle a → b → c → a is unbounded",
    ]);
  });

  test("cycle through a gate passes", async () => {
    const l = loaded({
      a: agent({ ok: { next: "g" } }),
      g: gate("a"),
      z: end(),
    });
    expect(term(await run(l))).toEqual([]);
  });

  test("a branch that can never be taken breaks the cycle", async () => {
    const l = loaded({
      a: agent({
        again: { next: [{ if: "count(a.again) < 0", to: "a" }, { to: "z" }] },
      }),
      z: end(),
    });
    expect(term(await run(l))).toEqual([]);
  });

  test("a self-loop is reported once", async () => {
    const l = loaded({
      a: agent({ again: { next: "a" }, done: { next: "z" } }),
      z: end(),
    });
    expect(term(await run(l)).map((f) => f.message)).toEqual([
      "cycle a → a is unbounded",
    ]);
  });

  test("a bound on on_exhausted is not a bound", async () => {
    const a = agent({ ok: { next: "z" } }) as AgentStage;
    a.onExhausted = "b";
    const l = loaded({
      a,
      b: agent({
        ok: {
          next: [{ if: "count(a.on_exhausted) < 3", to: "a" }, { to: "z" }],
        },
      }),
      z: end(),
    });
    expect(term(await run(l)).map((f) => f.message)).toEqual([
      "cycle a → b → a is unbounded",
    ]);
  });

  test("a bound on a wait's next label is not a bound", async () => {
    const l = loaded({
      w: { type: "wait", for: 1000, next: "a" } as Stage,
      a: agent({
        ok: { next: [{ if: "count(w.next) < 3", to: "w" }, { to: "z" }] },
      }),
      z: end(),
    });
    expect(term(await run(l))).toHaveLength(1);
  });

  test("a bounded loop is not undone by a loop through a gate", async () => {
    const l = loaded({
      a: agent({ ok: { next: "b" }, alt: { next: "g" } }),
      g: gate("b"),
      b: agent({
        again: { next: [{ if: "count(a.ok) < 3", to: "a" }, { to: "z" }] },
      }),
      z: end(),
    });
    expect(term(await run(l))).toEqual([]);
  });

  test("a loop through a gate's on_timeout is unbounded", async () => {
    const g: Stage = {
      type: "gate",
      who: "operator",
      timeout: 1000,
      onTimeout: { next: "a" },
      outcomes: { stop: { next: "z" } },
    } as Stage;
    const l = loaded({ a: agent({ ok: { next: "g" } }), g, z: end() });
    expect(term(await run(l)).map((f) => f.message)).toEqual([
      "cycle a → g → a is unbounded",
    ]);
  });

  test("a loop through a poll gate is unbounded", async () => {
    const g: Stage = {
      type: "gate",
      poll: { fact: "demo.ready", every: 1000 },
      timeout: 1000,
      onTimeout: { remind: 1000 },
      outcomes: { retry: { next: "a" }, stop: { next: "z" } },
    } as Stage;
    const l = loaded({ a: agent({ ok: { next: "g" } }), g, z: end() });
    expect(term(await run(l))).toHaveLength(1);
  });
});
