// Claude Code's IDE integration (D204), the DOM-free parts (D207): diagnostics with their ranges
// for getDiagnostics, which notebook executeCode runs in, and the at_mentioned notification's
// parameters (Claude Code's VS Code extension and claudecode.nvim's PROTOCOL.md: lines are
// 0-based). extensions/mcp/ideIntegration.ts serves them.

export interface IdeDiagnosticItem {
  path: string;
  /** 1-based, as ide://diagnostics gives them. */
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: string;
  message: string;
  source?: string;
  code?: string;
}

interface Position {
  line: number;
  character: number;
}

export interface IdeDiagnostic {
  message: string;
  severity: "Error" | "Warning" | "Information" | "Hint";
  range: { start: Position; end: Position };
  source?: string;
  code?: string;
}

const SEVERITY: Record<string, IdeDiagnostic["severity"]> = {
  error: "Error",
  warning: "Warning",
  info: "Information",
  hint: "Hint",
};

/** Diagnostics per file URI (VS Code's 0-based ranges); `only` keeps one file. */
export function ideDiagnostics(
  items: readonly IdeDiagnosticItem[],
  toUri: (path: string) => string,
  only?: (path: string) => boolean,
): { uri: string; diagnostics: IdeDiagnostic[] }[] {
  const byFile = new Map<string, IdeDiagnostic[]>();
  for (const i of items) {
    if (only && !only(i.path)) continue;
    const start = { line: Math.max(0, i.line - 1), character: Math.max(0, i.column - 1) };
    const endLine = i.endLine !== undefined ? Math.max(0, i.endLine - 1) : start.line;
    const endCharacter = i.endColumn !== undefined ? Math.max(0, i.endColumn - 1) : start.character;
    // An end before the start (a bad range) collapses to the start.
    const end =
      endLine > start.line || (endLine === start.line && endCharacter >= start.character)
        ? { line: endLine, character: endCharacter }
        : start;
    const uri = toUri(i.path);
    const list = byFile.get(uri) ?? [];
    list.push({
      message: i.message,
      severity: SEVERITY[i.severity] ?? "Information",
      range: { start, end },
      ...(i.source && { source: i.source }),
      ...(i.code && { code: i.code }),
    });
    byFile.set(uri, list);
  }
  return [...byFile].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}

/**
 * The Jupyter notebook executeCode runs in: the active one, else the only one open. A message
 * when there's none (or several and none active).
 */
export function notebookForCode(state: {
  open?: readonly string[];
  active?: { path?: string } | null;
}): { path: string } | { error: string } {
  const isJupyter = (p: string) => /\.ipynb$/i.test(p);
  const active = state.active?.path;
  if (active && isJupyter(active)) return { path: active };
  const open = (state.open ?? []).filter(isJupyter);
  if (open.length === 1 && open[0]) return { path: open[0] };
  return {
    error: open.length
      ? "Several notebooks are open in the IDE: make the one to run code in the active tab."
      : "No Jupyter notebook is open in the IDE: executeCode runs code in an open notebook's kernel.",
  };
}

export type IdeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * executeCode's answer (D222): the cell's text output, then its images as MCP image content (as
 * the VS Code extension answers, so Claude Code sees a plot), an error when the cell failed.
 */
export function executeCodeResult(run: {
  status?: string;
  output?: string;
  images?: readonly { mimeType: string; data: string }[];
}): { content: IdeContent[]; isError?: true } {
  const images = run.images ?? [];
  const body = run.output?.trim() ?? "";
  // The text names each image by type ("[image/png]"): with the images there, say less.
  const named = images.length ? body.replace(/^\[image\/[\w.+-]+\]\s?/gm, "").trim() : body;
  const content: IdeContent[] = [];
  if (named || !images.length) content.push({ type: "text", text: named || "(no output)" });
  for (const i of images) content.push({ type: "image", data: i.data, mimeType: i.mimeType });
  return { content, ...(run.status === "error" && { isError: true as const }) };
}

/** at_mentioned's parameters for a selection (1-based editor lines → 0-based). */
export function atMention(
  filePath: string,
  startLine: number,
  endLine: number,
  endColumn = 1,
): { filePath: string; lineStart: number; lineEnd: number } {
  const start = Math.max(0, startLine - 1);
  // A selection ending at the start of a line doesn't take that line (VS Code's reading).
  const last = endLine > startLine && endColumn <= 1 ? endLine - 1 : endLine;
  return { filePath, lineStart: start, lineEnd: Math.max(start, last - 1) };
}
