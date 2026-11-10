// Fill-in-the-middle prompts for suggestions as you type (D204, toward Copilot / Cursor Tab): the
// code before the cursor and after it go to a model's FIM endpoint (Ollama's /api/generate with
// `suffix`, OpenAI-style /completions with `suffix`, Mistral's Codestral /fim/completions,
// DeepSeek's /beta/completions); other models get the chat prompt (prompts.ts). Both carry a few
// snippets of context (other open files, recent edits; context.ts) inside a token budget. The
// reply is shaped: one line in the middle of a line, several at the end of one. DOM-free, tested.

/** A piece of context from elsewhere: another open file's lines, a recent edit. */
export interface Snippet {
  path: string;
  text: string;
  /**
   * Why it's there: "open" (a similar part of an open file), "edit" (changed lately) or
   * "import" (declarations the file imports, D224).
   */
  kind: "open" | "edit" | "import";
  score: number;
}

export interface CompletionContext {
  /** The file as shown in the prompt (relative to the folder when inside it). */
  path: string;
  languageId: string;
  prefix: string;
  suffix: string;
  snippets: readonly Snippet[];
}

const LINE_COMMENTS: Record<string, string> = {
  python: "#",
  r: "#",
  julia: "#",
  shellscript: "#",
  bash: "#",
  powershell: "#",
  ruby: "#",
  perl: "#",
  yaml: "#",
  toml: "#",
  dockerfile: "#",
  makefile: "#",
  elixir: "#",
  coffeescript: "#",
  sql: "--",
  lua: "--",
  haskell: "--",
  ini: ";",
  clojure: ";",
  lisp: ";",
  scheme: ";",
  bat: "REM",
  vb: "'",
  latex: "%",
  erlang: "%",
  matlab: "%",
};

/** The language's line comment ("//" when it has no own one we know). */
export function lineComment(languageId: string): string {
  return LINE_COMMENTS[languageId] ?? "//";
}

/**
 * Characters per token when nothing better is known; the editor passes the ratio its estimate
 * (tokens.ts, per model family) finds for the code being completed (D224).
 */
export const CHARS_PER_TOKEN = 4;

/** How a snippet is introduced in a FIM prompt (comments the model reads as part of the file). */
const SNIPPET_HEADINGS: Record<Snippet["kind"], string> = {
  open: "Compare this snippet from",
  edit: "Recently edited in",
  import: "Imported from",
};

/** `text`'s last `max` characters, starting at a line boundary when one is near. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < max / 4 ? cut.slice(nl + 1) : cut;
}

/** `text`'s first `max` characters, ending at a line boundary when one is near. */
export function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return nl >= 0 && nl > (max * 3) / 4 ? cut.slice(0, nl + 1) : cut;
}

/** How the token budget is shared: what's around the cursor first, then the snippets. */
export function splitBudget(
  ctx: CompletionContext,
  budgetTokens: number,
  charsPerToken = CHARS_PER_TOKEN,
): { prefix: number; suffix: number; snippets: number } {
  const total = Math.floor(Math.max(256, budgetTokens) * charsPerToken);
  const suffix = Math.min(ctx.suffix.length, Math.floor(total * 0.2));
  const snippetsWanted = ctx.snippets.reduce((n, s) => n + s.text.length + s.path.length + 24, 0);
  const snippets = Math.min(snippetsWanted, Math.floor(total * 0.3));
  const prefix = total - suffix - snippets;
  return { prefix, suffix, snippets };
}

/** The snippets that fit `chars`, best first, each whole (a cut snippet misleads more). */
export function fitSnippets(snippets: readonly Snippet[], chars: number): Snippet[] {
  const out: Snippet[] = [];
  let used = 0;
  for (const s of [...snippets].sort((a, b) => b.score - a.score)) {
    const size = s.text.length + s.path.length + 24;
    if (used + size > chars) continue;
    out.push(s);
    used += size;
  }
  return out;
}

/**
 * The FIM request's prompt and suffix. Snippets go first as comments (Copilot's way: the model
 * reads them as part of the file, which FIM-trained models handle best), then the file's path,
 * then the code before the cursor.
 */
export function buildFimPrompt(
  ctx: CompletionContext,
  budgetTokens: number,
  charsPerToken = CHARS_PER_TOKEN,
): { prompt: string; suffix: string } {
  const budget = splitBudget(ctx, budgetTokens, charsPerToken);
  const c = lineComment(ctx.languageId);
  const comment = (text: string) =>
    text
      .split("\n")
      .map((l) => (l ? `${c} ${l}` : c))
      .join("\n");
  const header = fitSnippets(ctx.snippets, budget.snippets)
    .map((s) => comment(`${SNIPPET_HEADINGS[s.kind]} ${s.path}:\n${s.text.replace(/\n+$/, "")}`))
    .join("\n\n");
  const prefix = tail(ctx.prefix, Math.max(0, budget.prefix - ctx.path.length - 8));
  const prompt = `${header ? `${header}\n\n` : ""}${c} Path: ${ctx.path}\n${prefix}`;
  return { prompt, suffix: head(ctx.suffix, budget.suffix) };
}

/** The chat prompt (models without FIM), with the same context. */
export function buildChatPrompt(
  ctx: CompletionContext,
  budgetTokens: number,
  charsPerToken = CHARS_PER_TOKEN,
): string {
  const budget = splitBudget(ctx, budgetTokens, charsPerToken);
  const snippets = fitSnippets(ctx.snippets, budget.snippets);
  const parts: string[] = [];
  if (snippets.length) {
    parts.push("Context from other files (don't repeat it):");
    for (const s of snippets)
      parts.push(
        `--- ${s.path}${s.kind === "edit" ? " (edited recently)" : s.kind === "import" ? " (imported)" : ""}\n${s.text.replace(/\n+$/, "")}`,
      );
    parts.push("");
  }
  parts.push(
    `File: ${ctx.path} (${ctx.languageId})`,
    "",
    `${tail(ctx.prefix, budget.prefix)}<cursor>${head(ctx.suffix, budget.suffix)}`,
    "",
    "Reply with only the text to insert at <cursor>.",
  );
  return parts.join("\n");
}

/** The rest of the cursor's line has code (not just closing brackets): one line fits there. */
export function expectsSingleLine(suffix: string): boolean {
  const nl = suffix.indexOf("\n");
  const rest = nl < 0 ? suffix : suffix.slice(0, nl);
  return /[^\s)\]}>'"`;,:]/.test(rest);
}

/**
 * The reply shaped for ghost text: one line where `expectsSingleLine`, else at most `maxLines`;
 * lines that repeat what follows the cursor are cut (a FIM model running past its middle).
 */
export function shapeCompletion(text: string, suffix: string, maxLines: number): string | null {
  let out = text.replace(/\r\n/g, "\n");
  if (expectsSingleLine(suffix)) out = out.split("\n")[0] ?? "";
  else {
    const lines = out.split("\n");
    const following = suffix
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    const next = following[0];
    const keep: string[] = [];
    for (const [i, line] of lines.entries()) {
      // The first line that is the file's next line: the model has run into the suffix.
      if (i > 0 && next && line.trim() === next && line.trim().length > 1) break;
      keep.push(line);
      if (keep.length >= Math.max(1, maxLines)) break;
    }
    out = keep.join("\n");
  }
  out = out.replace(/\s+$/, "");
  if (!out.trim()) return null;
  const rest = suffix.split("\n")[0] ?? "";
  if (rest.trim() && out.endsWith(rest.trim()) && out.length > rest.trim().length)
    out = out.slice(0, out.length - rest.trim().length).replace(/\s+$/, "");
  if (!out.trim() || suffix.startsWith(out)) return null;
  return out;
}

/**
 * A FIM reply without the special tokens some servers let through (`<|fim_middle|>`,
 * `<|endoftext|>`, `<|file_sep|>`, `<EOT>`): the text up to the first one that ends it.
 */
export function cleanFim(text: string): string {
  const end = text.search(/<\|(?:endoftext|file_sep|fim_pad|im_end|eot_id)\|>|<EOT>|<\|end\|>/);
  const cut = end >= 0 ? text.slice(0, end) : text;
  return cut.replace(
    /<\|fim_(?:prefix|suffix|middle)\|>|<(?:PRE|SUF|MID)>|<fim_(?:prefix|suffix|middle)>/g,
    "",
  );
}
