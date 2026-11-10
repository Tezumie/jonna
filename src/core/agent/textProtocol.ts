// Tool calling for models without native support (PLAN §8.3 "strict text protocol fallback"):
// the system prompt describes the tools and asks for <tool_call>{json}</tool_call> blocks (the
// Hermes/Qwen convention most open models were trained on); the parser is forgiving (fenced
// JSON, trailing commas, "tool"/"function" keys, arguments given as a string). DOM-free.
import type { ToolSpec } from "../ipc/agent";

export interface ParsedCall {
  name: string;
  arguments: unknown;
  /** Which `<tool_call>` block of the reply it came from (0-based; D379), when it came from one. */
  block?: number;
}

export function toolsPrompt(tools: readonly ToolSpec[]): string {
  const list = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  parameters (JSON Schema): ${JSON.stringify(t.parameters)}`,
    )
    .join("\n");
  return `You can use tools. To call one, reply with a block like this (nothing else in that message is needed):

<tool_call>
{"name": "read_file", "arguments": {"path": "src/main.ts"}}
</tool_call>

You may put several <tool_call> blocks in one reply. The results come back in the next message. When you are done, answer normally without any <tool_call> block.

Available tools:
${list}`;
}

/**
 * A call written the way `toolsPrompt` asks for it: how a native call (one without the reply's
 * raw text) is shown to a text-protocol model, after a mid-turn switch to such a model (D233).
 * Deterministic for the same call, so the history renders the same bytes on every request.
 */
export function toolCallText(name: string, args: unknown): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args ?? {} })}\n</tool_call>`;
}

function repairJson(text: string): unknown {
  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, "$1"),
    text.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"'),
  ];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      // next
    }
  }
  return undefined;
}

function toCall(value: unknown): ParsedCall | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fn = (v.function && typeof v.function === "object" ? v.function : v) as Record<
    string,
    unknown
  >;
  const name = fn.name ?? v.tool ?? v.tool_name;
  if (typeof name !== "string" || !name) return null;
  let args = fn.arguments ?? fn.parameters ?? v.arguments ?? v.input ?? v.args ?? {};
  if (typeof args === "string") args = repairJson(args) ?? { input: args };
  return { name, arguments: args };
}

/** Extracts tool calls and returns the remaining prose. Only names in `known` count as calls. */
export function parseToolCalls(
  text: string,
  known: ReadonlySet<string>,
): { text: string; calls: ParsedCall[] } {
  const calls: ParsedCall[] = [];
  let rest = text;
  const opens = (upTo: number) => text.slice(0, upTo).split("<tool_call>").length - 1;
  const take = (re: RegExp, blockAt?: (offset: number) => number) => {
    rest = rest.replace(re, (whole, body: string, offset: number) => {
      const parsed = repairJson(body.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const found = list.map(toCall).filter((c): c is ParsedCall => !!c && known.has(c.name));
      if (found.length === 0) return whole;
      const block = blockAt?.(offset);
      calls.push(...found.map((c) => (block === undefined ? c : { ...c, block })));
      return "";
    });
  };
  // The first pass runs on the reply as written, so a match's offset counts the blocks before it.
  take(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, opens);
  // Unclosed final block (the model stopped right after the JSON): the reply's last block.
  // From the last <tool_call> only: an earlier one left in the text (not a call) mustn't swallow it.
  take(/<tool_call>(?![\s\S]*<tool_call>)\s*(\{[\s\S]*\})\s*$/g, () => opens(text.length) - 1);
  // A fenced JSON block counts only at the end of the reply: one in the middle, followed by more
  // prose, is the model showing an example, not calling a tool (D163).
  if (calls.length === 0) take(/```(?:json|tool|tool_call)?\s*(\{[\s\S]*?\})\s*```\s*$/g);
  return { text: rest.trim(), calls };
}
