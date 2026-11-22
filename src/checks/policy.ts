import type { LoadedDefinition } from "../format/load.js";
import { edgesOf } from "./edges.js";
import type { Finding } from "./index.js";

/**
 * Reports the provider policy and checks that a stage which deploys cannot be
 * reached from the start without passing a gate the operator answers.
 */
export function policyFindings(loaded: LoadedDefinition): Finding[] {
  const { def } = loaded;
  const p = def.providers;
  const out: Finding[] = [
    {
      check: "policy",
      severity: "info",
      message:
        typeof p === "string"
          ? `providers: ${p}`
          : `providers: allow [${p.allow.join(", ")}]`,
    },
  ];
  if (!(def.start in def.stages)) return out;
  const adj = new Map<string, string[]>();
  for (const e of edgesOf(def)) {
    if (e.from === "*" || !(e.to in def.stages)) continue;
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const guarded = (id: string): boolean => {
    const s = def.stages[id];
    return s?.type === "gate" && s.who === "operator";
  };
  // Walk only through stages that are not operator gates, remembering the way in.
  const via = new Map<string, string | null>([[def.start, null]]);
  const queue = [def.start];
  for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
    if (guarded(n)) continue;
    for (const m of adj.get(n) ?? []) {
      if (via.has(m)) continue;
      via.set(m, n);
      queue.push(m);
    }
  }
  for (const [id, stage] of Object.entries(def.stages)) {
    if (
      stage.type !== "agent" ||
      !stage.deploys ||
      !via.has(id) ||
      guarded(id)
    ) {
      continue;
    }
    const path: string[] = [];
    for (let n: string | null | undefined = id; n; n = via.get(n))
      path.unshift(n);
    out.push({
      check: "policy",
      severity: "error",
      stage: id,
      message: `stage ${id} deploys but can be reached without an operator gate: ${path.join(" → ")}`,
    });
  }
  return out;
}
