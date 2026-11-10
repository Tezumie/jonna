// `when` clauses (VS Code syntax subset): parse once, evaluate many times against context keys.
//
// Grammar (lowest to highest precedence):
//   or      := and ("||" and)*
//   and     := unary ("&&" unary)*
//   unary   := "!" unary | primary
//   primary := "(" or ")" | "true" | "false" | key [op value] | key ["not"] "in" key
//   op      := "==" | "!=" | "=~" | "<" | "<=" | ">" | ">="
// Values are quoted strings ('x' or "x"), /regex/flags (for =~), numbers, or bare words (strings).

export type WhenExpr =
  | { kind: "const"; value: boolean }
  | { kind: "key"; key: string }
  | { kind: "not"; expr: WhenExpr }
  | { kind: "and"; exprs: WhenExpr[] }
  | { kind: "or"; exprs: WhenExpr[] }
  | {
      kind: "cmp";
      key: string;
      op: "==" | "!=" | "<" | "<=" | ">" | ">=";
      value: string | number | boolean;
    }
  | { kind: "regex"; key: string; regex: RegExp }
  | { kind: "in"; key: string; container: string; negated: boolean };

export type ContextLookup = (key: string) => unknown;

export class WhenParseError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset} in when clause "${source}"`);
    this.name = "WhenParseError";
  }
}

type Token =
  | { t: "op"; v: string; at: number }
  | { t: "word"; v: string; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "regex"; v: RegExp; at: number };

const OPS = ["===", "!==", "==", "!=", "=~", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new WhenParseError("Unterminated string", src, i);
      tokens.push({ t: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    // A regex literal is only valid right after =~.
    const prev = tokens[tokens.length - 1];
    if (ch === "/" && prev?.t === "op" && prev.v === "=~") {
      let j = i + 1;
      while (j < src.length && src.charAt(j) !== "/") j += src.charAt(j) === "\\" ? 2 : 1;
      if (j >= src.length) throw new WhenParseError("Unterminated regex", src, i);
      const flags = /^[gimsuy]*/.exec(src.slice(j + 1))?.[0] ?? "";
      try {
        tokens.push({ t: "regex", v: new RegExp(src.slice(i + 1, j), flags), at: i });
      } catch {
        throw new WhenParseError("Invalid regex", src, i);
      }
      i = j + 1 + flags.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      // Normalize strict variants: context values are compared loosely, like VS Code.
      tokens.push({ t: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op, at: i });
      i += op.length;
      continue;
    }
    const word = /^[^\s()!=<>&|'"]+/.exec(src.slice(i))?.[0];
    if (!word) throw new WhenParseError(`Unexpected "${ch}"`, src, i);
    tokens.push({ t: "word", v: word, at: i });
    i += word.length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  parse(): WhenExpr {
    const expr = this.or();
    const extra = this.tokens[this.pos];
    if (extra) throw new WhenParseError("Unexpected token", this.src, extra.at);
    return expr;
  }

  private peekOp(v: string): boolean {
    const tok = this.tokens[this.pos];
    return tok?.t === "op" && tok.v === v;
  }

  private or(): WhenExpr {
    const exprs = [this.and()];
    while (this.peekOp("||")) {
      this.pos++;
      exprs.push(this.and());
    }
    return exprs.length === 1 ? (exprs[0] as WhenExpr) : { kind: "or", exprs };
  }

  private and(): WhenExpr {
    const exprs = [this.unary()];
    while (this.peekOp("&&")) {
      this.pos++;
      exprs.push(this.unary());
    }
    return exprs.length === 1 ? (exprs[0] as WhenExpr) : { kind: "and", exprs };
  }

  private unary(): WhenExpr {
    if (this.peekOp("!")) {
      this.pos++;
      return { kind: "not", expr: this.unary() };
    }
    return this.primary();
  }

  private primary(): WhenExpr {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new WhenParseError("Unexpected end", this.src, this.src.length);
    if (tok.t === "op" && tok.v === "(") {
      const inner = this.or();
      if (!this.peekOp(")")) throw new WhenParseError("Expected )", this.src, tok.at);
      this.pos++;
      return inner;
    }
    if (tok.t !== "word") throw new WhenParseError("Expected a context key", this.src, tok.at);
    if (tok.v === "true" || tok.v === "false") return { kind: "const", value: tok.v === "true" };
    const key = tok.v;
    const next = this.tokens[this.pos];
    // key in container / key not in container
    if (next?.t === "word" && (next.v === "in" || next.v === "not")) {
      const negated = next.v === "not";
      this.pos++;
      if (negated) {
        const inTok = this.tokens[this.pos++];
        if (inTok?.t !== "word" || inTok.v !== "in") {
          throw new WhenParseError('Expected "in"', this.src, next.at);
        }
      }
      const container = this.tokens[this.pos++];
      if (container?.t !== "word")
        throw new WhenParseError("Expected a context key", this.src, next.at);
      return { kind: "in", key, container: container.v, negated };
    }
    if (next?.t === "op" && ["==", "!=", "=~", "<", "<=", ">", ">="].includes(next.v)) {
      this.pos++;
      const valueTok = this.tokens[this.pos++];
      if (!valueTok) throw new WhenParseError("Expected a value", this.src, next.at);
      if (next.v === "=~") {
        if (valueTok.t !== "regex")
          throw new WhenParseError("Expected /regex/", this.src, valueTok.at);
        return { kind: "regex", key, regex: valueTok.v };
      }
      if (valueTok.t === "regex" || valueTok.t === "op") {
        throw new WhenParseError("Expected a value", this.src, valueTok.at);
      }
      return { kind: "cmp", key, op: next.v as "==", value: literal(valueTok) };
    }
    return { kind: "key", key };
  }
}

function literal(tok: { t: "word" | "str"; v: string }): string | number | boolean {
  if (tok.t === "str") return tok.v;
  if (tok.v === "true") return true;
  if (tok.v === "false") return false;
  const n = Number(tok.v);
  return tok.v !== "" && Number.isFinite(n) ? n : tok.v;
}

const cache = new Map<string, WhenExpr>();

/** Parses a when clause (cached). Throws WhenParseError on syntax errors. */
export function parseWhen(source: string): WhenExpr {
  let expr = cache.get(source);
  if (!expr) {
    const trimmed = source.trim();
    expr =
      trimmed === ""
        ? { kind: "const", value: true }
        : new Parser(tokenize(trimmed), trimmed).parse();
    cache.set(source, expr);
  }
  return expr;
}

export function evaluateWhen(expr: WhenExpr, lookup: ContextLookup): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "key":
      return Boolean(lookup(expr.key));
    case "not":
      return !evaluateWhen(expr.expr, lookup);
    case "and":
      return expr.exprs.every((e) => evaluateWhen(e, lookup));
    case "or":
      return expr.exprs.some((e) => evaluateWhen(e, lookup));
    case "regex": {
      const value = lookup(expr.key);
      expr.regex.lastIndex = 0;
      return typeof value === "string" && expr.regex.test(value);
    }
    case "in": {
      const container = lookup(expr.container);
      const key = lookup(expr.key);
      let found = false;
      if (Array.isArray(container)) found = container.includes(key);
      else if (container && typeof container === "object" && typeof key === "string") {
        found = Object.hasOwn(container, key);
      }
      return expr.negated ? !found : found;
    }
    case "cmp": {
      const left = lookup(expr.key);
      switch (expr.op) {
        case "==":
          return String(left) === String(expr.value);
        case "!=":
          return String(left) !== String(expr.value);
        default: {
          const a = Number(left);
          const b = Number(expr.value);
          if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
          if (expr.op === "<") return a < b;
          if (expr.op === "<=") return a <= b;
          if (expr.op === ">") return a > b;
          return a >= b;
        }
      }
    }
  }
}

/** Convenience: parse + evaluate. An undefined/empty clause is true. */
export function matchesWhen(source: string | undefined, lookup: ContextLookup): boolean {
  return source === undefined ? true : evaluateWhen(parseWhen(source), lookup);
}
