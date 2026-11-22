#!/usr/bin/env node
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { HarnessAdapter } from "../adapter/types.js";
import { type DefinitionSource, Engine } from "../engine/engine.js";
import { createRegistry } from "../host/registry.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { createMcpServer } from "./server.js";

export const MCP_USAGE = "sekaisen-mcp --store <path> [--agent <id>]";

export interface McpIo {
  err(text: string): void;
  input: Readable;
  output: Writable;
}

/** The engine never dispatches here, so the harness is never reached. */
const noHarness: HarnessAdapter = {
  capabilities: () => Promise.reject(new Error("completion-only")),
  openSession: () => Promise.reject(new Error("completion-only")),
  startTurn: () => Promise.reject(new Error("completion-only")),
  readRunOutcome: () => Promise.reject(new Error("completion-only")),
  deliver: () => Promise.reject(new Error("completion-only")),
};

/**
 * Completions are checked against the definitions pinned in the store, so
 * this process loads none; it never starts a run.
 */
const noDefinitions: DefinitionSource = { current: () => undefined };

/** Serves the completion tools until the input closes; returns the exit code. */
export async function main(argv: string[], io: McpIo): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        store: { type: "string" },
        agent: { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${MCP_USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.err(`usage: ${MCP_USAGE}\n`);
    return 0;
  }
  const store = values.store as string | undefined;
  if (!store) {
    io.err(`usage: ${MCP_USAGE}\n`);
    return 2;
  }
  let db: Store;
  try {
    db = openSqliteStore(store);
  } catch (x) {
    io.err(`cannot open the store ${store}: ${(x as Error).message}\n`);
    return 2;
  }
  const engine = new Engine({
    store: db,
    adapter: noHarness,
    registry: createRegistry(),
    definitions: noDefinitions,
    dispatch: false,
  });
  try {
    const server = createMcpServer({
      engine,
      ...(typeof values.agent === "string"
        ? { callerAgent: values.agent }
        : {}),
      input: io.input,
      output: io.output,
    });
    await server.done;
    return 0;
  } finally {
    await engine.stop();
    db.close();
  }
}

const self = process.argv[1];
if (
  self !== undefined &&
  realpathSync(self) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2), {
    err: (t) => process.stderr.write(t),
    input: process.stdin,
    output: process.stdout,
  });
}
