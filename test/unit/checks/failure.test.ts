import { describe, expect, test } from "vitest";
import type { Finding } from "../../../src/checks/index.js";
import type { Stage } from "../../../src/format/types.js";
import { createRegistry } from "../../../src/host/registry.js";
import { agent, end, loaded, run } from "./helpers.js";

const failure = (fs: Finding[]) => fs.filter((f) => f.check === "failure");
const errors = (fs: Finding[]) => fs.filter((f) => f.severity === "error");

const registry = () => {
  const r = createRegistry();
  r.checks.set("demo.ready", async () => "yes");
  r.actions.set("demo.notify", async () => {});
  return r;
};

const noFailedEnd = (stage: string): Finding => ({
  check: "failure",
  severity: "error",
  stage,
  message: `stage ${stage} can fail but the pipeline has no failed end`,
});

describe("failure", () => {
  test("an agent with no failed end and no on_exhausted is an error", async () => {
    const fs = await run(loaded({ a: agent({ ok: { next: "z" } }), z: end() }));
    expect(failure(fs)).toEqual([noFailedEnd("a")]);
  });

  test("on_exhausted or a failed end satisfies it", async () => {
    const withTarget = loaded({
      a: {
        ...(agent({ ok: { next: "z" } }) as object),
        onExhausted: "z",
      } as Stage,
      z: end(),
    });
    expect(failure(await run(withTarget))).toEqual([]);
    // A failed end reached only when a stage exhausts is reachable.
    const withEnd = loaded({
      a: agent({ ok: { next: "z" } }),
      z: end(),
      failed: end("failed"),
    });
    expect(errors(await run(withEnd))).toEqual([]);
  });

  test("checks, actions and waits until an instant can fail", async () => {
    const l = loaded({
      c: { type: "check", check: "demo.ready", outcomes: { yes: "n" } },
      n: {
        type: "action",
        action: "demo.notify",
        next: "w",
        retry: { max: 0, on: [] },
      },
      w: { type: "wait", until: "2030-01-01T00:00:00Z", next: "f" },
      f: { type: "wait", for: 60_000, next: "g" },
      g: {
        type: "gate",
        who: "operator",
        timeout: 120_000,
        onTimeout: { remind: 60_000 },
        outcomes: { yes: { next: "z" } },
      },
      z: end(),
    });
    expect(failure(await run(l, registry()))).toEqual([
      noFailedEnd("c"),
      noFailedEnd("n"),
      noFailedEnd("w"),
    ]);
  });

  test("a retry that can never apply is a warning", async () => {
    const l = loaded({
      a: {
        ...(agent({ ok: { next: "z" } }) as object),
        retry: { max: 2, on: [] },
      } as unknown as Stage,
      z: end(),
      failed: end("failed"),
    });
    expect(failure(await run(l))).toEqual([
      {
        check: "failure",
        severity: "warning",
        stage: "a",
        message: "stage a: retry.max > 0 but retry.on is empty",
      },
    ]);
  });
});
