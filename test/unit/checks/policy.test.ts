import { describe, expect, test } from "vitest";
import type { Finding } from "../../../src/checks/index.js";
import type { Stage } from "../../../src/format/types.js";
import { agent, end, loaded, run } from "./helpers.js";

const pol = (fs: Finding[]) => fs.filter((f) => f.check === "policy");
const deployer = (next: string): Stage =>
  ({ ...(agent({ ok: { next } }) as object), deploys: true }) as Stage;
const gate = (who: "operator" | undefined, next: string): Stage =>
  ({
    type: "gate",
    ...(who ? { who } : {}),
    timeout: 120_000,
    onTimeout: { remind: 60_000 },
    outcomes: { yes: { next } },
  }) as Stage;

describe("policy", () => {
  test("deploy without operator gate is an error", async () => {
    const l = loaded({
      a: agent({ ok: { next: "p" } }),
      p: deployer("z"),
      z: end(),
    });
    expect(pol(await run(l)).filter((f) => f.severity === "error")).toEqual([
      {
        check: "policy",
        severity: "error",
        stage: "p",
        message:
          "stage p deploys but can be reached without an operator gate: a → p",
      },
    ]);
  });

  test("an operator gate on every path passes", async () => {
    const l = loaded({
      a: agent({ ok: { next: "g" } }),
      g: gate("operator", "p"),
      p: deployer("z"),
      z: end(),
    });
    expect(pol(await run(l)).filter((f) => f.severity === "error")).toEqual([]);
  });

  test("a gate nobody in particular answers does not protect a deploy", async () => {
    const l = loaded({
      g: gate(undefined, "p"),
      p: deployer("z"),
      z: end(),
    });
    expect(
      pol(await run(l)).filter((f) => f.severity === "error"),
    ).toHaveLength(1);
  });

  test("one unguarded path among guarded ones is an error", async () => {
    const l = loaded({
      a: agent({
        x: { next: "g" },
        y: { next: "p" },
      }),
      g: gate("operator", "p"),
      p: deployer("z"),
      z: end(),
    });
    expect(
      pol(await run(l)).filter((f) => f.severity === "error"),
    ).toHaveLength(1);
  });

  test("reports the provider policy as an info line", async () => {
    const l = loaded({ a: agent({ ok: { next: "z" } }), z: end() });
    expect(pol(await run(l))).toEqual([
      { check: "policy", severity: "info", message: "providers: fleet" },
    ]);
    l.def.providers = { allow: ["x", "y"] };
    expect(pol(await run(l))[0]?.message).toBe("providers: allow [x, y]");
    l.def.providers = "subscription";
    expect(pol(await run(l))[0]?.message).toBe("providers: subscription");
  });
});
