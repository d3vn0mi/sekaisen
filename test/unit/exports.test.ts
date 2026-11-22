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

test("package.json exports the root, the MCP server and the schema", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.exports).toEqual({
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./mcp": {
      types: "./dist/mcp/server.d.ts",
      default: "./dist/mcp/server.js",
    },
    "./schema.json": "./dist/format/schema.json",
  });
});
