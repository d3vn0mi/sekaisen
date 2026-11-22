import type { LoadedDefinition } from "../format/load.js";
import type { Definition } from "../format/types.js";
import { type GuardBound, guardBounds } from "../guard/bounds.js";
import { GuardSyntaxError, parseGuard } from "../guard/parse.js";
import { type Edge, edgesOf } from "./edges.js";
import type { Finding } from "./index.js";

function boundsOf(e: Edge): GuardBound[] {
  if (e.guard === undefined) return [];
  try {
    return guardBounds(parseGuard(e.guard));
  } catch (x) {
    if (x instanceof GuardSyntaxError) return [];
    throw x;
  }
}

/** The edges that follow an operator's answer; only these end a loop for certain. */
function answered(def: Definition, e: Edge): boolean {
  const s = def.stages[e.from];
  return (
    s?.type === "gate" &&
    s.who === "operator" &&
    s.poll === undefined &&
    !e.synthetic &&
    Object.hasOwn(s.outcomes, e.outcome)
  );
}

/** True when `outcome` is one the stage declares, not a synthetic edge label. */
function declared(def: Definition, stage: string, outcome: string): boolean {
  const s = def.stages[stage];
  return (
    (s?.type === "agent" || s?.type === "gate" || s?.type === "check") &&
    Object.hasOwn(s.outcomes, outcome)
  );
}

/**
 * An edge breaks every cycle through it when a bound in its guard names a
 * counter that each such cycle also passes, or when the bound says the branch
 * is never taken. `edges` has the operator-answered edges already removed.
 */
function breaks(def: Definition, e: Edge, edges: Edge[]): boolean {
  const bounds = boundsOf(e);
  if (bounds.some((b) => b.max < 0)) return true;
  return bounds.some((b) => {
    const kind = def.stages[b.stage]?.type;
    if (
      b.outcome !== undefined
        ? !declared(def, b.stage, b.outcome)
        : kind !== "agent" && kind !== "action"
    ) {
      return false;
    }
    const onB = (x: Edge): boolean =>
      b.outcome !== undefined &&
      !x.synthetic &&
      x.from === b.stage &&
      x.outcome === b.outcome;
    if (onB(e)) return true;
    // Is there a way back from e.to to e.from that misses what the bound names?
    const hidden = (n: string): boolean =>
      b.outcome === undefined && n === b.stage;
    if (hidden(e.to) || hidden(e.from)) return true;
    const seen = new Set<string>();
    const stack = [e.to];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (n === e.from) return false;
      for (const x of edges) {
        if (x.from === n && !onB(x) && !hidden(x.to)) stack.push(x.to);
      }
    }
    return true;
  });
}

/** Strongly connected components (Tarjan), each as a set of stage ids. */
function components(ids: string[], edges: Edge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      out.push(comp);
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return out;
}

/** A simple cycle through `first`, staying inside `members`. */
function cycleThrough(
  first: string,
  members: Set<string>,
  edges: Edge[],
): string[] {
  const path: string[] = [first];
  const seen = new Set<string>([first]);
  const dfs = (n: string): boolean => {
    for (const e of edges) {
      if (e.from !== n || !members.has(e.to)) continue;
      if (e.to === first) return true;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      path.push(e.to);
      if (dfs(e.to)) return true;
      path.pop();
    }
    return false;
  };
  dfs(first);
  return [...path, first];
}

/**
 * Every cycle must pass an answered operator gate or an edge whose guard
 * bounds a count or attempts term that lies on the cycle.
 */
export function terminationFindings(loaded: LoadedDefinition): Finding[] {
  const { def } = loaded;
  const ids = Object.keys(def.stages);
  const open = edgesOf(def).filter(
    (e) => e.from !== "*" && e.to in def.stages && !answered(def, e),
  );
  const live = open.filter((e) => !breaks(def, e, open));
  const out: Finding[] = [];
  for (const comp of components(ids, live)) {
    const members = new Set(comp);
    const loops =
      comp.length > 1 ||
      live.some((e) => e.from === comp[0] && e.to === comp[0]);
    if (!loops) continue;
    const first = ids.find((id) => members.has(id)) as string;
    const cycle = cycleThrough(first, members, live);
    out.push({
      check: "termination",
      severity: "error",
      stage: first,
      message: `cycle ${cycle.join(" → ")} is unbounded`,
    });
  }
  return out.sort(
    (a, b) => ids.indexOf(a.stage ?? "") - ids.indexOf(b.stage ?? ""),
  );
}
