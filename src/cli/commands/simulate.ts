import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type LoadedDefinition, loadDefinition } from "../../format/load.js";
import {
  EXPLORE_MAX_STEPS,
  type ExploreProblem,
  type ExploreResult,
  explore,
} from "../../simulate/explore.js";
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
  "sekaisen simulate <file> (--script <yaml> | --explore [--max-depth N] [--max-paths N] [--max-steps N]) [--json]";

const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_PATHS = 2000;

/**
 * Runs a scripted simulation of one definition and prints its transition
 * log, final status and edge coverage; exit 0 when the run reached an `end`
 * stage, 1 when it did not. With `--explore`, simulates the definition's
 * paths instead (each at most `--max-steps` ticks, 200 by default) and
 * prints its problems, grouped by kind and stage with the shortest path
 * of each, and the coverage merged over all paths; exit 0 when there is
 * no problem (a search cut short by `--max-paths` only warns), 1
 * otherwise. Exit 1 when the file or script cannot be used, 2 on a usage
 * error.
 */
export async function simulateCommand(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        script: { type: "string" };
        explore: { type: "boolean" };
        "max-depth": { type: "string" };
        "max-paths": { type: "string" };
        "max-steps": { type: "string" };
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
        explore: { type: "boolean" },
        "max-depth": { type: "string" },
        "max-paths": { type: "string" },
        "max-steps": { type: "string" },
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
  const { script: scriptFile, explore: exploring } = parsed.values;
  const maxDepth = count(parsed.values["max-depth"], DEFAULT_MAX_DEPTH, true);
  const maxPaths = count(parsed.values["max-paths"], DEFAULT_MAX_PATHS, false);
  const maxSteps = count(parsed.values["max-steps"], EXPLORE_MAX_STEPS, false);
  const limitsGiven =
    parsed.values["max-depth"] !== undefined ||
    parsed.values["max-paths"] !== undefined ||
    parsed.values["max-steps"] !== undefined;
  if (
    maxDepth === undefined ||
    maxPaths === undefined ||
    maxSteps === undefined
  ) {
    io.err(
      `--max-depth takes a whole number, --max-paths and --max-steps positive ones\nusage: ${SIMULATE_USAGE}\n`,
    );
    return 2;
  }
  // Either a script, or exploring with its limits; never both.
  const mode: { explore: true } | { script: string } | undefined = exploring
    ? scriptFile === undefined
      ? { explore: true }
      : undefined
    : scriptFile === undefined || limitsGiven
      ? undefined
      : { script: scriptFile };
  if (file === undefined || extra.length > 0 || mode === undefined) {
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
  if ("explore" in mode) {
    let result: ExploreResult;
    try {
      result = await explore(loaded, { maxDepth, maxPaths, maxSteps });
    } catch (x) {
      io.err(`${file}: error explore ${(x as Error).message}\n`);
      return 1;
    }
    io.out(
      parsed.values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : exploreReport(result),
    );
    return result.problems.length > 0 ? 1 : 0;
  }
  const scriptPath = mode.script;
  let text: string;
  try {
    text = await readFile(scriptPath, "utf8");
  } catch (x) {
    io.err(`${scriptPath}: error load ${(x as Error).message}\n`);
    return 1;
  }
  let script: Script;
  try {
    script = parseScript(text, loaded.def);
  } catch (x) {
    const problems =
      x instanceof ScriptError ? x.problems : [(x as Error).message];
    for (const p of problems) io.err(`${scriptPath}: error script ${p}\n`);
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

/** A count option: its default when absent, undefined when it is not a whole number (0 only when `zero`). */
function count(
  raw: string | undefined,
  fallback: number,
  zero: boolean,
): number | undefined {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n === 0 && !zero ? undefined : n;
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
  return out + coverageLines(r.coverage);
}

function exploreReport(r: ExploreResult): string {
  let out = `explore: ${r.paths} paths, ${r.problems.length} problems\n`;
  if (r.truncated) out += `explore: truncated at ${r.paths} paths\n`;
  // One line per kind and stage, with the shortest path that shows it.
  const groups = new Map<string, { shortest: ExploreProblem; paths: number }>();
  for (const p of r.problems) {
    const key = `${p.problem} at ${p.stage}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { shortest: p, paths: 1 });
    else {
      g.paths++;
      if (p.path.length < g.shortest.path.length) g.shortest = p;
    }
  }
  for (const [key, g] of groups) {
    const way = g.shortest.path.join(" → ") || "(no decisions)";
    const n = g.paths === 1 ? "1 path" : `${g.paths} paths`;
    out += `problem: ${key} (${n}): ${way}\n`;
  }
  out += coverageLines(r.coverage);
  return out;
}

function coverageLines(c: ExploreResult["coverage"]): string {
  const total = c.taken.length + c.untaken.length;
  let out = `edges: ${c.taken.length}/${total}\n`;
  if (c.untaken.length > 0) out += `untaken: ${c.untaken.join(", ")}\n`;
  return out;
}
