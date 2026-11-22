import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadDefinition } from "../src/format/load.js";
import { parseScript } from "../src/simulate/script.js";
import { simulate } from "../src/simulate/simulate.js";

/**
 * The conformance suite: each case's pipeline, run against its script,
 * must write exactly the lines of its expected.jsonl.
 */

const CASES = path.resolve("conformance/cases");

const cases = readdirSync(CASES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const lines = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

describe("conformance", () => {
  test("the suite has every case", () => {
    expect(cases).toEqual([
      "cancel",
      "continuation",
      "fix-loop-cap",
      "gate-timeout",
      "happy",
      "lost-retry",
      "poll-gate",
      "usage-pause",
    ]);
  });

  test.each(cases)("%s", async (name) => {
    const dir = path.join(CASES, name);
    const loaded = await loadDefinition(path.join(dir, "pipeline.yaml"));
    expect(loaded.problems).toEqual([]);
    const script = parseScript(
      readFileSync(path.join(dir, "script.yaml"), "utf8"),
      loaded.def,
    );
    const result = await simulate(loaded, script);
    expect(result.problems).toEqual([]);

    const actual = [...result.log, { status: result.status }];
    const expected = lines(
      readFileSync(path.join(dir, "expected.jsonl"), "utf8"),
    );
    // Line by line, so a failure names the first line that differs.
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      const got = actual[i];
      const want = expected[i];
      expect(got, `line ${i + 1}`).toStrictEqual(want);
      expect(Object.keys(got ?? {}), `line ${i + 1} key order`).toEqual(
        Object.keys(want ?? {}),
      );
    }
  });
});
