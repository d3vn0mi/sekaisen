import type { Definition, Next } from "../format/types.js";

/** One declared transition between stages. */
export interface Edge {
  from: string;
  /** The outcome name, or `on_timeout`, `on_exhausted`, `next`, `on_cancel`. */
  outcome: string;
  /** True for a label the format itself adds (timeouts, exhaustion, cancel, a plain next), not a declared outcome. */
  synthetic: boolean;
  /** Position within a branch list; absent for a plain target. */
  branch?: number;
  to: string;
  /** Guard source of a conditional branch. */
  guard?: string;
}

/** Stable name of an edge: `<stage>.<outcome>` or `<stage>.<outcome>[<branch>]`. */
export function edgeId(e: Edge): string {
  return `${e.from}.${e.outcome}${e.branch === undefined ? "" : `[${e.branch}]`}`;
}

function nextEdges(from: string, outcome: string, next: Next): Edge[] {
  if (typeof next === "string") {
    return next === "" ? [] : [{ from, outcome, synthetic: false, to: next }];
  }
  return next.map((b, branch) => {
    const e: Edge = { from, outcome, synthetic: false, branch, to: b.to };
    if (b.if !== undefined) e.guard = b.if;
    return e;
  });
}

/**
 * Every transition a definition declares, in stage order. Empty targets are
 * left out (they are reported as a missing next, not as an edge). The
 * definition's `onCancel` is an edge from the pseudo-stage `*`.
 */
export function edgesOf(def: Definition): Edge[] {
  const edges: Edge[] = [];
  const target = (
    from: string,
    outcome: string,
    to: string | undefined,
    synthetic = true,
  ) => {
    if (to) edges.push({ from, outcome, synthetic, to });
  };
  for (const [id, stage] of Object.entries(def.stages)) {
    switch (stage.type) {
      case "agent":
        for (const [name, o] of Object.entries(stage.outcomes)) {
          edges.push(...nextEdges(id, name, o.next));
        }
        target(id, "on_exhausted", stage.onExhausted);
        break;
      case "gate":
        for (const [name, o] of Object.entries(stage.outcomes)) {
          edges.push(...nextEdges(id, name, o.next));
        }
        if ("next" in stage.onTimeout) {
          target(id, "on_timeout", stage.onTimeout.next);
        }
        break;
      case "check":
        for (const [name, to] of Object.entries(stage.outcomes)) {
          target(id, name, to, false);
        }
        break;
      case "action":
        target(id, "next", stage.next);
        target(id, "on_exhausted", stage.onExhausted);
        break;
      case "wait":
        target(id, "next", stage.next);
        break;
      default:
        break;
    }
  }
  target("*", "on_cancel", def.onCancel);
  return edges;
}
