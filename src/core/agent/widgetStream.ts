// A widget drawn while it's written (D355), like Claude Code's show_widget: the provider streams the
// call's arguments as partial JSON, and the chat paints the code that has arrived so far. This is
// the DOM-free part: reading the strings out of unfinished JSON, and cutting unfinished markup to
// what's safe to paint (no scripts until the call is complete, no half-written tag, comment or
// entity). The frame's parser closes the elements still open. Tested.

import { MAX_WIDGET_CHARS, type WidgetMode, widgetContent, widgetId, widgetMode } from "./widgets";

/** The top-level string and string-array values of a JSON object that may stop anywhere. */
export interface PartialArgs {
  strings: Record<string, string>;
  arrays: Record<string, string[]>;
}

/**
 * Reads a JSON object's top-level strings and arrays of strings from the start of its text: a
 * string cut off is returned as far as it got (an escape cut in half is left out); other values
 * are skipped.
 */
export function partialJsonArgs(json: string): PartialArgs {
  const out: PartialArgs = { strings: {}, arrays: {} };
  let i = 0;
  const n = json.length;
  const space = () => {
    while (i < n && /\s/.test(json[i] ?? "")) i++;
  };
  /** A string at `i` (on its quote): its text so far, and whether it closed. */
  const str = (): { text: string; closed: boolean } => {
    i++; // the opening quote
    let text = "";
    while (i < n) {
      const c = json[i] ?? "";
      if (c === '"') {
        i++;
        return { text, closed: true };
      }
      if (c !== "\\") {
        text += c;
        i++;
        continue;
      }
      const e = json[i + 1];
      if (e === undefined) break; // a backslash at the end: the escape isn't here yet
      if (e === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) break;
        text += String.fromCharCode(code);
        i += 6;
        continue;
      }
      const map: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
        '"': '"',
        "\\": "\\",
        "/": "/",
      };
      text += map[e] ?? e;
      i += 2;
    }
    i = n;
    return { text, closed: false };
  };
  /** Skips a value that isn't wanted (numbers, objects, literals), strings and nesting aware. */
  const skip = () => {
    let depth = 0;
    while (i < n) {
      const c = json[i];
      if (c === '"') {
        str();
        if (depth === 0) return;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) return;
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      } else if (c === "," && depth === 0) return;
      i++;
    }
  };
  space();
  if (json[i] !== "{") return out;
  i++;
  while (i < n) {
    space();
    if (json[i] === "}") break;
    if (json[i] === ",") {
      i++;
      continue;
    }
    if (json[i] !== '"') return out;
    const key = str();
    if (!key.closed) return out;
    space();
    if (json[i] !== ":") return out;
    i++;
    space();
    const c = json[i];
    if (c === '"') out.strings[key.text] = str().text;
    else if (c === "[") {
      i++;
      const items: string[] = [];
      for (;;) {
        space();
        const d = json[i];
        if (d === undefined || d === "]") {
          i++;
          break;
        }
        if (d === ",") {
          i++;
          continue;
        }
        if (d === '"') {
          const s = str();
          // A line still being written isn't shown half.
          if (s.closed) items.push(s.text);
        } else {
          const at = i;
          skip();
          // A `}` where an item should be (malformed): the array ends there, not loops forever.
          if (i === at) break;
        }
      }
      out.arrays[key.text] = items;
    } else skip();
  }
  return out;
}

/** Where an unclosed `<script` starts (case-insensitive), after the complete ones, or -1. */
function openScriptAt(code: string): number {
  const re = /<script\b/gi;
  let at = -1;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const close = code.toLowerCase().indexOf("</script", m.index);
    if (close < 0) {
      at = m.index;
      break;
    }
    re.lastIndex = close;
  }
  return at;
}

/**
 * Markup cut off mid-stream, made safe to paint: scripts left out (they run only once the call is
 * complete), and an unclosed script, comment, tag (a half-written attribute included) or entity
 * cut away. What's left is a prefix of the code the parser can draw as it is.
 */
export function drawableMarkup(code: string): string {
  let text = code;
  const script = openScriptAt(text);
  if (script >= 0) text = text.slice(0, script);
  text = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  const comment = text.lastIndexOf("<!--");
  if (comment >= 0 && text.indexOf("-->", comment + 4) < 0) text = text.slice(0, comment);
  // The last tag, if it isn't finished: a `>` inside its quoted attribute doesn't end it.
  const tags = [...text.matchAll(/<[a-zA-Z/!?]/g)];
  const last = tags[tags.length - 1];
  if (last?.index !== undefined) {
    let quote = "";
    let closed = false;
    for (let i = last.index + 1; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") {
        closed = true;
        break;
      }
    }
    if (!closed) text = text.slice(0, last.index);
  }
  // A lone `<` at the end (a tag's first character).
  text = text.replace(/<$/, "");
  // An entity cut in half (`&am`).
  text = text.replace(/&#?[a-zA-Z0-9]{0,31}$/, "");
  return text;
}

/** A widget so far: what's known of its title, the code to paint, its loading lines. */
export interface WidgetDraft {
  title: string;
  /** Safe to paint (`drawableMarkup`); "" before there's anything to draw. */
  code: string;
  mode: WidgetMode;
  loading: string[];
  /** How much of widget_code has arrived. */
  chars: number;
}

/** The least of a tag before a draft is worth painting (`<svg` alone draws nothing). */
const MIN_PAINT = 8;

/** The draft a show_widget call's partial arguments make. */
export function widgetDraft(json: string): WidgetDraft {
  const args = partialJsonArgs(json);
  const raw = (args.strings.widget_code ?? "").trimStart().replace(/^```[\w-]*\n/, "");
  const content = widgetContent(raw.slice(0, MAX_WIDGET_CHARS));
  const code = drawableMarkup(content).trim();
  return {
    title: args.strings.title !== undefined ? widgetId(args.strings.title) : "",
    code: code.length >= MIN_PAINT && /<[a-zA-Z]/.test(code) ? code : "",
    mode: widgetMode(content),
    loading: (args.arrays.loading_messages ?? [])
      .map((m) => m.replace(/\s+/g, " ").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 4),
    chars: raw.length,
  };
}
