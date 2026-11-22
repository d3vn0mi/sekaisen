import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Finding } from "../../../src/checks/index.js";
import { loadDefinition } from "../../../src/format/load.js";
import type { Stage } from "../../../src/format/types.js";
import { createRegistry } from "../../../src/host/registry.js";
import { agent, end, FIXTURE, loaded, run } from "./helpers.js";

const only = (fs: Finding[], check: string) =>
  fs.filter((f) => f.check === check);

describe("references", () => {
  test("clean review-loop has no findings", async () => {
    const l = await loadDefinition(path.join(FIXTURE, "pipeline.yaml"));
    expect((await run(l)).filter((f) => f.severity !== "info")).toEqual([]);
  });

  test("schema problems become schema errors", async () => {
    const l = loaded({ a: end() }, { problems: ["/id: must be string"] });
    expect(await run(l)).toContainEqual({
      check: "schema",
      severity: "error",
      message: "/id: must be string",
    });
  });

  test("a broken file with no stages reports only schema problems", async () => {
    const l = loaded({}, { problems: ["yaml: bad"], start: "" });
    const fs = await run(l);
    expect(fs.map((f) => f.check)).toEqual(["schema"]);
  });

  test("a next target that does not exist is an error", async () => {
    const l = loaded({ a: agent({ ok: { next: "ghost" } }), z: end() });
    expect(only(await run(l), "references")).toContainEqual({
      check: "references",
      severity: "error",
      stage: "a",
      message: "stage a outcome ok: next target ghost does not exist",
    });
  });

  test("a branch target that does not exist is an error", async () => {
    const l = loaded({
      a: agent({
        ok: { next: [{ if: "attempts(a) < 2", to: "ghost" }, { to: "z" }] },
      }),
      z: end(),
    });
    const fs = only(await run(l), "references");
    expect(fs).toContainEqual({
      check: "references",
      severity: "error",
      stage: "a",
      message: "stage a outcome ok branch 0: next target ghost does not exist",
    });
  });

  test("onCancel, onTimeout.next, onExhausted and start must exist", async () => {
    const gate: Stage = {
      type: "gate",
      timeout: 1000,
      onTimeout: { next: "g1" },
      outcomes: { go: { next: "z" } },
    };
    const ag = agent({ ok: { next: "z" } });
    (ag as { onExhausted?: string }).onExhausted = "g2";
    const l = loaded(
      { g: gate, a: ag, z: end() },
      { onCancel: "g3", start: "g4" },
    );
    const msgs = only(await run(l), "references").map((f) => f.message);
    expect(msgs).toContain("stage g onTimeout: next target g1 does not exist");
    expect(msgs).toContain(
      "stage a onExhausted: next target g2 does not exist",
    );
    expect(msgs).toContain("onCancel: target g3 does not exist");
    expect(msgs).toContain("start: stage g4 does not exist");
  });

  test("an unregistered check, action and fact are errors", async () => {
    const l = loaded({
      c: { type: "check", check: "demo.ready", outcomes: { yes: "x" } },
      x: {
        type: "action",
        action: "demo.notify",
        next: "g",
        retry: { max: 0, on: [] },
      },
      g: {
        type: "gate",
        poll: { fact: "demo.fact", every: 1000 },
        timeout: 1000,
        onTimeout: { remind: 1000 },
        outcomes: { go: { next: "z" } },
      },
      z: end(),
    });
    const fs = only(await run(l), "references");
    expect(fs).toContainEqual({
      check: "references",
      severity: "error",
      stage: "c",
      message: "check demo.ready is not registered by the host",
    });
    expect(fs).toContainEqual({
      check: "references",
      severity: "error",
      stage: "x",
      message: "action demo.notify is not registered by the host",
    });
    expect(fs).toContainEqual({
      check: "references",
      severity: "error",
      stage: "g",
      message: "fact demo.fact is not registered by the host",
    });
  });

  test("registered names are accepted", async () => {
    const registry = createRegistry();
    registry.checks.set("demo.ready", async () => "yes");
    const l = loaded({
      c: { type: "check", check: "demo.ready", outcomes: { yes: "z" } },
      z: end(),
    });
    expect(only(await run(l, registry), "references")).toEqual([]);
  });

  test("a missing brief is an error", async () => {
    const l = loaded({
      a: agent({ ok: { next: "z" } }, "briefs/none.md"),
      z: end(),
    });
    expect(only(await run(l), "references")).toContainEqual({
      check: "references",
      severity: "error",
      stage: "a",
      message: "brief briefs/none.md does not exist",
    });
  });

  test("a placeholder naming neither inputs nor a stage is an error", async () => {
    const l = loaded(
      { a: agent({ ok: { next: "z" } }), z: end() },
      { briefs: { "briefs/a.md": "hello {{nope.x}} and {{inputs.topic}}" } },
    );
    const fs = only(await run(l), "references");
    expect(fs).toContainEqual({
      check: "references",
      severity: "error",
      stage: "a",
      message:
        "brief briefs/a.md: placeholder {{nope.x}} names neither inputs nor a stage",
    });
    expect(fs.filter((f) => f.message.includes("inputs.topic"))).toEqual([]);
  });

  test("a placeholder for a stage not on every path is a warning", async () => {
    const l = loaded(
      {
        s: agent({ a: { next: "x" }, b: { next: "y" } }, "briefs/s.md"),
        x: agent({ ok: { next: "m" } }, "briefs/x.md"),
        y: agent({ ok: { next: "m" } }, "briefs/y.md"),
        m: agent({ ok: { next: "z" } }, "briefs/m.md"),
        z: end(),
      },
      {
        briefs: {
          "briefs/s.md": "{{s.v}}",
          "briefs/x.md": "{{x.v}} {{s.v}}",
          "briefs/y.md": "",
          "briefs/m.md": "{{x.v}} {{s.v}} {{m.v}}",
        },
      },
    );
    const fs = only(await run(l), "references");
    expect(fs).toEqual([
      {
        check: "references",
        severity: "warning",
        stage: "m",
        message:
          "brief briefs/m.md: placeholder {{x.v}} names stage x, which is not on every path to m",
      },
    ]);
  });

  test("a guard syntax error is a references finding", async () => {
    const l = loaded({
      a: agent({ ok: { next: [{ if: "count(", to: "z" }, { to: "z" }] } }),
      z: end(),
    });
    const f = only(await run(l), "references").find((x) =>
      x.message.startsWith("stage a outcome ok branch 0: "),
    );
    expect(f).toMatchObject({ severity: "error", stage: "a" });
  });

  test("a guard naming an unknown stage is an error, inputs are fine", async () => {
    const l = loaded({
      a: agent({
        ok: {
          next: [
            { if: "count(ghost.x) < 2 and inputs.n > 1", to: "z" },
            { to: "z" },
          ],
        },
      }),
      z: end(),
    });
    expect(only(await run(l), "references")).toEqual([
      {
        check: "references",
        severity: "error",
        stage: "a",
        message: "stage a outcome ok branch 0: guard names unknown stage ghost",
      },
    ]);
  });
});

describe("gate prompts", () => {
  const gate = (prompt: string): Stage =>
    ({
      type: "gate",
      prompt,
      timeout: 120_000,
      onTimeout: { remind: 60_000 },
      outcomes: { yes: { next: "z" } },
    }) as Stage;

  test("an unknown name in a gate prompt is an error", async () => {
    const l = loaded({ g: gate("Ship {{nothing}}?"), z: end() });
    expect(only(await run(l), "references")).toContainEqual({
      check: "references",
      severity: "error",
      stage: "g",
      message:
        "gate prompt: placeholder {{nothing}} names neither inputs nor a stage",
    });
  });

  test("a gate prompt naming a stage off some path is a warning", async () => {
    const l = loaded({
      a: agent({ x: { next: "g" }, y: { next: "b" } }),
      b: agent({ ok: { next: "g" } }),
      g: gate("Result {{b.pr}}"),
      z: end(),
    });
    expect(only(await run(l), "references")).toContainEqual({
      check: "references",
      severity: "warning",
      stage: "g",
      message:
        "gate prompt: placeholder {{b.pr}} names stage b, which is not on every path to g",
    });
  });

  test("inputs and dominating stages in a gate prompt pass", async () => {
    const l = loaded({
      a: agent({ ok: { next: "g" } }),
      g: gate("{{inputs.topic}} {{a.pr}}"),
      z: end(),
    });
    expect(only(await run(l), "references")).toEqual([]);
  });
});
