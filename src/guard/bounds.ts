import type { GuardAst } from "./parse.js";

export interface GuardBound {
  stage: string;
  outcome?: string;
  max: number;
}

function bound(
  counter: GuardAst,
  limit: GuardAst,
  inclusive: boolean,
): GuardBound | undefined {
  if (limit.kind !== "int") return undefined;
  const max = inclusive ? limit.value : limit.value - 1;
  if (counter.kind === "count")
    return { stage: counter.stage, outcome: counter.outcome, max };
  if (counter.kind === "attempts") return { stage: counter.stage, max };
  return undefined;
}

/**
 * Upper bounds the guard imposes on a count or attempts term: `count(a.b) < 3`
 * gives max 2, `<= 3` gives 3, and the mirrored `3 > count(a.b)` the same.
 * Only terms of a top-level conjunction count; under `or` or `not` a term does
 * not have to hold, so it bounds nothing.
 */
export function guardBounds(ast: GuardAst): GuardBound[] {
  if (ast.kind === "and") return ast.terms.flatMap(guardBounds);
  if (ast.kind !== "cmp") return [];
  let b: GuardBound | undefined;
  if (ast.op === "<" || ast.op === "<=")
    b = bound(ast.left, ast.right, ast.op === "<=");
  else if (ast.op === ">" || ast.op === ">=")
    b = bound(ast.right, ast.left, ast.op === ">=");
  return b ? [b] : [];
}
