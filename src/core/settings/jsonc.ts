// JSONC parser for user-edited files (settings.json, keybindings.json): JSON plus // and /* */
// comments and trailing commas. Errors carry line/column. No dependencies; DOM-free.

export interface JsoncError {
  message: string;
  offset: number;
  line: number; // 1-based
  column: number; // 1-based
}

export type JsoncResult = { ok: true; value: unknown } | { ok: false; error: JsoncError };

class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Parses JSONC text. Duplicate keys: last one wins (like JSON.parse). */
export function parseJsonc(text: string): JsoncResult {
  try {
    const parser = new JsoncParser(text);
    const value = parser.parseDocument();
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ParseError) {
      const { line, column } = position(text, err.offset);
      return { ok: false, error: { message: err.message, offset: err.offset, line, column } };
    }
    throw err;
  }
}

/** Like parseJsonc but throws a readable Error. */
export function parseJsoncOrThrow(text: string, fileLabel = "JSONC"): unknown {
  const result = parseJsonc(text);
  if (result.ok) return result.value;
  const { message, line, column } = result.error;
  throw new Error(`${fileLabel}:${line}:${column}: ${message}`);
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

class JsoncParser {
  private i = 0;
  constructor(private readonly text: string) {
    if (text.charCodeAt(0) === 0xfeff) this.i = 1; // BOM
  }

  parseDocument(): unknown {
    this.skip();
    if (this.i >= this.text.length) throw new ParseError("Empty document", this.i);
    const value = this.value();
    this.skip();
    if (this.i < this.text.length) throw new ParseError("Unexpected content after value", this.i);
    return value;
  }

  /** Skips whitespace and comments. */
  private skip(): void {
    const t = this.text;
    while (this.i < t.length) {
      const c = t.charAt(this.i);
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
      } else if (c === "/" && t.charAt(this.i + 1) === "/") {
        while (this.i < t.length && t.charAt(this.i) !== "\n") this.i++;
      } else if (c === "/" && t.charAt(this.i + 1) === "*") {
        const end = t.indexOf("*/", this.i + 2);
        if (end < 0) throw new ParseError("Unterminated comment", this.i);
        this.i = end + 2;
      } else {
        return;
      }
    }
  }

  private value(): unknown {
    const c = this.text.charAt(this.i);
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(word, this.i)) {
        this.i += word.length;
        return value;
      }
    }
    throw new ParseError(c ? `Unexpected character "${c}"` : "Unexpected end of input", this.i);
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++; // {
    this.skip();
    while (this.text.charAt(this.i) !== "}") {
      if (this.text.charAt(this.i) !== '"') throw new ParseError("Expected property name", this.i);
      const key = this.string();
      this.skip();
      if (this.text.charAt(this.i) !== ":") throw new ParseError('Expected ":"', this.i);
      this.i++;
      this.skip();
      // defineProperty so a "__proto__" key is stored as data, not a prototype change.
      Object.defineProperty(out, key, {
        value: this.value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skip();
      const c = this.text.charAt(this.i);
      if (c === ",") {
        this.i++;
        this.skip(); // trailing comma allowed: loop condition sees "}"
      } else if (c !== "}") {
        throw new ParseError('Expected "," or "}"', this.i);
      }
    }
    this.i++; // }
    return out;
  }

  private array(): unknown[] {
    const out: unknown[] = [];
    this.i++; // [
    this.skip();
    while (this.text.charAt(this.i) !== "]") {
      out.push(this.value());
      this.skip();
      const c = this.text.charAt(this.i);
      if (c === ",") {
        this.i++;
        this.skip();
      } else if (c !== "]") {
        throw new ParseError('Expected "," or "]"', this.i);
      }
    }
    this.i++; // ]
    return out;
  }

  private string(): string {
    const start = this.i;
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.text.length) throw new ParseError("Unterminated string", start);
      const c = this.text.charAt(this.i);
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\n") throw new ParseError("Newline in string", this.i);
      if (c === "\\") {
        const e = this.text.charAt(this.i + 1);
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e in simple) {
          out += simple[e];
          this.i += 2;
        } else if (e === "u") {
          const hex = this.text.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError("Invalid unicode escape", this.i);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.i += 6;
        } else {
          throw new ParseError("Invalid escape", this.i);
        }
      } else {
        out += c;
        this.i++;
      }
    }
  }

  private number(): number {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.i));
    if (!match) throw new ParseError("Invalid number", this.i);
    this.i += match[0].length;
    return Number(match[0]);
  }
}
