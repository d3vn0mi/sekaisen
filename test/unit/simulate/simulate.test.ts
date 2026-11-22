import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type LoadedDefinition,
  loadDefinition,
} from "../../../src/format/load.js";
import { parseScript, ScriptError } from "../../../src/simulate/script.js";
import {
  type SimulationResult,
  simulate,
} from "../../../src/simulate/simulate.js";

const FIX_LOOP = path.resolve("test/fixtures/defs/fix-loop/pipeline.yaml");
const HOUR = 3_600_000;

async function fixLoop(): Promise<LoadedDefinition> {
  const loaded = await loadDefinition(FIX_LOOP);
  if (loaded.problems.length > 0) throw new Error(loaded.problems.join("\n"));
  return loaded;
}

async function run(yaml: string): Promise<SimulationResult> {
  const loaded = await fixLoop();
  return simulate(loaded, parseScript(yaml, loaded.def));
}

const events = (r: SimulationResult) =>
  r.log.map((l) => `${l.run_stage}:${l.event}`);

const ALL_EDGES = [
  "draft.drafted",
  "draft.blocked",
  "check.pass",
  "check.fail[0]",
  "check.fail[1]",
  "review.approve",
  "review.reject",
  "review.on_timeout",
  "publish.next",
];

describe("simulate", () => {
  test("happy path ends completed with full coverage of the happy edges", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  draft: [ { outcome: drafted, fields: { summary: a first draft } } ]
  check: [ { outcome: pass } ]
`);
    expect(r.status).toBe("completed");
    expect(r.reachedEnd).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.elapsedMs).toBe(0);
    // biome-ignore format: one transition per line reads like the log
    expect(r.log).toEqual([
      { seq: 1, run_stage: "run", from: null, to: "working", event: "run_created", actor: "simulator" },
      { seq: 2, run_stage: "draft", from: null, to: "submitted", event: "stage_submitted", actor: "simulator" },
      { seq: 3, run_stage: "draft", from: "submitted", to: "working", event: "turn_started", actor: "engine" },
      { seq: 4, run_stage: "draft", from: "working", to: "completed", event: "stage_completed", outcome: "drafted", actor: "agent:drafter" },
      { seq: 5, run_stage: "check", from: null, to: "submitted", event: "stage_submitted", actor: "engine" },
      { seq: 6, run_stage: "draft", from: "completed", to: "completed", event: "turn_ended", actor: "engine" },
      { seq: 7, run_stage: "check", from: "submitted", to: "working", event: "turn_started", actor: "engine" },
      { seq: 8, run_stage: "check", from: "working", to: "completed", event: "stage_completed", outcome: "pass", actor: "agent:checker" },
      { seq: 9, run_stage: "publish", from: null, to: "submitted", event: "stage_submitted", actor: "engine" },
      { seq: 10, run_stage: "check", from: "completed", to: "completed", event: "turn_ended", actor: "engine" },
      { seq: 11, run_stage: "publish", from: "submitted", to: "completed", event: "stage_completed", actor: "action:demo.publish" },
      { seq: 12, run_stage: "run", from: "working", to: "completed", event: "run_ended", actor: "engine" },
    ]);
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "check.pass",
      "publish.next",
    ]);
    expect(r.coverage.untaken).toEqual(
      ALL_EDGES.filter((e) => !r.coverage.taken.includes(e)),
    );
  });

  test("each log line keeps the conformance key order", async () => {
    const r = await run("inputs: { topic: rust }");
    expect(JSON.stringify(r.log[3])).toBe(
      '{"seq":4,"run_stage":"draft","from":"working","to":"completed","event":"stage_completed","outcome":"drafted","actor":"agent:drafter"}',
    );
    expect(Object.keys(r.log[0] ?? {})).toEqual([
      "seq",
      "run_stage",
      "from",
      "to",
      "event",
      "actor",
    ]);
  });

  test("the same script gives the same log every time", async () => {
    const script = `
inputs: { topic: rust }
stages:
  draft: [ { ending: lost }, { outcome: drafted } ]
  check: [ { outcome: fail }, { outcome: fail }, { outcome: fail } ]
  review: [ { resolve: approve, after: 1h } ]
actions: { demo.publish: [ fail, ok ] }
`;
    const [a, b] = [await run(script), await run(script)];
    expect(a.log.length).toBeGreaterThan(30);
    expect(b).toEqual(a);
  });

  test("missing visits default to the stage's first outcome", async () => {
    const r = await run("inputs: { topic: rust }");
    expect(r.status).toBe("completed");
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "check.pass",
      "publish.next",
    ]);
  });

  test("fix loop stops at the count() bound and goes to the gate", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  check: [ { outcome: fail }, { outcome: fail }, { outcome: fail } ]
  review: [ { resolve: approve, after: 2h } ]
`);
    expect(r.status).toBe("completed");
    expect(r.reachedEnd).toBe(true);
    const checks = r.log.filter(
      (l) => l.run_stage === "check" && l.event === "stage_completed",
    );
    expect(checks.map((l) => l.outcome)).toEqual(["fail", "fail", "fail"]);
    expect(
      r.log.filter(
        (l) => l.run_stage === "draft" && l.event === "stage_completed",
      ),
    ).toHaveLength(3);
    expect(r.log).toContainEqual(
      expect.objectContaining({
        run_stage: "review",
        event: "gate_resolved",
        outcome: "approve",
        actor: "simulator",
      }),
    );
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "check.fail[0]",
      "check.fail[1]",
      "review.approve",
      "publish.next",
    ]);
    expect(r.elapsedMs).toBe(2 * HOUR);
  });

  test("gate timeout path on the virtual clock", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  check: [ { outcome: fail }, { outcome: fail }, { outcome: fail } ]
  review: [ { ending: timeout } ]
`);
    expect(r.status).toBe("failed");
    expect(r.reachedEnd).toBe(true);
    expect(events(r).slice(-2)).toEqual([
      "review:gate_timeout",
      "run:run_ended",
    ]);
    expect(r.coverage.taken).toContain("review.on_timeout");
    expect(r.elapsedMs).toBe(24 * HOUR);
  });

  test("a resolve scripted after the gate's timeout is overtaken by it", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  check: [ { outcome: fail }, { outcome: fail }, { outcome: fail } ]
  review: [ { resolve: approve, after: 25h } ]
`);
    expect(r.status).toBe("failed");
    expect(events(r)).not.toContain("review:gate_resolved");
    expect(r.elapsedMs).toBe(24 * HOUR);
  });

  test("lost mid-stage retries", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  draft: [ { ending: lost }, { outcome: drafted } ]
`);
    expect(r.status).toBe("completed");
    const lost = r.log.find((l) => l.event === "lost");
    expect(lost).toMatchObject({
      run_stage: "draft",
      from: "working",
      to: "failed",
      actor: "engine:reconcile",
    });
    const after = r.log.slice(r.log.indexOf(lost as never) + 1);
    expect(after[0]).toMatchObject({
      run_stage: "draft",
      event: "stage_submitted",
      to: "submitted",
    });
    expect(
      r.log.filter(
        (l) => l.run_stage === "draft" && l.event === "turn_started",
      ),
    ).toHaveLength(2);
  });

  test("usage_limited pauses and resumes after the reset on the virtual clock", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  draft: [ { ending: usage_limited, resets: 2h }, { outcome: drafted } ]
`);
    expect(r.status).toBe("completed");
    const i = r.log.findIndex((l) => l.event === "usage_limited");
    expect(r.log[i]).toMatchObject({
      run_stage: "draft",
      from: "working",
      to: "submitted",
    });
    expect(r.log[i + 1]).toMatchObject({
      run_stage: "draft",
      event: "turn_started",
    });
    expect(r.elapsedMs).toBe(2 * HOUR);
  });

  test("a usage limit with no reset pauses for the default hour", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  draft: [ { ending: usage_limited }, { outcome: drafted } ]
`);
    expect(r.status).toBe("completed");
    expect(r.elapsedMs).toBe(HOUR);
  });

  test("an agent timeout ends the attempt at its deadline and exhausts", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  check: [ { ending: timeout } ]
`);
    expect(r.status).toBe("failed");
    expect(r.reachedEnd).toBe(true);
    expect(events(r)).toContain("check:timeout");
    expect(r.elapsedMs).toBe(30 * 60_000);
  });

  test("an outcome scripted after the deadline is overtaken by the timeout", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  check: [ { outcome: pass, after: 1h } ]
`);
    expect(r.status).toBe("failed");
    expect(events(r)).toContain("check:timeout");
    expect(r.problems).toEqual([]);
  });

  test("no_result and turn_error end the attempt as the engine classifies them", async () => {
    const r = await run(`
inputs: { topic: rust }
stages:
  draft: [ { ending: no_result, after: 5m }, { ending: turn_error } ]
`);
    expect(r.status).toBe("failed");
    expect(events(r)).toEqual(
      expect.arrayContaining(["draft:no_result", "draft:turn_error"]),
    );
    expect(r.elapsedMs).toBe(5 * 60_000);
  });

  test("a failing action retries on turn_error", async () => {
    const r = await run(`
inputs: { topic: rust }
actions:
  demo.publish: [ fail, ok ]
`);
    expect(r.status).toBe("completed");
    expect(events(r)).toContain("publish:turn_error");
    expect(
      r.log.filter(
        (l) => l.run_stage === "publish" && l.event === "stage_completed",
      ),
    ).toHaveLength(1);
  });

  test("an exhausted action takes its declared on_exhausted edge", async () => {
    const loaded = await fixLoop();
    const def = structuredClone(loaded.def);
    const publish = def.stages.publish;
    if (publish?.type !== "action") throw new Error("fixture changed");
    publish.onExhausted = "failed";
    const r = await simulate(
      { ...loaded, def },
      parseScript(
        "inputs: { topic: rust }\nactions: { demo.publish: [ fail, fail ] }",
        def,
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.reachedEnd).toBe(true);
    expect(r.coverage.taken).toEqual([
      "draft.drafted",
      "check.pass",
      "publish.on_exhausted",
    ]);
    expect(r.coverage.untaken).toContain("publish.next");
  });

  test("checks, waits and poll gates answer from the script", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-sim-"));
    const file = path.join(dir, "pipeline.yaml");
    writeFileSync(
      file,
      `format: 1
id: hosted-flow
version: 1
start: c
stages:
  c:
    type: check
    check: demo.ready
    outcomes: { ready: w, waiting: failed }
  w: { type: wait, for: 10m, next: g }
  g:
    type: gate
    poll: { fact: demo.done, every: 5m }
    timeout: 1h
    on_timeout: { next: failed }
    outcomes: { passed: { next: done } }
  done: { type: end, status: completed }
  failed: { type: end, status: failed }
`,
    );
    const loaded = await loadDefinition(file);
    expect(loaded.problems).toEqual([]);
    const r = await simulate(
      loaded,
      parseScript(
        "checks: { demo.ready: [ ready ] }\nfacts: { demo.done: [ false, false, true ] }",
        loaded.def,
      ),
    );
    expect(r.status).toBe("completed");
    expect(r.coverage).toEqual({
      taken: ["c.ready", "w.next", "g.passed"],
      untaken: ["c.waiting", "g.on_timeout"],
    });
    expect(r.log.find((l) => l.event === "gate_passed")).toMatchObject({
      run_stage: "g",
      outcome: "passed",
      actor: "fact:demo.done",
    });
    // The wait, then two polls that fail five minutes apart.
    expect(r.elapsedMs).toBe(20 * 60_000);
  });

  test("a run that cannot move reports stalled", async () => {
    const loaded = await fixLoop();
    const def = structuredClone(loaded.def);
    delete (def.stages.check as { deadline?: number }).deadline;
    const r = await simulate(
      { ...loaded, def },
      parseScript(
        "inputs: { topic: rust }\nstages:\n  check: [ { ending: timeout } ]",
        def,
      ),
    );
    expect(r.status).toBe("working");
    expect(r.reachedEnd).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/^stalled/)]);
  });

  test("maxSteps bounds the ticks", async () => {
    const loaded = await fixLoop();
    const r = await simulate(
      loaded,
      parseScript("inputs: { topic: rust }", loaded.def),
      { maxSteps: 2 },
    );
    expect(r.reachedEnd).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/^max_steps/)]);
  });

  test("a completion the engine refuses is reported", async () => {
    const loaded = await fixLoop();
    const def = structuredClone(loaded.def);
    const draft = def.stages.draft;
    if (draft?.type !== "agent") throw new Error("fixture changed");
    // The default visit sends no fields; this outcome now requires one.
    (draft.outcomes.drafted as { fields?: unknown }).fields = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    const r = await simulate(
      { ...loaded, def },
      parseScript("inputs: { topic: rust }", def),
    );
    expect(r.problems[0]).toMatch(/^completion_refused: draft: /);
    expect(r.status).toBe("failed");
  });
});

describe("parseScript", () => {
  async function errors(yaml: string): Promise<string[]> {
    const { def } = await fixLoop();
    try {
      parseScript(yaml, def);
    } catch (err) {
      if (err instanceof ScriptError) return err.problems;
      throw err;
    }
    return [];
  }

  test("a valid script has no errors", async () => {
    expect(
      await errors(`
inputs: { topic: rust }
stages:
  draft: [ { outcome: drafted, fields: { summary: x }, after: 90s }, { ending: lost } ]
  review: [ { resolve: reject } ]
checks: {}
facts: {}
actions: { demo.publish: [ fail, ok ] }
`),
    ).toEqual([]);
  });

  test("unknown stages, outcomes and malformed visits are errors", async () => {
    expect(
      await errors(`
inputs: { topic: rust }
stages:
  nope: [ { outcome: x } ]
  draft:
    - { outcome: maybe }
    - { outcome: drafted, fields: { summary: 3 } }
    - { ending: exploded }
    - { outcome: drafted, ending: lost }
    - { outcome: drafted, after: soon }
    - { resolve: approve }
    - { ending: lost, resets: 1h }
    - { outcome: drafted, colour: red }
    - just a string
  review: [ { resolve: maybe }, { outcome: approve }, { ending: lost } ]
  publish: [ { outcome: next } ]
actions: { demo.publish: [ maybe ], demo.other: [ ok ] }
checks: { demo.ready: [ yes ] }
facts: { demo.done: [ true ] }
extra: 1
`),
    ).toEqual([
      "unknown key extra",
      "stages.nope: no stage named nope",
      'stages.draft[0]: unknown outcome "maybe"; declared: drafted, blocked',
      expect.stringMatching(
        /^stages\.draft\[1\]: fields for outcome drafted are invalid/,
      ),
      'stages.draft[2]: unknown ending "exploded"; one of no_result, lost, timeout, usage_limited, turn_error',
      "stages.draft[3]: a visit has exactly one of outcome, ending or resolve",
      'stages.draft[4]: after: invalid duration: "soon"',
      "stages.draft[5]: draft is an agent stage; use outcome or ending",
      "stages.draft[6]: resets goes only with ending: usage_limited",
      "stages.draft[7]: unknown key colour",
      "stages.draft[8]: a visit must be a mapping",
      'stages.review[0]: unknown outcome "maybe"; declared: approve, reject',
      "stages.review[1]: review is a gate; use resolve, or ending: timeout",
      "stages.review[2]: a gate's only ending is timeout",
      "stages.publish: publish is an action stage; script its action under actions",
      'actions.demo.publish[0]: "maybe" is neither ok nor fail',
      "actions.demo.other: no action stage runs demo.other",
      "checks.demo.ready: no check stage runs demo.ready",
      "facts.demo.done: no gate polls demo.done",
    ]);
  });

  test("inputs are validated against the definition", async () => {
    expect(await errors("stages: {}")).toEqual([
      expect.stringMatching(/^inputs: /),
    ]);
  });

  test("a script that is not YAML is an error", async () => {
    expect((await errors("stages: [")).at(0)).toMatch(/^yaml: /);
  });
});
