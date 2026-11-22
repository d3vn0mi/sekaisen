import { edgeId, edgesOf } from "../checks/edges.js";
import type { Definition, Stage } from "../format/types.js";

export interface RenderOptions {
  /** Stage to highlight as the one a run is in. */
  current?: string;
  /** Edge ids (`<stage>.<outcome>[<branch>]`) a run has followed. */
  taken?: Set<string>;
}

const GUARD_MAX = 60;

function quote(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/;/g, "#59;")
    .replace(/"/g, "#quot;");
}

function guardText(guard: string): string {
  const flat = guard.replace(/\s+/g, " ").trim();
  return flat.length > GUARD_MAX ? `${flat.slice(0, GUARD_MAX)}…` : flat;
}

function stageLabel(id: string, stage: Stage): string {
  const kind = stage.type === "agent" ? `agent: ${stage.agent}` : stage.type;
  return `${id} (${kind})`;
}

/** Stable Mermaid-safe state ids; two stage ids that sanitise alike stay distinct. */
function stateIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const id of ids) {
    const base = `s_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    out.set(id, name);
  }
  return out;
}

/**
 * A `stateDiagram-v2` of the definition: one state per stage, one transition
 * per declared edge in definition order, end stages linked to `[*]`.
 * Mermaid cannot style a transition by class, so a followed transition gets a
 * `✓ ` label prefix and the states it touches get the `taken` class. The
 * `--> [*]` links of end stages have no edge id and are never marked.
 */
export function renderMermaid(
  def: Definition,
  opts: RenderOptions = {},
): string {
  const taken = opts.taken ?? new Set<string>();
  const ids = stateIds(Object.keys(def.stages));
  const sid = (id: string) => ids.get(id) ?? `s_${id}`;
  const lines: string[] = ["stateDiagram-v2"];
  for (const [id, stage] of Object.entries(def.stages)) {
    lines.push(`  state "${quote(stageLabel(id, stage))}" as ${sid(id)}`);
  }
  if (def.onCancel) lines.push('  state "cancel" as cancel');

  const links: string[] = [];
  const touched = new Set<string>();
  const link = (from: string, to: string, label: string, isTaken: boolean) => {
    const text = isTaken ? `✓ ${label}`.trimEnd() : label;
    links.push(`  ${from} --> ${to}${text ? ` : ${quote(text)}` : ""}`);
  };

  link("[*]", sid(def.start), "", false);
  for (const e of edgesOf(def)) {
    const isTaken = taken.has(edgeId(e));
    let label = e.outcome === "next" && e.synthetic ? "" : e.outcome;
    if (e.guard !== undefined) label += ` [${guardText(e.guard)}]`;
    const from = e.from === "*" ? "cancel" : sid(e.from);
    link(from, sid(e.to), label, isTaken);
    if (isTaken) {
      touched.add(e.from);
      touched.add(e.to);
    }
  }
  for (const [id, stage] of Object.entries(def.stages)) {
    if (stage.type === "end") link(sid(id), "[*]", stage.status, false);
  }
  lines.push(...links);

  lines.push("  classDef current fill:#fde68a,stroke:#b45309,stroke-width:2px");
  lines.push("  classDef taken fill:#d1fae5,stroke:#047857");
  const marked = [...touched].filter(
    (id) => id !== opts.current && ids.has(id),
  );
  if (marked.length > 0) {
    lines.push(`  class ${marked.map(sid).join(",")} taken`);
  }
  if (opts.current !== undefined && ids.has(opts.current)) {
    lines.push(`  class ${sid(opts.current)} current`);
  }
  return `${lines.join("\n")}\n`;
}
