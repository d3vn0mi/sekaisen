import { describe, expect, test } from "vitest";
import type { Finding } from "../../../src/checks/index.js";
import { runChecks } from "../../../src/checks/index.js";
import type { AgentStage, Stage } from "../../../src/format/types.js";
import { createRegistry } from "../../../src/host/registry.js";
import { agent, end, loaded } from "./helpers.js";

const caps = { turnCapMs: 600_000, maxConcurrent: 2, canAbort: true };
const timing = (fs: Finding[]) => fs.filter((f) => f.check === "timing");
const withTurns = (turns: AgentStage["turns"], deadline?: number): Stage => {
  const s = agent({ ok: { next: "z" } }) as AgentStage;
  s.turns = turns;
  if (deadline !== undefined) s.deadline = deadline;
  return s;
};
const check = (l: ReturnType<typeof loaded>, withCaps = true) =>
  runChecks(l, {
    registry: createRegistry(),
    ...(withCaps ? { capabilities: caps } : {}),
  });

describe("timing", () => {
  test("turn cap above harness cap is an error", async () => {
    const l = loaded({ a: withTurns({ max: 1, capMs: 900_000 }), z: end() });
    expect(timing(await check(l))).toEqual([
      {
        check: "timing",
        severity: "error",
        stage: "a",
        message: "stage a turn cap 900s is above the harness cap 600s",
      },
    ]);
  });

  test("without capabilities the cap comparison is skipped", async () => {
    const l = loaded({ a: withTurns({ max: 1, capMs: 900_000 }), z: end() });
    expect(timing(await check(l, false))).toEqual([]);
  });

  test("deadline below turns.max minutes is an error, with or without capabilities", async () => {
    const l = loaded({ a: withTurns({ max: 3 }, 120_000), z: end() });
    for (const c of [true, false]) {
      expect(timing(await check(l, c)).map((f) => f.message)).toEqual([
        "stage a deadline 120s is below 3 turn(s) of 60s",
      ]);
    }
  });

  test("the default deadline counts", async () => {
    const l = loaded({ a: withTurns({ max: 3 }), z: end() });
    l.def.defaults = { deadline: 60_000 };
    expect(timing(await check(l))).toHaveLength(1);
  });

  test("a gate reminder under a minute or past its timeout is an error", async () => {
    const gate = (remind: number): Stage =>
      ({
        type: "gate",
        timeout: 120_000,
        onTimeout: { remind },
        outcomes: { yes: { next: "z" } },
      }) as Stage;
    const low = loaded({ g: gate(30_000), z: end() });
    const high = loaded({ g: gate(180_000), z: end() });
    const ok = loaded({ g: gate(120_000), z: end() });
    expect(timing(await check(low))).toHaveLength(1);
    expect(timing(await check(high))).toHaveLength(1);
    expect(timing(await check(ok))).toEqual([]);
  });
});
