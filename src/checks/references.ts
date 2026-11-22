import type { LoadedDefinition } from "../format/load.js";
import {
  type GuardAst,
  GuardSyntaxError,
  guardReferences,
  parseGuard,
} from "../guard/parse.js";
import type { HostRegistry } from "../host/registry.js";
import { edgesOf } from "./edges.js";
import type { Finding } from "./index.js";

type Counter =
  | { kind: "count"; stage: string; outcome: string }
  | { kind: "attempts"; stage: string };

/** Every count and attempts term in a guard. */
function counters(ast: GuardAst): Counter[] {
  switch (ast.kind) {
    case "count":
      return [{ kind: "count", stage: ast.stage, outcome: ast.outcome }];
    case "attempts":
      return [{ kind: "attempts", stage: ast.stage }];
    case "not":
      return counters(ast.operand);
    case "and":
    case "or":
      return ast.terms.flatMap(counters);
    case "cmp":
      return [...counters(ast.left), ...counters(ast.right)];
    default:
      return [];
  }
}

export const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * For each stage, the stages that lie on every path from start to it
 * (excluding itself). A stage that cannot be reached has no entry.
 */
function dominators(loaded: LoadedDefinition): Map<string, Set<string>> {
  const { def } = loaded;
  const adj = new Map<string, string[]>();
  for (const e of edgesOf(def)) {
    if (e.from === "*" || !(e.to in def.stages)) continue;
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const reach = (skip?: string): Set<string> => {
    const seen = new Set<string>();
    if (def.start === skip || !(def.start in def.stages)) return seen;
    const stack = [def.start];
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
      if (seen.has(s)) continue;
      seen.add(s);
      for (const n of adj.get(s) ?? []) if (n !== skip) stack.push(n);
    }
    return seen;
  };
  const all = reach();
  const doms = new Map<string, Set<string>>();
  for (const t of all) doms.set(t, new Set());
  for (const s of all) {
    const without = reach(s);
    for (const t of all) {
      if (t !== s && !without.has(t)) doms.get(t)?.add(s);
    }
  }
  return doms;
}

export function referenceFindings(
  loaded: LoadedDefinition,
  registry: HostRegistry,
  unregisteredAs: "error" | "warning" = "error",
): Finding[] {
  const { def } = loaded;
  const out: Finding[] = [];
  const err = (message: string, stage?: string): void => {
    const f: Finding = { check: "references", severity: "error", message };
    if (stage !== undefined) f.stage = stage;
    out.push(f);
  };
  const warn = (message: string, stage: string): void => {
    out.push({ check: "references", severity: "warning", stage, message });
  };
  const exists = (id: string): boolean => id in def.stages;

  if (!exists(def.start)) err(`start: stage ${def.start} does not exist`);
  if (def.onCancel !== undefined && !exists(def.onCancel)) {
    err(`onCancel: target ${def.onCancel} does not exist`);
  }

  for (const e of edgesOf(def)) {
    if (e.from === "*") continue;
    if (!exists(e.to)) {
      const where =
        e.branch === undefined
          ? `outcome ${e.outcome}`
          : `outcome ${e.outcome} branch ${e.branch}`;
      const label =
        e.outcome === "on_timeout"
          ? "onTimeout"
          : e.outcome === "on_exhausted"
            ? "onExhausted"
            : where;
      err(
        `stage ${e.from} ${label}: next target ${e.to} does not exist`,
        e.from,
      );
    }
    if (e.guard !== undefined) {
      const where = `stage ${e.from} outcome ${e.outcome} branch ${e.branch}`;
      try {
        const ast = parseGuard(e.guard);
        const refs = guardReferences(ast);
        for (const t of counters(ast)) {
          const st = def.stages[t.stage];
          if (!st) continue;
          if (t.kind === "count") {
            const outs =
              st.type === "agent" || st.type === "gate" || st.type === "check"
                ? st.outcomes
                : {};
            if (!Object.hasOwn(outs, t.outcome)) {
              err(
                `${where}: guard counts undeclared outcome ${t.stage}.${t.outcome}`,
                e.from,
              );
            }
          } else if (st.type !== "agent" && st.type !== "action") {
            err(
              `${where}: guard attempts names stage ${t.stage}, which is not an agent or action stage`,
              e.from,
            );
          }
        }
        for (const s of refs.stages) {
          if (!exists(s))
            err(`${where}: guard names unknown stage ${s}`, e.from);
        }
      } catch (x) {
        if (!(x instanceof GuardSyntaxError)) throw x;
        err(`${where}: ${x.message}`, e.from);
      }
    }
  }

  const registered = (
    kind: string,
    name: string,
    known: Map<string, unknown>,
    id: string,
  ) => {
    if (!known.has(name)) {
      (unregisteredAs === "error" ? err : warn)(
        `${kind} ${name} is not registered by the host`,
        id,
      );
    }
  };
  const doms = dominators(loaded);
  // One scan for every text rendered at run time: briefs and gate prompts.
  const scan = (text: string, label: string, id: string): void => {
    const seen = new Set<string>();
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = (m[1] ?? "").trim();
      if (seen.has(name)) continue;
      seen.add(name);
      // Names the engine itself fills in at render time.
      if (name === "run.id" || name === "stage.outcomes") continue;
      const head = name.split(".")[0] ?? "";
      const shown = `${label}: placeholder {{${name}}}`;
      if (head === "inputs" && name.includes(".")) continue;
      if (!name.includes(".") || !exists(head)) {
        err(`${shown} names neither inputs nor a stage`, id);
      } else if (head !== id && doms.get(id) && !doms.get(id)?.has(head)) {
        warn(
          `${shown} names stage ${head}, which is not on every path to ${id}`,
          id,
        );
      }
    }
  };
  for (const [id, stage] of Object.entries(def.stages)) {
    if (stage.type === "check") {
      registered("check", stage.check, registry.checks, id);
    } else if (stage.type === "action") {
      registered("action", stage.action, registry.actions, id);
    } else if (stage.type === "gate") {
      if (stage.poll) registered("fact", stage.poll.fact, registry.facts, id);
      if (stage.prompt !== undefined) scan(stage.prompt, "gate prompt", id);
    } else if (stage.type === "agent") {
      const text = loaded.briefs[stage.brief];
      if (text === undefined) {
        err(`brief ${stage.brief} does not exist`, id);
        continue;
      }
      scan(text, `brief ${stage.brief}`, id);
    }
  }
  return out;
}
