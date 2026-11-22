#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { HarnessAdapter } from "../adapter/types.js";
import { type DefinitionSource, Engine } from "../engine/engine.js";
import { type LoadedDefinition, loadDefinition } from "../format/load.js";
import { createRegistry } from "../host/registry.js";
import { openSqliteStore } from "../store/sqlite.js";
import { createMcpServer } from "./server.js";

export const MCP_USAGE =
  "sekaisen-mcp --store <path> --definitions <dir> --token-secret-file <path> [--agent <id>]";

const MIN_SECRET_BYTES = 32;

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

/** The YAML files under `dir`: `<dir>/*.yaml` and `<dir>/*\/pipeline.yaml`. */
function definitionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const nested = path.join(full, "pipeline.yaml");
      try {
        if (statSync(nested).isFile()) files.push(nested);
      } catch {
        // no pipeline.yaml in this directory
      }
    } else if (name.endsWith(".yaml")) {
      files.push(full);
    }
  }
  return files;
}

async function loadSource(dir: string, io: McpIo): Promise<DefinitionSource> {
  const defs = new Map<string, LoadedDefinition>();
  for (const file of definitionFiles(dir)) {
    try {
      const loaded = await loadDefinition(file);
      defs.set(loaded.def.id, loaded);
    } catch (x) {
      io.err(`sekaisen-mcp: skipped ${file}: ${(x as Error).message}\n`);
    }
  }
  return { current: (id) => defs.get(id) };
}

/** Serves the completion tools until the input closes; returns the exit code. */
export async function main(argv: string[], io: McpIo): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        store: { type: "string" },
        definitions: { type: "string" },
        "token-secret-file": { type: "string" },
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
  const definitions = values.definitions as string | undefined;
  const secretFile = values["token-secret-file"] as string | undefined;
  if (!store || !definitions || !secretFile) {
    io.err(`usage: ${MCP_USAGE}\n`);
    return 2;
  }
  let secret: Buffer;
  try {
    secret = readFileSync(secretFile);
  } catch (x) {
    io.err(`cannot read the token secret file: ${(x as Error).message}\n`);
    return 2;
  }
  if (secret.byteLength < MIN_SECRET_BYTES) {
    io.err(
      `the token secret file must hold at least ${MIN_SECRET_BYTES} raw bytes (${secretFile} holds ${secret.byteLength})\n`,
    );
    return 2;
  }
  let source: DefinitionSource;
  try {
    source = await loadSource(definitions, io);
  } catch (x) {
    io.err(`cannot read the definitions directory: ${(x as Error).message}\n`);
    return 2;
  }
  const db = openSqliteStore(store);
  const engine = new Engine({
    store: db,
    adapter: noHarness,
    registry: createRegistry(),
    definitions: source,
    dispatch: false,
    tokenSecret: secret,
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
