import type { GuardAst } from "./parse.js";

export class GuardEvalError extends Error {
  constructor(message: string, expression: string) {
    super(`${message} in guard "${expression}"`);
    this.name = "GuardEvalError";
  }
}

export interface GuardContext {
  count(stage: string, outcome: string): number;
  attempts(stage: string): number;
  field(stage: string, name: string): unknown;
  input(path: string): unknown;
}

function value(n: GuardAst, ctx: GuardContext): unknown {
  switch (n.kind) {
    case "int":
    case "str":
    case "bool":
      return n.value;
    case "count":
      return ctx.count(n.stage, n.outcome);
    case "attempts":
      return ctx.attempts(n.stage);
    case "input":
      return ctx.input(n.path);
    case "field":
      return ctx.field(n.stage, n.name);
    case "not":
      return !boolean(n.operand, ctx);
    case "and": {
      for (const t of n.terms) if (!boolean(t, ctx)) return false;
      return true;
    }
    case "or": {
      for (const t of n.terms) if (boolean(t, ctx)) return true;
      return false;
    }
    case "cmp": {
      const l = value(n.left, ctx);
      const r = value(n.right, ctx);
      if (n.op === "==") return l === r;
      if (n.op === "!=") return l !== r;
      if (typeof l !== "number" || typeof r !== "number") {
        throw new GuardEvalError(
          `"${n.op}" needs two numbers, got ${kind(l)} and ${kind(r)}`,
          n.text,
        );
      }
      if (n.op === "<") return l < r;
      if (n.op === "<=") return l <= r;
      if (n.op === ">") return l > r;
      return l >= r;
    }
  }
}

function kind(v: unknown): string {
  return v === undefined ? "undefined" : v === null ? "null" : typeof v;
}

function boolean(n: GuardAst, ctx: GuardContext): boolean {
  const v = value(n, ctx);
  if (typeof v !== "boolean")
    throw new GuardEvalError(`expected a boolean, got ${kind(v)}`, n.text);
  return v;
}

/** Evaluate a parsed guard; a result that is not a boolean throws. */
export function evalGuard(ast: GuardAst, ctx: GuardContext): boolean {
  return boolean(ast, ctx);
}
