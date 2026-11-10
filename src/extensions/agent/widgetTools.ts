// show_widget and widget_guide (D334), as Claude Code's show_widget and read_me: the agent draws
// an SVG picture or a small HTML page inline in the chat (view/widgetCard.ts), and reads the design
// rules once before its first widget. The rules are a tool of their own rather than part of the
// description: they're long, and most turns never draw a widget, while every request carries the
// descriptions.
import {
  parseWidget,
  WIDGET_GUIDE_TOOL,
  WIDGET_TOOL,
  widgetGuide,
  widgetLabel,
} from "../../core/agent/widgets";
import type { ToolSpec } from "../../core/ipc/agent";
import type { AgentTool } from "./tools";

const SHOW: ToolSpec = {
  name: WIDGET_TOOL,
  description:
    "Show visual content inline in the chat: SVG graphics, diagrams, charts, or interactive HTML widgets (dashboards, forms, calculators, data tables, small games, illustrations). Code starting with <svg is drawn as SVG, anything else as HTML. Call widget_guide once before your first widget for the theme variables and layout rules. It runs sandboxed with no network: put data in the code. A global sendPrompt(text) sends text to the chat as if the user typed it (on their click). For a plain chart or flowchart in an answer, ```mermaid is enough.",
  parameters: {
    type: "object",
    // Loading lines first: models write in this order, and they show while the code streams in
    // (D355).
    properties: {
      loading_messages: {
        type: "array",
        items: { type: "string" },
        description: "1 to 4 short lines shown until it starts to draw",
      },
      title: {
        type: "string",
        description: "A snake_case id (e.g. sales_by_month); also the saved file's name",
      },
      widget_code: {
        type: "string",
        description:
          "SVG or HTML content: no DOCTYPE, <html>, <head> or <body>; style with the theme's CSS variables; transparent background. It's drawn as you write it: put <style> first, then the structure, scripts last (they run once the call is complete)",
      },
    },
    required: ["title", "widget_code"],
  },
};

const GUIDE: ToolSpec = {
  name: WIDGET_GUIDE_TOOL,
  description:
    "The design rules for show_widget: the theme's CSS variables, typography, layout and what a widget can do. Read it once before your first widget in a chat.",
  parameters: { type: "object", properties: {} },
};

export const WIDGET_TOOLS: AgentTool[] = [
  {
    spec: SHOW,
    readOnly: true,
    verb: "Showed widget",
    target: (a) => widgetLabel(typeof a.title === "string" ? a.title : ""),
    async run(args) {
      const w = parseWidget(args);
      if ("error" in w)
        return {
          result: `Error: ${w.error}. e.g. { "title": "sales_by_month", "widget_code": "<svg viewBox=\\"0 0 320 160\\">…</svg>", "loading_messages": ["Plotting the months"] }`,
          isError: true,
        };
      return {
        result: `Shown to the user as ${w.mode === "svg" ? "an SVG" : "an HTML"} widget (${w.title}). Don't describe it again; say what to look at, if anything.`,
        summary: w.mode === "svg" ? "SVG" : "HTML",
      };
    },
  },
  {
    spec: GUIDE,
    readOnly: true,
    verb: "Read the widget guide",
    target: () => "",
    async run() {
      return { result: widgetGuide() };
    },
  },
];
