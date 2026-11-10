// Prompts and output cleanup for the editor's AI features (D106): inline edit (rewrite the selected
// lines) and ghost-text completion (text to insert at the cursor). DOM-free and tested: models
// often wrap code in fences, repeat the surrounding lines or add a sentence; we strip that.

export const EDIT_SYSTEM = [
  "You edit code inside an editor.",
  "You get a file, the lines to change between <selection> tags, and an instruction.",
  "Reply with ONLY the new text for those lines: no explanation, no Markdown fences, no tags.",
  "Keep the file's indentation, style and line endings. If the selection is empty, write the code to insert there.",
].join(" ");

export const COMPLETE_SYSTEM = [
  "You are a code completion engine.",
  "You get the code before and after the cursor. Reply with ONLY the text to insert at <cursor>:",
  "usually the rest of the line or a few lines, never the text that already follows the cursor.",
  "No explanation, no Markdown fences. Reply with nothing if nothing fits.",
].join(" ");

const CONTEXT_LINES = 120;

export interface EditContext {
  path: string;
  languageId: string;
  /** The whole file, LF line endings. */
  text: string;
  startLine: number;
  endLine: number;
  instruction: string;
}

export function editPrompt(c: EditContext): string {
  const lines = c.text.split("\n");
  const before = lines.slice(Math.max(0, c.startLine - 1 - CONTEXT_LINES), c.startLine - 1);
  const selection = lines.slice(c.startLine - 1, c.endLine);
  const after = lines.slice(c.endLine, c.endLine + CONTEXT_LINES);
  return [
    `File: ${c.path} (${c.languageId})`,
    "",
    before.join("\n"),
    "<selection>",
    selection.join("\n"),
    "</selection>",
    after.join("\n"),
    "",
    `Instruction: ${c.instruction}`,
    "",
    "Reply with only the new text for the lines between <selection> and </selection>.",
  ].join("\n");
}

/** The model's reply → the replacement text (fences, tags and chatter removed). */
export function cleanEdit(reply: string, original: string): string {
  let text = reply.replace(/\r\n/g, "\n");
  // Thinking that leaked into the text.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fence = text.match(/```[\w+-]*\n([\s\S]*?)\n?```/);
  if (fence?.[1] !== undefined) text = fence[1];
  text = text.replace(/^\s*<selection>\n?/, "").replace(/\n?<\/selection>\s*$/, "");
  // Keep a trailing newline only if the original had one at the same place (lines are replaced).
  text = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (original.endsWith("\n")) text += "\n";
  return text;
}

/** The model's reply → ghost text, or null (nothing useful, or it just repeats what follows). */
export function cleanCompletion(reply: string, prefix: string, suffix: string): string | null {
  let text = reply.replace(/\r\n/g, "\n").replace(/<think>[\s\S]*?<\/think>/g, "");
  const fence = text.match(/```[\w+-]*\n([\s\S]*?)\n?```/);
  if (fence?.[1] !== undefined) text = fence[1];
  text = text.replace(/<cursor>/g, "");
  // Models sometimes start by repeating the current line's beginning.
  const lineStart = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (lineStart.trim() && text.startsWith(lineStart)) text = text.slice(lineStart.length);
  else if (lineStart.trim() && text.startsWith(lineStart.trimStart()))
    text = text.slice(lineStart.trimStart().length);
  // …or end with what already follows the cursor.
  const rest = suffix.split("\n")[0] ?? "";
  if (rest.trim() && text.endsWith(rest)) text = text.slice(0, -rest.length);
  text = text.replace(/\s+$/, "");
  if (!text.trim()) return null;
  if (suffix.startsWith(text)) return null;
  return text;
}
