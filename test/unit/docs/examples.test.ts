import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runChecks } from "../../../src/checks/index.js";
import { loadDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";

test("the OpenClaw example's pipeline passes sekaisen check", async () => {
  const loaded = await loadDefinition(
    "docs/examples/openclaw-plugin/pipeline.yaml",
  );
  expect(loaded.problems).toEqual([]);
  const findings = await runChecks(loaded, { registry: createRegistry() });
  expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
});

// OpenClaw loads a plugin module synchronously and refuses a register that
// returns a promise, so the module may not wait at its top level.
test("the OpenClaw example's module does not await at its top level", () => {
  const src = readFileSync("docs/examples/openclaw-plugin/index.ts", "utf8");
  const topLevel = src
    .split("\n")
    .filter((l) => /^\S/.test(l) && !l.startsWith("//"));
  expect(topLevel.filter((l) => /\bawait\b/.test(l))).toEqual([]);
  expect(src).toContain("loadDefinitionSync(");
});
