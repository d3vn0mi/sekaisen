import type { LoadedDefinition } from "../format/load.js";
import { failedEnd } from "../format/rules.js";
import { edgesOf } from "./edges.js";
import { canFail } from "./failure.js";
import type { Finding } from "./index.js";

const err = (stage: string, message: string): Finding => ({
  check: "graph",
  severity: "error",
  stage,
  message,
});

function reach(roots: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let s = queue.pop(); s !== undefined; s = queue.pop()) {
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(...(adj.get(s) ?? []));
  }
  return seen;
}

/** Structure of the stage graph; guards are ignored, any declared edge counts. */
export function graphFindings(loaded: LoadedDefinition): Finding[] {
  const { def } = loaded;
  const out: Finding[] = [];
  const ids = Object.keys(def.stages);
  const edges: Array<{ from: string; to: string }> = edgesOf(def).filter(
    (e) => e.to in def.stages,
  );
  // A stage that can fail without an `onExhausted` goes to the first failed
  // end, an edge the definition does not write out.
  const failed = failedEnd(def);
  if (failed !== undefined) {
    for (const [id, stage] of Object.entries(def.stages)) {
      const own =
        stage.type === "agent" || stage.type === "action"
          ? stage.onExhausted
          : undefined;
      if (canFail(stage) && own === undefined) {
        edges.push({ from: id, to: failed });
      }
    }
  }

  for (const [id, stage] of Object.entries(def.stages)) {
    if (stage.type !== "agent" && stage.type !== "gate") continue;
    const names = Object.keys(stage.outcomes);
    if (names.length === 0) out.push(err(id, `stage ${id} has no exit`));
    for (const name of names) {
      const next = (stage.outcomes[name] as { next: unknown }).next;
      if (next === "" || (Array.isArray(next) && next.length === 0)) {
        out.push(err(id, `stage ${id} outcome ${name} has no next`));
      } else if (
        Array.isArray(next) &&
        next[next.length - 1]?.if !== undefined
      ) {
        out.push(
          err(
            id,
            `stage ${id} outcome ${name}: the last branch must be unconditional`,
          ),
        );
      }
    }
  }

  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const e of edges) {
    forward.set(e.from, [...(forward.get(e.from) ?? []), e.to]);
    backward.set(e.to, [...(backward.get(e.to) ?? []), e.from]);
  }
  const roots = [def.start, def.onCancel].filter(
    (s): s is string => s !== undefined && s in def.stages,
  );
  const reachable = reach(roots, forward);
  for (const id of ids) {
    if (!reachable.has(id)) {
      out.push(err(id, `stage ${id} is not reachable from start`));
    }
  }
  const ends = ids.filter((id) => def.stages[id]?.type === "end");
  const canEnd = reach(ends, backward);
  for (const id of ids) {
    if (reachable.has(id) && !canEnd.has(id)) {
      out.push(err(id, `no end is reachable from stage ${id}`));
    }
  }
  return out;
}
