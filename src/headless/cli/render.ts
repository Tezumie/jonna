// A chat's events as text for a terminal: the answer as it streams (Markdown lightly styled),
// each tool call on one line with its outcome on the next, edits, notices and refusals. What
// needs an answer (a permission, a question) is the front end's own business and not drawn
// here. Pure: it writes through the function it is given.
import { redactSecrets } from "../../core/diagnostics/redact";
import type { SessionEvent } from "../run";
import { MarkdownStream } from "./markdown";
import { eventWithoutSecrets } from "./output";
import { clip, type Style, sanitize } from "./style";

export interface RenderOptions {
  style: Style;
  /** Thinking, a command's output as it comes, decisions that allowed. */
  verbose: boolean;
  /** Print the answer's text (a one-shot run keeps it for standard output). */
  answer: boolean;
  /** The terminal's width. */
  columns(): number;
}

/** The argument worth showing for a tool call: the command, the path, the pattern, the URL. */
export function toolBrief(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = a[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  if (name === "run_command") return first("command");
  const main = first(
    "path",
    "file",
    "command",
    "pattern",
    "query",
    "url",
    "name",
    "task",
    "prompt",
    "description",
    "id",
  );
  if (main) return main;
  for (const value of Object.values(a)) if (typeof value === "string" && value) return value;
  return "";
}

interface ToolLine {
  name: string;
  /** The call's line was printed (it waits while the arguments are still empty). */
  printed: boolean;
  args: unknown;
  /** Output lines shown so far (verbose). */
  output: number;
}

export class EventRenderer {
  private readonly markdown: MarkdownStream;
  /** The reply being printed. */
  private textItem: string | null = null;
  private thinkingItem: string | null = null;
  /** The last thing written ended a line. */
  private lineStart = true;
  /** Something was printed since the last blank line (a blank line separates blocks). */
  private block: "none" | "text" | "tool" | "note" = "none";
  private readonly tools = new Map<string, ToolLine>();

  constructor(
    private readonly write: (text: string) => void,
    private readonly options: RenderOptions,
  ) {
    this.markdown = new MarkdownStream(options.style);
  }

  private out(text: string): void {
    if (!text) return;
    this.write(text);
    this.lineStart = text.endsWith("\n");
  }

  /** Ends the reply being printed (its held text, its styles, its last line). */
  flush(): void {
    if (this.textItem !== null) {
      this.out(this.markdown.end());
      this.textItem = null;
    }
    this.thinkingItem = null;
    if (!this.lineStart) this.out("\n");
  }

  /** Starts a block of another kind than the last, with a blank line between. */
  private begin(kind: "text" | "tool" | "note"): void {
    this.flush();
    if (this.block !== "none" && (this.block !== kind || kind === "text")) this.out("\n");
    this.block = kind;
  }

  private toolLine(tool: ToolLine): void {
    if (tool.printed) return;
    tool.printed = true;
    const { style } = this.options;
    this.begin("tool");
    const brief = toolBrief(tool.name, tool.args);
    const width = Math.max(20, this.options.columns() - tool.name.length - 6);
    this.out(
      `${style.cyan(style.glyph("●", "*"))} ${style.bold(tool.name)}${brief ? ` ${style.dim(clip(sanitize(brief), width, style.unicode))}` : ""}\n`,
    );
  }

  private note(text: string, paint: (text: string) => string): void {
    this.begin("note");
    this.out(`${paint(sanitize(text))}\n`);
  }

  handle(given: SessionEvent): void {
    // A failure's text is somebody else's words (a provider, an MCP server): no key is shown.
    const event = eventWithoutSecrets(given);
    const { style, verbose } = this.options;
    const corner = style.glyph("  ⎿ ", "  -> ");
    switch (event.type) {
      case "text": {
        if (!this.options.answer) return;
        if (this.textItem !== event.id || event.reset) {
          this.begin("text");
          this.textItem = event.id;
          if (event.speaker) this.out(`${style.bold(sanitize(event.speaker))}: `);
        }
        this.out(this.markdown.write(event.delta));
        return;
      }
      case "thinking": {
        if (!verbose || !this.options.answer) return;
        if (this.thinkingItem !== event.id || event.reset) {
          this.begin("note");
          this.thinkingItem = event.id;
        }
        this.out(style.dim(style.italic(sanitize(event.delta))));
        return;
      }
      case "tool.start": {
        const tool: ToolLine = { name: event.name, printed: false, args: event.args, output: 0 };
        this.tools.set(event.id, tool);
        // Arguments still streaming in: the line waits for them (or for the call's end).
        if (toolBrief(event.name, event.args)) this.toolLine(tool);
        return;
      }
      case "tool.update": {
        const tool = this.tools.get(event.id);
        if (!tool) return;
        tool.args = event.args;
        if (toolBrief(tool.name, tool.args)) this.toolLine(tool);
        return;
      }
      case "tool.output": {
        const tool = this.tools.get(event.id);
        if (!verbose || !tool) return;
        this.toolLine(tool);
        this.flush();
        for (const line of sanitize(event.delta).split("\n")) {
          if (!line.trim()) continue;
          tool.output++;
          this.out(
            `${style.dim(`    ${clip(line, this.options.columns() - 6, style.unicode)}`)}\n`,
          );
        }
        return;
      }
      case "tool.end": {
        const tool = this.tools.get(event.id) ?? {
          name: event.name,
          printed: false,
          args: undefined,
          output: 0,
        };
        this.toolLine(tool);
        this.flush();
        this.tools.delete(event.id);
        const width = Math.max(20, this.options.columns() - 8);
        if (event.status === "done") {
          const summary = event.summary ?? "done";
          this.out(`${style.dim(`${corner}${clip(sanitize(summary), width, style.unicode)}`)}\n`);
        } else if (event.status === "denied") {
          this.out(`${style.yellow(`${corner}refused`)}\n`);
        } else {
          const why = event.summary ?? (event.result ?? "failed").split("\n")[0] ?? "failed";
          this.out(
            `${style.red(`${corner}${clip(sanitize(redactSecrets(why)), width, style.unicode)}`)}\n`,
          );
        }
        this.block = "tool";
        return;
      }
      case "edit": {
        this.flush();
        const state = event.state === "proposed" ? "proposed" : "written";
        this.out(`${style.dim(`${corner}${sanitize(event.path)}:${event.line} ${state}`)}\n`);
        this.block = "tool";
        return;
      }
      case "notice":
        this.note(
          `${style.glyph("▸", ">")} ${event.text}${event.detail && verbose ? `\n  ${event.detail}` : ""}`,
          event.tone === "error" ? style.red : style.dim,
        );
        return;
      case "summary":
        this.note(
          `${style.glyph("▸", ">")} The conversation was summarized (${event.count} messages).`,
          style.dim,
        );
        return;
      case "message": {
        // What the IDE sent by itself (a report, a failed check): one line, so the reply after it
        // makes sense. What the person typed is already on screen.
        if (!event.auto) return;
        this.note(
          `${style.glyph("▸", ">")} [${event.auto}] ${clip(event.text, this.options.columns() - 16, style.unicode)}`,
          style.dim,
        );
        return;
      }
      case "permission.decision": {
        if (event.by === "user") return;
        const what = event.code ?? event.tool ?? event.title;
        // Under the tool call it is about.
        const line =
          event.answer === "deny"
            ? style.yellow(
                `  ${style.glyph("✗", "x")} Refused: ${sanitize(what)}${event.rule ? ` (denied by ${event.rule})` : " (nobody to ask; see --allow, --permission-mode)"}`,
              )
            : verbose
              ? style.dim(
                  `  ${style.glyph("✓", "+")} Allowed: ${sanitize(what)}${event.rule ? ` (${event.rule})` : ""}`,
                )
              : "";
        if (!line) return;
        this.flush();
        this.out(`${line}\n`);
        this.block = "tool";
        return;
      }
      case "error":
        this.note(`${style.glyph("✗", "x")} ${event.message}`, style.red);
        return;
      case "turn.end":
        this.flush();
        return;
      default:
        return;
    }
  }
}
