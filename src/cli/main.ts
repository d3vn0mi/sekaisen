#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCommand } from "./commands/check.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `usage: sekaisen <command> [options]

commands:
  check <file...> [--json]   verify pipeline definitions

  --help                     show this text
`;

const COMMANDS: Record<string, (args: string[], io: Io) => Promise<number>> = {
  check: checkCommand,
};

/** Dispatches a subcommand and returns the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  const run = command === undefined ? undefined : COMMANDS[command];
  if (!run) {
    io.err(
      command === undefined ? USAGE : `unknown command: ${command}\n${USAGE}`,
    );
    return 2;
  }
  return run(rest, io);
}

const self = process.argv[1];
if (
  self !== undefined &&
  realpathSync(self) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
