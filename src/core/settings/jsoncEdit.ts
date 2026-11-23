// Minimal JSONC editing for settings.json: set or remove one top-level property (or one property
// of a top-level object, such as a language block `"[python]": {…}`) while keeping the user's
// comments, ordering and formatting everywhere else (like VS Code's settings writer). DOM-free and
// unit-tested.
import { parseJsonc } from "./jsonc";

interface Token {
  kind: "string" | "punct" | "literal";
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text.charAt(i + 1) === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text.charAt(i + 1) === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      tokens.push({ kind: "string", text: text.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
    } else if ("{}[],:".includes(c)) {
      tokens.push({ kind: "punct", text: c, start: i, end: i + 1 });
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s{}[\],:/"]/.test(text.charAt(j))) j++;
      tokens.push({
        kind: "literal",
        text: text.slice(i, Math.max(j, i + 1)),
        start: i,
        end: Math.max(j, i + 1),
      });
      i = Math.max(j, i + 1);
    }
  }
  return tokens;
}

interface Property {
  key: string;
  keyStart: number;
  valueStart: number;
  /** Index of the value's first token. */
  valueToken: number;
  valueEnd: number;
  /** Offset just after the comma that follows the value, or -1. */
  commaEnd: number;
}

interface ObjectTokens {
  open: Token;
  close: Token;
  props: Property[];
}

function topLevel(tokens: Token[]): ObjectTokens | null {
  return objectAt(
    tokens,
    tokens.findIndex((t) => t.text === "{" && t.kind === "punct"),
  );
}

/** The object whose `{` is token `openIndex`: its braces and properties. */
function objectAt(tokens: Token[], openIndex: number): ObjectTokens | null {
  if (openIndex < 0) return null;
  const open = tokens[openIndex] as Token;
  const props: Property[] = [];
  let depth = 0;
  let i = openIndex + 1;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && t.text === "}" && depth === 0) return { open, close: t, props };
    if (t.kind === "string" && depth === 0 && tokens[i + 1]?.text === ":") {
      let key: string;
      try {
        key = JSON.parse(t.text) as string;
      } catch {
        key = t.text.slice(1, -1);
      }
      const valueStartTok = tokens[i + 2];
      if (!valueStartTok) return null;
      let j = i + 2;
      let d = 0;
      let last = valueStartTok;
      for (; j < tokens.length; j++) {
        const v = tokens[j] as Token;
        if (v.kind === "punct" && (v.text === "{" || v.text === "[")) d++;
        else if (v.kind === "punct" && (v.text === "}" || v.text === "]")) {
          if (d === 0) break;
          d--;
        } else if (v.kind === "punct" && v.text === "," && d === 0) break;
        last = v;
      }
      const after = tokens[j];
      props.push({
        key,
        keyStart: t.start,
        valueStart: valueStartTok.start,
        valueToken: i + 2,
        valueEnd: last.end,
        commaEnd: after?.text === "," ? after.end : -1,
      });
      i = after?.text === "," ? j + 1 : j;
      continue;
    }
    if (t.kind === "punct" && (t.text === "{" || t.text === "[")) depth++;
    if (t.kind === "punct" && (t.text === "}" || t.text === "]")) depth--;
    i++;
  }
  return null;
}

function stringify(value: unknown, indent: string, eol = "\n"): string {
  return JSON.stringify(value, null, 2).replaceAll("\n", `${eol}${indent}`);
}

/** The document's line ending: what it uses already, so an edit doesn't leave a mixed file. */
function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The offset after the line break at `offset` (`\n` or `\r\n`), or `offset` when none is there. */
function afterLineBreak(text: string, offset: number): number {
  if (text.charAt(offset) === "\n") return offset + 1;
  if (text.charAt(offset) === "\r" && text.charAt(offset + 1) === "\n") return offset + 2;
  return offset;
}

/** Start of the line containing `offset` if only whitespace precedes it there, else `offset`. */
function lineStartIfBlank(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && (text.charAt(i - 1) === " " || text.charAt(i - 1) === "\t")) i--;
  return i === 0 || text.charAt(i - 1) === "\n" ? i : offset;
}

/** Thrown when a document has content but no readable top-level object to edit. */
export class JsoncEditError extends Error {}

/**
 * Throws `JsoncEditError` (naming `fileLabel` and the line) unless `text` is empty or a valid
 * JSONC object: the check every settings write makes first, so an edit never rewrites a file the
 * user is in the middle of fixing.
 */
export function assertEditableJsoncObject(text: string, fileLabel: string): void {
  // Empty or only comments: the edit makes a fresh object.
  if (!tokenize(text).length) return;
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    throw new JsoncEditError(
      `${fileLabel} has a syntax error (line ${parsed.error.line}); fix it first so nothing in it is lost.`,
    );
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new JsoncEditError(`${fileLabel} must contain an object ({ … }); fix it first.`);
}

/**
 * Returns `text` with top-level `key` set to `value`, or removed when `value` is undefined.
 * Empty text (or only comments) gets a fresh object containing only `key`. Text with content but
 * no readable top-level object throws `JsoncEditError` instead of being replaced: a toggle must
 * never wipe a file that has a syntax error.
 */
export function setJsoncProperty(text: string, key: string, value: unknown): string {
  const indent = "  ";
  const tokens = tokenize(text);
  const doc = topLevel(tokens);
  if (!doc) {
    if (tokens.length) throw new JsoncEditError("The file has a syntax error; fix it first.");
    if (value === undefined) return text;
    const eol = lineEnding(text);
    // A comment-only file keeps its comments above the new object.
    const kept = text.trim() ? `${text.trimEnd()}${eol}` : "";
    return `${kept}{${eol}${indent}${JSON.stringify(key)}: ${stringify(value, indent, eol)}${eol}}${eol}`;
  }
  return setInObject(text, doc, key, value, indent, "");
}

/**
 * Returns `text` with `inner` of the top-level object `outer` set to `value` (a language block's
 * setting: outer `[python]`, inner `editor.tabSize`), or removed when `value` is undefined. The
 * block is created when missing and removed when it becomes empty; comments elsewhere (inside the
 * block too) are kept.
 */
export function setJsoncNestedProperty(
  text: string,
  outer: string,
  inner: string,
  value: unknown,
): string {
  const tokens = tokenize(text);
  const doc = topLevel(tokens);
  const existing = doc ? [...doc.props].reverse().find((p) => p.key === outer) : undefined;
  const block =
    existing && tokens[existing.valueToken]?.text === "{"
      ? objectAt(tokens, existing.valueToken)
      : null;
  if (!block) {
    // No block yet (or not an object): write it whole.
    return value === undefined ? text : setJsoncProperty(text, outer, { [inner]: value });
  }
  if (value === undefined) {
    const remaining = block.props.filter((p) => p.key !== inner);
    if (remaining.length === block.props.length) return text;
    if (!remaining.length) return setJsoncProperty(text, outer, undefined);
  }
  return setInObject(text, block, inner, value, "    ", "  ");
}

/** Sets or removes `key` among an object's properties (`indent`: its properties' indentation). */
function setInObject(
  text: string,
  doc: ObjectTokens,
  key: string,
  value: unknown,
  indent: string,
  closeIndent: string,
): string {
  const eol = lineEnding(text);
  const existing = [...doc.props].reverse().find((p) => p.key === key);
  if (existing) {
    if (value !== undefined) {
      return (
        text.slice(0, existing.valueStart) +
        stringify(value, indent, eol) +
        text.slice(existing.valueEnd)
      );
    }
    const index = doc.props.indexOf(existing);
    const prev = doc.props[index - 1];
    // Only the property's own span goes (its line, when it had one to itself), and separately
    // the one comma character: comments around it are the user's and stay.
    const start = lineStartIfBlank(text, existing.keyStart);
    let end = existing.commaEnd >= 0 ? existing.commaEnd : existing.valueEnd;
    if (start !== existing.keyStart) end = afterLineBreak(text, end);
    const removed = text.slice(0, start) + text.slice(end);
    if (existing.commaEnd >= 0 || !prev || prev.commaEnd < 0) return removed;
    // The last property: the comma before it goes too (a comment after that comma stays).
    return removed.slice(0, prev.commaEnd - 1) + removed.slice(prev.commaEnd);
  }
  if (value === undefined) return text;
  const entry = `${JSON.stringify(key)}: ${stringify(value, indent, eol)}`;
  const last = doc.props[doc.props.length - 1];
  if (!last) {
    const inner = text.slice(doc.open.end, doc.close.start);
    const body = inner.trim()
      ? `${inner.replace(/\s+$/, "")}${eol}${indent}${entry}${eol}${closeIndent}`
      : `${eol}${indent}${entry}${eol}${closeIndent}`;
    return text.slice(0, doc.open.end) + body + text.slice(doc.close.start);
  }
  if (last.commaEnd >= 0) {
    // Trailing comma already there (JSONC allows it): insert after it.
    return `${text.slice(0, last.commaEnd)}${eol}${indent}${entry},${text.slice(last.commaEnd)}`;
  }
  return `${text.slice(0, last.valueEnd)},${eol}${indent}${entry}${text.slice(last.valueEnd)}`;
}

/**
 * Throws `JsoncEditError` (naming `fileLabel` and the line) unless `text` is empty (or only
 * comments) or a valid JSONC array: the check a keybindings.json write makes first, as
 * `assertEditableJsoncObject` is for settings.
 */
export function assertEditableJsoncArray(text: string, fileLabel: string): void {
  if (!tokenize(text).length) return;
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    throw new JsoncEditError(
      `${fileLabel} has a syntax error (line ${parsed.error.line}); fix it first so nothing in it is lost.`,
    );
  if (!Array.isArray(parsed.value))
    throw new JsoncEditError(`${fileLabel} must contain an array ([ … ]); fix it first.`);
}

/**
 * Appends `value` to the top-level array in `text` (keybindings.json), keeping comments. Empty
 * text (or only comments) becomes a new array. Text with content but no closed top-level array
 * (the `]` not typed yet, an object, anything else) throws `JsoncEditError` instead of being
 * replaced: adding one entry must never drop the ones a file being edited already holds.
 */
export function appendJsoncArrayItem(text: string, value: unknown): string {
  const indent = "  ";
  const eol = lineEnding(text);
  const entry = `${indent}${stringify(value, indent, eol)}`;
  const tokens = tokenize(text);
  if (!tokens.length) {
    // A comment-only file keeps its comments above the new array.
    const kept = text.trim() ? `${text.trimEnd()}${eol}` : "";
    return `${kept}[${eol}${entry}${eol}]${eol}`;
  }
  const first = tokens[0] as Token;
  if (first.kind !== "punct" || first.text !== "[")
    throw new JsoncEditError("The file must contain an array ([ … ]); fix it first.");
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== "punct") continue;
    if (t.text === "[" || t.text === "{") depth++;
    else if (t.text === "}") depth--;
    else if (t.text === "]") {
      if (depth > 0) {
        depth--;
        continue;
      }
      // Something after the array's end: not a file this can add to safely.
      if (i !== tokens.length - 1) break;
      const prev = tokens[i - 1] as Token;
      const needsComma = !(prev.kind === "punct" && (prev.text === "[" || prev.text === ","));
      // Keep whatever sits between the last item and "]" (e.g. a trailing comment).
      const between = text.slice(prev.end, t.start).replace(/\s+$/, "");
      return `${text.slice(0, prev.end)}${needsComma ? "," : ""}${between}${eol}${entry}${eol}${text.slice(t.start)}`;
    }
  }
  throw new JsoncEditError(
    "The file's array isn't closed (a syntax error); fix it first so nothing in it is lost.",
  );
}

interface ArrayItem {
  start: number;
  end: number;
  /** Offset just after the comma that follows the item, or -1. */
  commaEnd: number;
}

/** The items of the top-level array (their spans), or null without one. */
function topLevelArrayItems(tokens: Token[]): ArrayItem[] | null {
  const open = tokens.findIndex((t) => t.kind === "punct" && t.text === "[");
  if (open < 0) return null;
  const items: ArrayItem[] = [];
  let depth = 0;
  let start: Token | null = null;
  let last: Token | null = null;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (depth === 0 && t.kind === "punct" && (t.text === "," || t.text === "]")) {
      if (start && last) items.push({ start: start.start, end: last.end, commaEnd: -1 });
      if (t.text === "]") return items;
      const item = items[items.length - 1];
      if (item && start) item.commaEnd = t.end;
      start = null;
      last = null;
      continue;
    }
    if (t.kind === "punct" && (t.text === "[" || t.text === "{")) depth++;
    else if (t.kind === "punct" && (t.text === "]" || t.text === "}")) depth--;
    start ??= t;
    last = t;
  }
  return null;
}

/**
 * Replaces item `index` of the top-level array (keybindings.json) with `value`, or removes it
 * when `value` is undefined, keeping comments and formatting elsewhere (D204). Throws when there
 * is no such item.
 */
export function setJsoncArrayItem(text: string, index: number, value: unknown): string {
  const items = topLevelArrayItems(tokenize(text));
  const item = items?.[index];
  if (!items || !item) throw new JsoncEditError(`No entry ${index + 1} to change.`);
  if (value !== undefined)
    return (
      text.slice(0, item.start) + stringify(value, "  ", lineEnding(text)) + text.slice(item.end)
    );
  const prev = items[index - 1];
  const start = lineStartIfBlank(text, item.start);
  let end = item.commaEnd >= 0 ? item.commaEnd : item.end;
  if (start !== item.start) end = afterLineBreak(text, end);
  const removed = text.slice(0, start) + text.slice(end);
  if (item.commaEnd >= 0 || !prev || prev.commaEnd < 0) return removed;
  // The last item: the comma before it goes too (a comment after that comma stays).
  return removed.slice(0, prev.commaEnd - 1) + removed.slice(prev.commaEnd);
}
