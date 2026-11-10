// An extension's `language-configuration.json` (VS Code's format, D200) → the editor's language
// configuration: comment tokens (Ctrl+/), brackets (matching, colors), auto-closing and
// surrounding pairs, folding markers, the word pattern and indentation rules. Patterns in the file
// are strings (or { pattern, flags }); a bad one is left out rather than failing the whole file.
// DOM-free, tested.

type Pair = [string, string];

export interface AutoClosingPair {
  open: string;
  close: string;
  notIn?: string[];
}

/** The shape Monaco's setLanguageConfiguration takes (only what we fill). */
export interface EditorLanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: Pair };
  brackets?: Pair[];
  autoClosingPairs?: AutoClosingPair[];
  surroundingPairs?: { open: string; close: string }[];
  folding?: { markers?: { start: RegExp; end: RegExp }; offSide?: boolean };
  wordPattern?: RegExp;
  indentationRules?: {
    increaseIndentPattern: RegExp;
    decreaseIndentPattern: RegExp;
    indentNextLinePattern?: RegExp;
    unIndentedLinePattern?: RegExp;
  };
  /** What Enter does after / before some text (D258; Monaco's IndentAction: 0 none … 3 outdent). */
  onEnterRules?: {
    beforeText: RegExp;
    afterText?: RegExp;
    previousLineText?: RegExp;
    action: { indentAction: number; appendText?: string; removeText?: number };
  }[];
}

const INDENT_ACTIONS: Record<string, number> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

const isPair = (v: unknown): v is Pair =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string";

/** A pattern as a RegExp: "…" or { pattern, flags }; undefined when missing or invalid. */
export function toRegExp(v: unknown): RegExp | undefined {
  const source = typeof v === "string" ? v : (v as { pattern?: unknown } | null)?.pattern;
  if (typeof source !== "string") return undefined;
  const flags = typeof v === "object" && v ? (v as { flags?: unknown }).flags : undefined;
  try {
    // Only the flags a JS RegExp accepts; VS Code's files use i, m, s, u mostly.
    return new RegExp(source, typeof flags === "string" ? flags.replace(/[^dgimsuy]/g, "") : "");
  } catch {
    return undefined;
  }
}

function pairs(v: unknown): { open: string; close: string; notIn?: string[] }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    if (isPair(p)) return [{ open: p[0], close: p[1] }];
    const o = p as { open?: unknown; close?: unknown; notIn?: unknown } | null;
    if (!o || typeof o.open !== "string" || typeof o.close !== "string") return [];
    const notIn = Array.isArray(o.notIn)
      ? o.notIn.filter((x): x is string => typeof x === "string")
      : typeof o.notIn === "string"
        ? [o.notIn]
        : undefined;
    return [{ open: o.open, close: o.close, ...(notIn?.length && { notIn }) }];
  });
}

export function toLanguageConfiguration(raw: unknown): EditorLanguageConfiguration {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EditorLanguageConfiguration = {};
  const comments = c.comments as { lineComment?: unknown; blockComment?: unknown } | undefined;
  if (comments && typeof comments === "object") {
    const line = typeof comments.lineComment === "string" ? comments.lineComment : undefined;
    const block = isPair(comments.blockComment) ? comments.blockComment : undefined;
    if (line || block)
      out.comments = { ...(line && { lineComment: line }), ...(block && { blockComment: block }) };
  }
  if (Array.isArray(c.brackets)) out.brackets = c.brackets.filter(isPair);
  const closing = pairs(c.autoClosingPairs);
  if (closing.length) out.autoClosingPairs = closing;
  const surrounding = pairs(c.surroundingPairs).map(({ open, close }) => ({ open, close }));
  if (surrounding.length) out.surroundingPairs = surrounding;
  const folding = c.folding as { markers?: { start?: unknown; end?: unknown }; offSide?: unknown };
  if (folding && typeof folding === "object") {
    const start = toRegExp(folding.markers?.start);
    const end = toRegExp(folding.markers?.end);
    out.folding = {
      ...(start && end && { markers: { start, end } }),
      ...(typeof folding.offSide === "boolean" && { offSide: folding.offSide }),
    };
  }
  const word = toRegExp(c.wordPattern);
  // Monaco needs a global word pattern.
  if (word) out.wordPattern = word.global ? word : new RegExp(word.source, `${word.flags}g`);
  const indent = c.indentationRules as Record<string, unknown> | undefined;
  if (indent && typeof indent === "object") {
    const increase = toRegExp(indent.increaseIndentPattern);
    const decrease = toRegExp(indent.decreaseIndentPattern);
    if (increase && decrease) {
      const next = toRegExp(indent.indentNextLinePattern);
      const un = toRegExp(indent.unIndentedLinePattern);
      out.indentationRules = {
        increaseIndentPattern: increase,
        decreaseIndentPattern: decrease,
        ...(next && { indentNextLinePattern: next }),
        ...(un && { unIndentedLinePattern: un }),
      };
    }
  }
  if (Array.isArray(c.onEnterRules)) {
    const rules = c.onEnterRules.flatMap(
      (raw): NonNullable<EditorLanguageConfiguration["onEnterRules"]> => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const before = toRegExp(r.beforeText);
        const a = (r.action && typeof r.action === "object" ? r.action : {}) as Record<
          string,
          unknown
        >;
        const indent =
          typeof a.indent === "string"
            ? INDENT_ACTIONS[a.indent]
            : typeof a.indentAction === "number"
              ? a.indentAction
              : undefined;
        if (!before || indent === undefined || indent < 0 || indent > 3) return [];
        const after = toRegExp(r.afterText);
        const previous = toRegExp(r.previousLineText);
        return [
          {
            beforeText: before,
            ...(after && { afterText: after }),
            ...(previous && { previousLineText: previous }),
            action: {
              indentAction: indent,
              ...(typeof a.appendText === "string" && { appendText: a.appendText }),
              ...(typeof a.removeText === "number" && { removeText: a.removeText }),
            },
          },
        ];
      },
    );
    if (rules.length) out.onEnterRules = rules.slice(0, 100);
  }
  return out;
}
