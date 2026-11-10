// Inline widgets (D334), like Claude Code's show_widget: the agent draws an SVG picture or a small
// HTML page (a chart, a diagram, a calculator, a form) in the chat. The code is the model's: it
// runs in a sandboxed frame on a local origin of its own with no network, gets the IDE's theme as
// CSS variables, and can only post its size, a clicked link and sendPrompt(text). This module is
// the DOM-free part: reading the call, the mode, the frame's size messages, the sendPrompt rate
// limit, the file a widget saves as, and the design guide the model reads. Tested.

export const WIDGET_TOOL = "show_widget";
export const WIDGET_GUIDE_TOOL = "widget_guide";

export type WidgetMode = "svg" | "html";

export interface Widget {
  /** snake_case id; also the file name it saves as. */
  title: string;
  code: string;
  mode: WidgetMode;
  /** Shown while it renders (1–4 short lines). */
  loading: string[];
}

/** The most code a widget may have (a page this size is already more than a chat card). */
export const MAX_WIDGET_CHARS = 200_000;
const MAX_LOADING = 4;
const LOADING_CHARS = 80;
const TITLE_CHARS = 60;

/**
 * SVG when the code starts with `<svg` (after blank space, an XML declaration, a doctype or
 * comments), else HTML: Claude Code's rule.
 */
export function widgetMode(code: string): WidgetMode {
  const start = code.replace(
    /^(?:\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype svg[^>]*>)*/i,
    "",
  );
  return /^<svg[\s>]/i.test(start) ? "svg" : "html";
}

/** A title as a snake_case id: lower case, letters, digits and underscores ("widget" if none). */
export function widgetId(title: string): string {
  const id = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TITLE_CHARS)
    .replace(/_+$/, "");
  return id || "widget";
}

/** The id as people read it: "sales_by_month" → "Sales by month". */
export function widgetLabel(title: string): string {
  const words = widgetId(title).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The call's widget, or why it can't be drawn. */
export function parseWidget(args: unknown): Widget | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  // A model that wrapped the code in a Markdown fence.
  const code = (typeof a.widget_code === "string" ? a.widget_code.trim() : "")
    .replace(/^```[\w-]*\n([\s\S]*?)\n?```$/, "$1")
    .trim();
  if (!code) return { error: "widget_code is empty: give the SVG or HTML to draw" };
  if (code.length > MAX_WIDGET_CHARS)
    return {
      error: `widget_code is ${code.length} characters; at most ${MAX_WIDGET_CHARS}: draw less, or write a file instead`,
    };
  const loading = (Array.isArray(a.loading_messages) ? a.loading_messages : [])
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.replace(/\s+/g, " ").trim().slice(0, LOADING_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LOADING);
  const content = widgetContent(code);
  return {
    title: widgetId(typeof a.title === "string" ? a.title : ""),
    code: content,
    mode: widgetMode(content),
    loading,
  };
}

/**
 * A whole page sent anyway (a DOCTYPE, <html>, <head>, <body>): its head's tags (styles,
 * scripts) and its body's content, which is what the frame draws. Anything else as it is.
 */
export function widgetContent(code: string): string {
  if (
    !/^\s*(?:<!doctype html[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html[\s>]|^\s*<!doctype html/i.test(
      code,
    )
  )
    return code;
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(code)?.[1] ?? "";
  const body = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(code)?.[1];
  const rest =
    body ??
    code
      .replace(/^\s*<!doctype[^>]*>/i, "")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/i, "")
      .replace(/<\/?html[^>]*>/gi, "");
  // <meta>, <title> and <link> do nothing in a frame without network.
  const keep = head.replace(/<(?:meta|title|link|base)\b[^>]*>(?:[^<]*<\/title>)?/gi, "").trim();
  return `${keep ? `${keep}\n` : ""}${rest.trim()}`;
}

/** The file a widget saves as: its id with .svg or .html. */
export function widgetFileName(w: Pick<Widget, "title" | "mode">): string {
  return `${widgetId(w.title)}.${w.mode}`;
}

/** The smallest and the tallest a widget's frame is in the chat (taller ones scroll inside). */
export const MIN_WIDGET_HEIGHT = 24;
export const MAX_WIDGET_HEIGHT = 900;

/**
 * The frame's height from its size message: a finite number of pixels, clamped to
 * [MIN_WIDGET_HEIGHT, max]; null when the message isn't one.
 */
export function widgetHeight(raw: unknown, max = MAX_WIDGET_HEIGHT): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.min(Math.max(Math.ceil(raw), MIN_WIDGET_HEIGHT), max);
}

/** What a widget's sendPrompt may send: text, at most this long. */
export const MAX_PROMPT_CHARS = 4000;

/** sendPrompt's text, trimmed; null when it isn't text or is empty. */
export function promptText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text ? text.slice(0, MAX_PROMPT_CHARS) : null;
}

/**
 * sendPrompt's rate limit: a widget is model-written code, so it can't flood the chat. At most
 * one message per `gapMs`, and `perMinute` in any minute.
 */
export class PromptLimiter {
  private sent: number[] = [];

  constructor(
    private readonly gapMs = 1500,
    private readonly perMinute = 6,
  ) {}

  /** Whether a message may go now; counts it when it may. */
  allow(now: number): boolean {
    this.sent = this.sent.filter((t) => now - t < 60_000);
    const last = this.sent[this.sent.length - 1];
    if (last !== undefined && now - last < this.gapMs) return false;
    if (this.sent.length >= this.perMinute) return false;
    this.sent.push(now);
    return true;
  }
}

/** The CSS a saved page gets: the theme's values now on :root, and the frame's base look. */
function rootCss(vars: Readonly<Record<string, string>>, scheme: "dark" | "light"): string {
  const decls = Object.entries(vars)
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[<>{};]/.test(v))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root {\n  color-scheme: ${scheme};\n${decls}\n}\nbody { margin: 0; padding: 8px; background: var(--bg-surface); color: var(--fg-default); font-family: var(--font-ui, system-ui, sans-serif); font-size: var(--text-md, 13px); }`;
}

/**
 * A widget as a file to keep: an SVG as it is (with its namespace, so it opens on its own); an
 * HTML widget as a whole page with the theme's colors as they are now, and a sendPrompt that
 * only logs (there is no chat to send to).
 */
export function widgetDocument(
  w: Pick<Widget, "title" | "code" | "mode">,
  vars: Readonly<Record<string, string>> = {},
  scheme: "dark" | "light" = "dark",
): string {
  if (w.mode === "svg") {
    const code = w.code;
    return /<svg\b[^>]*\bxmlns=/i.test(code)
      ? `${code}\n`
      : `${code.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')}\n`;
  }
  const title = widgetLabel(w.title).replace(/[<&]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
${rootCss(vars, scheme)}
</style>
<script>
  window.sendPrompt = (text) => console.log("sendPrompt:", text);
</script>
</head>
<body>
${w.code}
</body>
</html>
`;
}

/** The theme variables a widget gets (what the guide lists). */
export const WIDGET_VARIABLES = {
  surfaces: ["--bg-surface", "--bg-surface-raised", "--bg-surface-sunken", "--bg-hover"],
  controls: ["--bg-input", "--bg-chip", "--bg-selected"],
  text: ["--fg-default", "--fg-muted", "--fg-subtle", "--accent-text"],
  accent: ["--accent", "--accent-hover", "--fg-on-accent"],
  borders: ["--border-subtle", "--border-default", "--border-strong"],
  status: ["--status-success-fg", "--status-warning-fg", "--status-danger-fg"],
  series: ["--label-1", "--label-2", "--label-3", "--label-4", "--label-5", "--label-6"],
  type: ["--font-ui", "--font-mono", "--text-xs", "--text-sm", "--text-md", "--text-lg"],
  shape: ["--radius-sm", "--radius-md", "--space-2", "--space-4", "--space-6"],
} as const;

/** widget_guide's text: the design rules, read once before the first widget. */
export function widgetGuide(): string {
  const vars = Object.entries(WIDGET_VARIABLES)
    .map(([group, names]) => `- ${group}: ${names.join(", ")}`)
    .join("\n");
  return `How widgets look and work in the IDE's chat:

Where it draws
- A card in the chat, as wide as the chat column (often 360–700px): design for 320px and up; no fixed widths over 320px, use %, flex or grid.
- The frame grows to the content's height (up to 900px, then it scrolls). Don't set a height on html/body.
- The background is transparent: the chat's own color shows through. Use cards (--bg-surface-raised with a 1px --border-subtle border) only to group things.
- The user can open it full size in a tab, copy its code or save it as a file.

Theme: use these CSS variables (the IDE's current theme, light or dark, updated when it changes); never hard-code colors.
${vars}

Typography: inherit the font (--font-ui, 13px). Sentence case for labels and titles. At most 3 sizes. Headings 600 weight, small.

Style
- Quiet: hairline borders, no gradients, shadows or glow; color only where it means something.
- Buttons, inputs, selects, tables and links already look native: plain elements are fine.
- Charts: series in --label-1…6; axes and grid lines --border-subtle; text --fg-muted; label the axes; a legend when there's more than one series.
- SVG: give a viewBox and no fixed width (it scales to the column); fill and stroke with var(--…) (style="fill: var(--label-1)").

Code
- No DOCTYPE, <html>, <head> or <body>: just the content (<style> and <script> tags are fine).
- No network: fetch, remote images, fonts and scripts are blocked. Put the data in the code; inline images as data: URLs.
- It's drawn while you write it: put <style> first, then the structure (it appears as it arrives), scripts last. Scripts run once the call is complete; keep state in variables (no storage).
- sendPrompt(text) sends text to the chat as the user's message (only from a click or key press, at most one every 1.5s): for choices, follow-ups, "explain this".
- No nested frames, popups or forms that submit; links open in the user's browser.`;
}
