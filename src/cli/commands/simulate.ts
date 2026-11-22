import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type LoadedDefinition, loadDefinition } from "../../format/load.js";
import {
  parseScript,
  type Script,
  ScriptError,
} from "../../simulate/script.js";
import {
  type SimulationResult,
  simulate,
  type TransitionLogLine,
} from "../../simulate/simulate.js";
import type { Io } from "../main.js";

export const SIMULATE_USAGE =
  "sekaisen simulate <file> --script <yaml> [--json]";

/**
 * Runs a scripted simulation of one definition and prints its transition
 * log, final status and edge coverage. Exit 0 when the run reached an `end`
 * stage, 1 when it did not or the file or script cannot be used, 2 on a
 * usage error.
 */
export async function simulateCommand(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        script: { type: "string" };
        json: { type: "boolean" };
        help: { type: "boolean" };
      };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args,
      options: {
        script: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (x) {
    io.err(`${(x as Error).message}\nusage: ${SIMULATE_USAGE}\n`);
    return 2;
  }
  if (parsed.values.help) {
    io.out(`usage: ${SIMULATE_USAGE}\n`);
    return 0;
  }
  const [file, ...extra] = parsed.positionals;
  const scriptFile = parsed.values.script;
  if (file === undefined || extra.length > 0 || scriptFile === undefined) {
    io.err(`usage: ${SIMULATE_USAGE}\n`);
    return 2;
  }

  let loaded: LoadedDefinition;
  try {
    loaded = await loadDefinition(file);
  } catch (x) {
    io.err(`${file}: error load ${(x as Error).message}\n`);
    return 1;
  }
  if (loaded.problems.length > 0) {
    for (const p of loaded.problems) io.err(`${file}: error load ${p}\n`);
    return 1;
  }
  let text: string;
  try {
    text = await readFile(scriptFile, "utf8");
  } catch (x) {
    io.err(`${scriptFile}: error load ${(x as Error).message}\n`);
    return 1;
  }
  let script: Script;
  try {
    script = parseScript(text, loaded.def);
  } catch (x) {
    const problems =
      x instanceof ScriptError ? x.problems : [(x as Error).message];
    for (const p of problems) io.err(`${scriptFile}: error script ${p}\n`);
    return 1;
  }

  let result: SimulationResult;
  try {
    result = await simulate(loaded, script);
  } catch (x) {
    io.err(`${file}: error simulate ${(x as Error).message}\n`);
    return 1;
  }
  if (parsed.values.json) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.out(report(result));
  }
  return result.reachedEnd ? 0 : 1;
}

function line(l: TransitionLogLine): string {
  const outcome = l.outcome === undefined ? "" : ` ${l.outcome}`;
  return `${l.seq} [${l.run_stage}] ${l.event}${outcome}: ${l.from ?? "-"} -> ${l.to} by ${l.actor}\n`;
}

function report(r: SimulationResult): string {
  let out = r.log.map(line).join("");
  for (const n of r.notes) out += `note: ${n}\n`;
  for (const p of r.problems) out += `problem: ${p}\n`;
  out += `status: ${r.status}${r.reachedEnd ? "" : " (did not reach an end)"}\n`;
  const total = r.coverage.taken.length + r.coverage.untaken.length;
  out += `edges: ${r.coverage.taken.length}/${total}\n`;
  if (r.coverage.untaken.length > 0) {
    out += `untaken: ${r.coverage.untaken.join(", ")}\n`;
  }
  return out;
}
