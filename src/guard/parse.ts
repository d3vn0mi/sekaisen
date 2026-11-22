/** Longest accepted guard source, in characters. */
export const MAX_GUARD_LENGTH = 1000;
/** Deepest accepted nesting of parentheses and `not`. */
export const MAX_GUARD_DEPTH = 64;

export class GuardSyntaxError extends Error {
  readonly column: number;
  constructor(message: string, column: number) {
    super(`${message} (column ${column})`);
    this.name = "GuardSyntaxError";
    this.column = column;
  }
}

export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

interface Base {
  /** The source text this node was parsed from. */
  text: string;
}

export type GuardAst = Base &
  (
    | { kind: "int"; value: number }
    | { kind: "str"; value: string }
    | { kind: "bool"; value: boolean }
    | { kind: "count"; stage: string; outcome: string }
    | { kind: "attempts"; stage: string }
    | { kind: "input"; path: string }
    | { kind: "field"; stage: string; name: string }
    | { kind: "not"; operand: GuardAst }
    | { kind: "and"; terms: GuardAst[] }
    | { kind: "or"; terms: GuardAst[] }
    | { kind: "cmp"; op: CompareOp; left: GuardAst; right: GuardAst }
  );

type Tok =
  | { t: "int"; v: number; at: number; end: number }
  | { t: "str"; v: string; at: number; end: number }
  | { t: "id"; v: string; at: number; end: number }
  | { t: "op"; v: string; at: number; end: number }
  | { t: "eof"; v: ""; at: number; end: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c >= "0" && c <= "9") {
      const at = i;
      while (
        i < src.length &&
        (src[i] as string) >= "0" &&
        (src[i] as string) <= "9"
      )
        i++;
      const v = Number(src.slice(at, i));
      if (!Number.isSafeInteger(v))
        throw new GuardSyntaxError("integer too large", at + 1);
      out.push({ t: "int", v, at, end: i });
    } else if (c === '"') {
      const at = i++;
      let v = "";
      for (;;) {
        if (i >= src.length)
          throw new GuardSyntaxError("unterminated string", at + 1);
        const d = src[i] as string;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\") {
          const e = src[i + 1];
          if (e !== '"' && e !== "\\")
            throw new GuardSyntaxError("unknown escape", i + 1);
          v += e;
          i += 2;
        } else {
          v += d;
          i++;
        }
      }
      out.push({ t: "str", v, at, end: i });
    } else if (IDENT_START.test(c)) {
      const at = i;
      while (i < src.length && IDENT_PART.test(src[i] as string)) i++;
      out.push({ t: "id", v: src.slice(at, i), at, end: i });
    } else {
      const two = src.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        out.push({ t: "op", v: two, at: i, end: i + 2 });
        i += 2;
      } else if ("<>().,".includes(c)) {
        out.push({ t: "op", v: c, at: i, end: i + 1 });
        i++;
      } else {
        throw new GuardSyntaxError(
          `unexpected character ${JSON.stringify(c)}`,
          i + 1,
        );
      }
    }
  }
  out.push({ t: "eof", v: "", at: src.length, end: src.length });
  return out;
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
  ) {}

  private get tok(): Tok {
    return this.toks[this.pos] as Tok;
  }
  private col(t: Tok = this.tok): number {
    return t.at + 1;
  }
  private isWord(w: string): boolean {
    return this.tok.t === "id" && this.tok.v === w;
  }
  private isOp(o: string): boolean {
    return this.tok.t === "op" && this.tok.v === o;
  }
  private expectOp(o: string): Tok {
    if (!this.isOp(o))
      throw new GuardSyntaxError(`expected "${o}"`, this.col());
    return this.toks[this.pos++] as Tok;
  }
  private ident(what: string): { v: string } {
    const t = this.tok;
    if (t.t !== "id" || RESERVED.has(t.v))
      throw new GuardSyntaxError(`expected ${what}`, this.col());
    this.pos++;
    return t;
  }
  private lastEnd(): number {
    return (this.toks[this.pos - 1] as Tok).end;
  }
  private text(from: number): string {
    return this.src.slice(from, this.lastEnd());
  }
  private enter(): void {
    if (++this.depth > MAX_GUARD_DEPTH) {
      throw new GuardSyntaxError(
        `nested deeper than ${MAX_GUARD_DEPTH}`,
        this.col(),
      );
    }
  }

  parse(): GuardAst {
    const ast = this.or();
    if (this.tok.t !== "eof")
      throw new GuardSyntaxError("unexpected input", this.col());
    return ast;
  }

  private or(): GuardAst {
    const from = this.tok.at;
    const first = this.and();
    if (!this.isWord("or")) return first;
    const terms = [first];
    while (this.isWord("or")) {
      this.pos++;
      terms.push(this.and());
    }
    return { kind: "or", terms, text: this.text(from) };
  }

  private and(): GuardAst {
    const from = this.tok.at;
    const first = this.not();
    if (!this.isWord("and")) return first;
    const terms = [first];
    while (this.isWord("and")) {
      this.pos++;
      terms.push(this.not());
    }
    return { kind: "and", terms, text: this.text(from) };
  }

  private not(): GuardAst {
    if (!this.isWord("not")) return this.comparison();
    const from = this.tok.at;
    this.pos++;
    this.enter();
    const operand = this.not();
    this.depth--;
    return { kind: "not", operand, text: this.text(from) };
  }

  private comparison(): GuardAst {
    const from = this.tok.at;
    const left = this.primary();
    if (this.tok.t === "op" && COMPARE_OPS.has(this.tok.v)) {
      const op = this.tok.v as CompareOp;
      this.pos++;
      const right = this.primary();
      return { kind: "cmp", op, left, right, text: this.text(from) };
    }
    return left;
  }

  private primary(): GuardAst {
    const t = this.tok;
    const from = t.at;
    if (t.t === "int") {
      this.pos++;
      return { kind: "int", value: t.v, text: this.text(from) };
    }
    if (t.t === "str") {
      this.pos++;
      return { kind: "str", value: t.v, text: this.text(from) };
    }
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      this.enter();
      const inner = this.or();
      this.depth--;
      this.expectOp(")");
      return inner;
    }
    if (t.t !== "id")
      throw new GuardSyntaxError("expected a value", this.col());
    if (t.v === "true" || t.v === "false") {
      this.pos++;
      return { kind: "bool", value: t.v === "true", text: this.text(from) };
    }
    if (t.v === "count") {
      this.pos++;
      this.expectOp("(");
      const stage = this.ident("a stage name").v;
      this.expectOp(".");
      const outcome = this.ident("an outcome name").v;
      this.expectOp(")");
      return { kind: "count", stage, outcome, text: this.text(from) };
    }
    if (t.v === "attempts") {
      this.pos++;
      this.expectOp("(");
      const stage = this.ident("a stage name").v;
      this.expectOp(")");
      return { kind: "attempts", stage, text: this.text(from) };
    }
    if (t.v === "inputs") {
      this.pos++;
      this.expectOp(".");
      const path = this.path();
      return { kind: "input", path, text: this.text(from) };
    }
    const stage = this.ident("a value").v;
    this.expectOp(".");
    const name = this.path();
    return { kind: "field", stage, name, text: this.text(from) };
  }

  private path(): string {
    const parts = [this.ident("a field name").v];
    while (this.isOp(".")) {
      this.pos++;
      parts.push(this.ident("a field name").v);
    }
    return parts.join(".");
  }
}

const RESERVED = new Set(["and", "or", "not", "true", "false"]);

export function parseGuard(src: string): GuardAst {
  if (src.length > MAX_GUARD_LENGTH) {
    throw new GuardSyntaxError(
      `guard longer than ${MAX_GUARD_LENGTH} characters`,
      MAX_GUARD_LENGTH + 1,
    );
  }
  return new Parser(src, tokenize(src)).parse();
}

export interface GuardReferences {
  stages: string[];
  inputs: string[];
}

/** Stage names and input paths a guard mentions, each once, in first-seen order. */
export function guardReferences(ast: GuardAst): GuardReferences {
  const stages = new Set<string>();
  const inputs = new Set<string>();
  const walk = (n: GuardAst): void => {
    switch (n.kind) {
      case "count":
      case "attempts":
      case "field":
        stages.add(n.stage);
        break;
      case "input":
        inputs.add(n.path);
        break;
      case "not":
        walk(n.operand);
        break;
      case "and":
      case "or":
        for (const t of n.terms) walk(t);
        break;
      case "cmp":
        walk(n.left);
        walk(n.right);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return { stages: [...stages], inputs: [...inputs] };
}
