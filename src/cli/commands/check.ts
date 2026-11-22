import { parseArgs } from "node:util";
import { type Finding, runChecks } from "../../checks/index.js";
import { loadDefinition } from "../../format/load.js";
import { createRegistry } from "../../host/registry.js";
import type { Io } from "../main.js";

export const CHECK_USAGE = "sekaisen check <file...> [--json]";

/** Loads each file and runs the checks; exit 1 on any error, 2 on a usage error. */
export async function checkCommand(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { json: { type: "boolean" } };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: "boolean" } },
      allowPositionals: true,
    });
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${CHECK_USAGE}\n`);
    return 2;
  }
  const files = parsed.positionals;
  if (files.length === 0) {
    io.err(`usage: ${CHECK_USAGE}\n`);
    return 2;
  }
  const rows: Array<{ file: string } & Finding> = [];
  for (const file of files) {
    const loaded = await loadDefinition(file);
    // Without a host the registered names are unknown, so they only warn.
    const findings = await runChecks(loaded, {
      registry: createRegistry(),
      unregisteredAs: "warning",
    });
    for (const f of findings) rows.push({ file, ...f });
  }
  const errors = rows.filter((r) => r.severity === "error").length;
  const warnings = rows.filter((r) => r.severity === "warning").length;
  if (parsed.values.json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    for (const r of rows) {
      const where = r.stage === undefined ? "" : ` [${r.stage}]`;
      io.out(`${r.file}: ${r.severity} ${r.check}${where} ${r.message}\n`);
    }
    io.out(`check: ${errors} errors, ${warnings} warnings\n`);
  }
  return errors > 0 ? 1 : 0;
}
