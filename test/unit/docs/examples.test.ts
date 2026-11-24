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
