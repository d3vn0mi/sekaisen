import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { runChecks } from "../../../src/checks/index.js";
import { loadDefinition } from "../../../src/format/load.js";
import { createRegistry } from "../../../src/host/registry.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("the README's example pipeline passes sekaisen check", async () => {
  const readme = readFileSync("README.md", "utf8");
  const yaml = /```yaml\n([\s\S]*?)```/.exec(readme)?.[1];
  if (yaml === undefined) throw new Error("the README has no YAML example");
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-readme-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "briefs"));
  for (const m of yaml.matchAll(/brief: (briefs\/[\w-]+\.md)/g)) {
    writeFileSync(path.join(dir, m[1] as string), "Do the work.\n");
  }
  writeFileSync(path.join(dir, "pipeline.yaml"), yaml);
  const loaded = await loadDefinition(path.join(dir, "pipeline.yaml"));
  const registry = createRegistry();
  registry.actions.set("demo.notify", async () => undefined);
  const findings = await runChecks(loaded, { registry });
  expect(findings.filter((f) => f.severity !== "info")).toEqual([]);
});
