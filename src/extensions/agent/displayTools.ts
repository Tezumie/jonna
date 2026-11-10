// Display tools (D171): how the agent shows link / file cards or a question to click —
// the way Claude's widgets, ChatGPT's Apps SDK (structuredContent) and MCP Apps do it. The model
// calls a tool with JSON; the chat draws the call as a card where it happened (turns.ts keeps it
// out of the work group); the model gets a one-line result. The answer's text stays plain
// Markdown, so copying it gives clean text. ask_user waits for the user's pick (or a typed
// answer) and returns it as the tool result, like Claude Code's AskUserQuestion: up to four
// questions in one card, with header chips and previews (D312). report_findings is a review's
// findings as a card (D313); suggest_extension an install card from Open VSX (D314).
import { askResult, askSummary, parseAskUser } from "../../core/agent/askUser";
import { cardFromTool } from "../../core/agent/displayCards";
import { findingsResult, findingsSummary, parseFindings } from "../../core/agent/findings";
import type { ToolSpec } from "../../core/ipc/agent";
import { DISCOVERY_TOOLS } from "./discoveryTools";
import { SUGGEST_EXTENSION_TOOL } from "./extensionSuggest";
import type { AgentTool } from "./tools";
import { WIDGET_TOOLS } from "./widgetTools";

const LINKS: ToolSpec = {
  name: "show_links",
  description:
    "Show web pages or project files as cards the user can click (sources you used, files to look at). Each item has a url (https) or a path (relative to the workspace, with an optional line). For one link, write it inline in your answer instead.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            path: { type: "string" },
            line: { type: "integer" },
            note: { type: "string", description: "One short line on why it matters" },
          },
        },
      },
    },
    required: ["items"],
  },
};

const ASK: ToolSpec = {
  name: "ask_user",
  description:
    'Ask the user 1 to 4 questions in one card when you need their decision to go on: choices that are genuinely theirs (an approach, a library, which of two readings they meant), not facts you can find out or choices with a conventional default. Each question: a complete question ending in \'?\', a header (a chip label, at most 12 characters, e.g. "Auth method"), 2 to 4 options and multiSelect. Each option: a label (1-5 words), a description (what it means or costs) and, when seeing it helps choose, a preview (a mockup, code snippet or comparison, shown while the option is focused). The user can always type their own answer instead. To recommend one, put it first and end its label with " (Recommended)". You get the answers back by question.',
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1 to 4 questions, answered together",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string", description: "Chip label, at most 12 characters" },
            options: {
              type: "array",
              description: "2 to 4 choices",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "1-5 words" },
                  description: { type: "string", description: "What it means or its trade-off" },
                  preview: {
                    type: "string",
                    description:
                      "Optional: shown while the option is focused (monospace; a mockup, code, a comparison)",
                  },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: { type: "boolean", description: "Let them pick several (default false)" },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const ERROR_HINT: Record<string, string> = {
  show_links:
    'Error: give items with a url (https) or a path, e.g. { "items": [{ "title": "Docs", "url": "https://…" }, { "path": "src/main.ts", "line": 12 }] }.',
  ask_user:
    'e.g. { "questions": [{ "question": "Which auth method?", "header": "Auth method", "options": [{ "label": "OAuth (Recommended)", "description": "Sign in with GitHub" }, { "label": "Password", "description": "A form of our own" }] }] }.',
  report_findings:
    'e.g. { "findings": [{ "file": "src/cart.ts", "line": 41, "summary": "…", "short_summary": "…", "failure_scenario": "…", "category": "correctness", "verdict": "CONFIRMED" }] } (an empty array when nothing survived).',
};

const FINDINGS: ToolSpec = {
  name: "report_findings",
  description:
    "Report code-review findings as a typed list the chat shows as a card (each opens its file at the line; the user can ask you to fix one or all). Call it once, after verifying, with the findings that survived, most severe first (an empty array if none did); don't list them again in your answer. When re-reporting after fixing them, give each its outcome.",
  parameters: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "Relative to the folder" },
            line: { type: "integer" },
            summary: { type: "string", description: "One sentence" },
            short_summary: { type: "string", description: "At most 60 characters" },
            failure_scenario: {
              type: "string",
              description: "Concrete inputs or state → the wrong output or crash",
            },
            category: {
              type: "string",
              description:
                "A kebab-case slug: correctness, security, simplification, efficiency, test-coverage…",
            },
            verdict: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE"] },
            outcome: {
              type: "string",
              enum: ["fixed", "skipped", "no_change_needed"],
              description: "Only when re-reporting after fixes",
            },
          },
          required: ["file", "line", "summary", "short_summary", "failure_scenario", "category"],
        },
      },
    },
    required: ["findings"],
  },
};

export const DISPLAY_TOOLS: AgentTool[] = [
  {
    spec: LINKS,
    readOnly: true,
    verb: "Showed links",
    target: (a) => (Array.isArray(a.items) ? `${a.items.length}` : ""),
    async run(args) {
      const block = cardFromTool("show_links", args);
      if (block?.kind !== "links") return { result: ERROR_HINT.show_links ?? "", isError: true };
      return { result: `Shown to the user as ${block.items.length} cards.` };
    },
  },
  {
    spec: ASK,
    readOnly: true,
    // One card at a time: two cards waiting at once would be answered in the wrong order.
    concurrent: false,
    verb: "Asked",
    target: (a) => {
      const card = parseAskUser(a);
      if ("error" in card) return String(a.question ?? "").slice(0, 80);
      const first = card.questions[0]?.question ?? "";
      return card.questions.length > 1 ? `${card.questions.length} questions` : first.slice(0, 80);
    },
    async run(args, host, itemId) {
      const card = parseAskUser(args);
      if ("error" in card)
        return { result: `Error: ${card.error}; ${ERROR_HINT.ask_user}`, isError: true };
      // Full access (D163): the user is away and nothing waits on them.
      if (host.services.settings.peek<string>("agent.runCommands") === "full")
        return {
          result:
            "The user is away (full access), so nobody can answer. Pick the most reasonable option yourself, say which in your answer, and go on.",
          detail: "Not asked: full access",
        };
      if (!host.question) return { result: "Error: asking isn't available here.", isError: true };
      const answer = await host.question(itemId);
      if (answer === null) return { result: "The user didn't answer (stopped).", isError: true };
      const answers = typeof answer === "string" ? answer : answer.answers;
      return {
        result: askResult(card, answers),
        summary: askSummary(card, answers),
        // The card shows each question's answer from here (D312).
        ...(typeof answers !== "string" && { detail: JSON.stringify(answers) }),
      };
    },
  },
  {
    spec: FINDINGS,
    readOnly: true,
    verb: "Reported findings",
    target: (a) => (Array.isArray(a.findings) ? `${a.findings.length}` : ""),
    async run(args) {
      const card = parseFindings(args);
      if ("error" in card)
        return { result: `Error: ${card.error}; ${ERROR_HINT.report_findings}`, isError: true };
      return { result: findingsResult(card), summary: findingsSummary(card) };
    },
  },
  SUGGEST_EXTENSION_TOOL,
  // suggest_skill, suggest_mcp_server, mcp_status (D342, D343).
  ...DISCOVERY_TOOLS,
  // Inline widgets and their design guide (D334).
  ...WIDGET_TOOLS,
];
