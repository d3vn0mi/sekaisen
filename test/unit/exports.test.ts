import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type {
  ActionStage,
  AgentStage,
  CheckStage,
  Definition,
  Ending,
  EndStage,
  GateRow,
  GateStage,
  JsonSchema,
  LimitRow,
  Outcome,
  RetryEnding,
  RunRow,
  RunStatus,
  Stage,
  StageRunRow,
  StageRunState,
  TransitionRow,
  WaitStage,
} from "../../src/index.js";
import * as root from "../../src/index.js";

test("the package root exports the core", () => {
  expect(Object.keys(root).sort()).toEqual([
    "Engine",
    "VERSION",
    "createRegistry",
    "explore",
    "loadDefinition",
    "openSqliteStore",
    "parseScript",
    "renderMermaid",
    "runChecks",
    "simulate",
  ]);
  for (const [name, value] of Object.entries(root)) {
    expect([name, typeof value]).toEqual([
      name,
      name === "VERSION" ? "string" : "function",
    ]);
  }
});

test("the package root names the types its own signatures use", () => {
  // A compile-time check: `npm run typecheck` fails if any of these stops
  // being exported from the root.
  type Named = [
    RunRow,
    StageRunRow,
    GateRow,
    TransitionRow,
    LimitRow,
    RunStatus,
    StageRunState,
    RetryEnding,
    Ending,
    JsonSchema,
    Definition,
    Stage,
    AgentStage,
    GateStage,
    CheckStage,
    ActionStage,
    WaitStage,
    EndStage,
    Outcome,
  ];
  const names: Named | undefined = undefined;
  expect(names).toBeUndefined();
});

test("package.json exports the root, the MCP server, the OpenClaw adapter and the schema", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.exports).toEqual({
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./mcp": {
      types: "./dist/mcp/server.d.ts",
      default: "./dist/mcp/server.js",
    },
    "./openclaw": {
      types: "./dist/openclaw/index.d.ts",
      default: "./dist/openclaw/index.js",
    },
    "./schema.json": "./dist/format/schema.json",
  });
});

test("the OpenClaw subpath exports the adapter and plugin helpers and stays out of the root", async () => {
  const sub = await import("../../src/openclaw/index.js");
  expect(Object.keys(sub).sort()).toEqual([
    "OpenClawAdapter",
    "createPipelinePlugin",
    "defaultSessionKey",
    "gateButtons",
  ]);
  for (const name of Object.keys(sub)) {
    expect(Object.keys(root)).not.toContain(name);
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.dependencies).toEqual({ yaml: pkg.dependencies.yaml });
  expect(pkg.peerDependenciesMeta.openclaw.optional).toBe(true);
});
