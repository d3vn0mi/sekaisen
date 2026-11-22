import { describe, expect, test } from "vitest";
import { guardBounds } from "../../../src/guard/bounds.js";
import {
  evalGuard,
  type GuardContext,
  GuardEvalError,
} from "../../../src/guard/eval.js";
import {
  GuardSyntaxError,
  guardReferences,
  MAX_GUARD_DEPTH,
  MAX_GUARD_LENGTH,
  parseGuard,
} from "../../../src/guard/parse.js";

function ctx(o: {
  counts?: Record<string, number>;
  attempts?: Record<string, number>;
  fields?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}): GuardContext {
  return {
    count: (s, oc) => o.counts?.[`${s}.${oc}`] ?? 0,
    attempts: (s) => o.attempts?.[s] ?? 0,
    field: (s, n) => o.fields?.[`${s}.${n}`],
    input: (p) => o.inputs?.[p],
  };
}
const run = (src: string, c: GuardContext = ctx({})) =>
  evalGuard(parseGuard(src), c);

describe("evalGuard", () => {
  test("count bound", () => {
    expect(
      run("count(check.fail) < 3", ctx({ counts: { "check.fail": 2 } })),
    ).toBe(true);
    expect(
      run("count(check.fail) < 3", ctx({ counts: { "check.fail": 3 } })),
    ).toBe(false);
  });
  test("attempts and inputs", () => {
    const src = 'attempts(draft) <= 2 and inputs.mode == "fast"';
    expect(
      run(src, ctx({ attempts: { draft: 2 }, inputs: { mode: "fast" } })),
    ).toBe(true);
    expect(
      run(src, ctx({ attempts: { draft: 3 }, inputs: { mode: "fast" } })),
    ).toBe(false);
    expect(
      run(src, ctx({ attempts: { draft: 1 }, inputs: { mode: "slow" } })),
    ).toBe(false);
  });
  test("dotted paths", () => {
    expect(
      run('inputs.repo.owner == "x"', ctx({ inputs: { "repo.owner": "x" } })),
    ).toBe(true);
    expect(run("a.b.c == 1", ctx({ fields: { "a.b.c": 1 } }))).toBe(true);
  });
  test("not", () => {
    expect(run("not (a.x == 1)", ctx({ fields: { "a.x": 2 } }))).toBe(true);
    expect(run("not (a.x == 1)", ctx({ fields: { "a.x": 1 } }))).toBe(false);
  });
  test("precedence: a or b and c", () => {
    expect(run("true or false and false")).toBe(true);
    expect(run("(true or false) and false")).toBe(false);
    expect(run("not false and false")).toBe(false);
  });
  test("== and != are strict", () => {
    expect(run('a.x == "1"', ctx({ fields: { "a.x": 1 } }))).toBe(false);
    expect(run('a.x != "1"', ctx({ fields: { "a.x": 1 } }))).toBe(true);
    expect(run("true == true")).toBe(true);
  });
  test("missing value is undefined: == works, ordering throws", () => {
    expect(run("a.x == 1")).toBe(false);
    expect(run("a.x != 1")).toBe(true);
    expect(() => run("a.x < 1")).toThrow(GuardEvalError);
    expect(() => run("a.x < 1")).toThrow(/a\.x < 1/);
  });
  test("strings are not ordered", () => {
    expect(() => run('"a" < "b"')).toThrow(GuardEvalError);
  });
  test("non-boolean result throws", () => {
    expect(() => run("1")).toThrow(GuardEvalError);
    expect(() => run("a.x", ctx({ fields: { "a.x": "s" } }))).toThrow(/a\.x/);
    expect(() => run("a.x and true", ctx({ fields: { "a.x": 1 } }))).toThrow(
      GuardEvalError,
    );
  });
  test("boolean field is a valid guard", () => {
    expect(run("a.ok", ctx({ fields: { "a.ok": true } }))).toBe(true);
  });
  test("and/or short-circuit", () => {
    expect(run("false and a.x", ctx({ fields: { "a.x": 1 } }))).toBe(false);
    expect(run("true or a.x", ctx({ fields: { "a.x": 1 } }))).toBe(true);
  });
  test("string escapes", () => {
    expect(run('a.x == "q\\"q\\\\"', ctx({ fields: { "a.x": 'q"q\\' } }))).toBe(
      true,
    );
  });
});

describe("parseGuard errors", () => {
  test("reports the column", () => {
    try {
      parseGuard("count(check.fail) < ");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GuardSyntaxError);
      expect((e as GuardSyntaxError).column).toBe(21);
    }
    expect(() => parseGuard("a.x == 1 )")).toThrow(/column 10/);
    expect(() => parseGuard("a.x & 1")).toThrow(/column 5/);
    expect(() => parseGuard('a.x == "abc')).toThrow(/unterminated/);
  });
  test("bare names and reserved words are rejected", () => {
    expect(() => parseGuard("draft == 1")).toThrow(GuardSyntaxError);
    expect(() => parseGuard("inputs == 1")).toThrow(GuardSyntaxError);
    expect(() => parseGuard("and.x == 1")).toThrow(GuardSyntaxError);
    expect(() => parseGuard("")).toThrow(GuardSyntaxError);
  });
  test("length cap", () => {
    const ok = `${"a.x == 1 and ".repeat(70)}true`.slice(0, MAX_GUARD_LENGTH);
    expect(() =>
      parseGuard(`${ok} `.padEnd(MAX_GUARD_LENGTH + 1, " ")),
    ).toThrow(/longer than/);
  });
  test("depth cap", () => {
    const nest = (n: number) => `${"(".repeat(n)}true${")".repeat(n)}`;
    expect(() => parseGuard(nest(MAX_GUARD_DEPTH))).not.toThrow();
    expect(() => parseGuard(nest(MAX_GUARD_DEPTH + 1))).toThrow(
      /nested deeper/,
    );
    expect(() =>
      parseGuard(`${"not ".repeat(MAX_GUARD_DEPTH + 1)}true`),
    ).toThrow(/nested deeper/);
  });
  test("long flat chains are fine", () => {
    const src = Array(100).fill("true").join(" and ");
    expect(run(src)).toBe(true);
  });
});

describe("guardBounds", () => {
  const b = (s: string) => guardBounds(parseGuard(s));
  test("count < N and <= N", () => {
    expect(b("count(check.fail) < 3")).toEqual([
      { stage: "check", outcome: "fail", max: 2 },
    ]);
    expect(b("count(check.fail) <= 3")).toEqual([
      { stage: "check", outcome: "fail", max: 3 },
    ]);
  });
  test("attempts has no outcome", () => {
    expect(b("attempts(draft) < 4")).toEqual([{ stage: "draft", max: 3 }]);
  });
  test("mirrored forms", () => {
    expect(b("3 > count(check.fail)")).toEqual([
      { stage: "check", outcome: "fail", max: 2 },
    ]);
    expect(b("3 >= count(check.fail)")).toEqual([
      { stage: "check", outcome: "fail", max: 3 },
    ]);
  });
  test("conjunction collects every bound, including nested and", () => {
    expect(
      b('count(a.x) < 2 and (inputs.m == "f" and attempts(d) <= 5)'),
    ).toEqual([
      { stage: "a", outcome: "x", max: 1 },
      { stage: "d", max: 5 },
    ]);
  });
  test("or / not make a term not a bound", () => {
    expect(b("count(a.x) < 3 or a.ok")).toEqual([]);
    expect(b("not (count(a.x) < 3)")).toEqual([]);
    expect(b("count(a.x) < 3 and (a.ok or attempts(d) < 2)")).toEqual([
      { stage: "a", outcome: "x", max: 2 },
    ]);
  });
  test("lower bounds and non-literal limits are not bounds", () => {
    expect(b("count(a.x) > 3")).toEqual([]);
    expect(b("count(a.x) < inputs.n")).toEqual([]);
    expect(b("count(a.x) == 3")).toEqual([]);
  });
});

describe("guardReferences", () => {
  test("lists stages and input paths once", () => {
    const ast = parseGuard(
      'count(check.fail) < 3 and a.ok and inputs.repo.owner == "x" and attempts(check) < 2 and inputs.repo.owner != "y"',
    );
    expect(guardReferences(ast)).toEqual({
      stages: ["check", "a"],
      inputs: ["repo.owner"],
    });
  });
});
