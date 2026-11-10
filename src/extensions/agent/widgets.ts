// What a show_widget card does (D334), as commands: open it full size in a tab, copy its code,
// save it as a file, and send sendPrompt's text as the user's message (the card calls them; tests
// and agents may too). Also the widget tab (dock view `agent.widget`), the theme following the
// IDE's into every widget, and ide://agent/widgets.

import {
  PromptLimiter,
  parseWidget,
  promptText,
  WIDGET_TOOL,
  type Widget,
  widgetDocument,
  widgetFileName,
  widgetLabel,
} from "../../core/agent/widgets";
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { attachIpc } from "../../core/ipc/agent";
import { clipboardIpc, openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import {
  refreshWidgetThemes,
  WidgetFrame,
  widgetDrafts,
  widgetFrameOf,
  widgetStatus,
  widgetTheme,
} from "./view/widgetCard";

export const WIDGET_VIEW = "agent.widget";

/** sendPrompt's limit per widget, on top of the frame's own (a second tab of it shares this). */
const limiters = new Map<string, PromptLimiter>();

/** The widget of call `item` in `session`. */
function widgetOf(session: AgentSession, item: string): Widget {
  const it = session.items.find((i) => i.id === item);
  if (it?.type !== "tool" || it.name !== WIDGET_TOOL)
    throw new Error(`No widget ${item} in this chat.`);
  const w = parseWidget(it.args);
  if ("error" in w) throw new Error(`That widget can't be drawn: ${w.error}.`);
  return w;
}

interface TabState {
  session?: string;
  item?: string;
  title: string;
  code: string;
}

/** Tabs bigger than this aren't brought back after a restart (the layout would carry the code). */
const PERSIST_CHARS = 50_000;

class WidgetView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();

  constructor(
    private readonly state: TabState,
    services: WorkbenchServices,
  ) {
    const parsed = parseWidget({ title: state.title, widget_code: state.code });
    if ("error" in parsed) {
      this.element = h("div", { class: "agent-widget-page" }, h("p", null, parsed.error));
      return;
    }
    const frame = this.store.add(
      new WidgetFrame(
        parsed,
        {
          prompt: (text) => {
            if (!state.session || !state.item) return;
            void services.dispatcher
              .execute("agent.sendFromWidget", {
                session: state.session,
                item: state.item,
                text,
              })
              .catch((err: unknown) =>
                services.notifications.show(
                  "error",
                  err instanceof Error ? err.message : String(err),
                ),
              );
          },
          openLink: (url) =>
            void services.dispatcher.execute("agent.openLink", { url }).catch(() => {}),
        },
        true,
      ),
    );
    this.element = h("div", { class: "agent-widget-page" }, frame.frame);
  }

  serialize(): Json {
    return this.state as unknown as Json;
  }

  persist(): boolean {
    return this.state.code.length <= PERSIST_CHARS;
  }

  dispose(): void {
    this.store.dispose();
  }
}

const tabState = (st: Json): TabState | null => {
  const o =
    st && typeof st === "object" && !Array.isArray(st) ? (st as Record<string, unknown>) : {};
  if (typeof o.code !== "string") return null;
  return {
    title: typeof o.title === "string" ? o.title : "widget",
    code: o.code,
    ...(typeof o.session === "string" && { session: o.session }),
    ...(typeof o.item === "string" && { item: o.item }),
  };
};

export function registerWidgets(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, dock, notifications } = services;
  const register = (c: Parameters<typeof dispatcher.register>[0]) =>
    sub.add(dispatcher.register(c));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  const itemInput = s.string().describe("The show_widget call");

  sub.add(
    dock.views.register({
      type: WIDGET_VIEW,
      title: (st) => widgetLabel(tabState(st)?.title ?? ""),
      icon: () => "app-window",
      defaultPlacement: "main",
      editorLike: true,
      create: (st) =>
        new WidgetView(
          tabState(st) ?? { title: "widget", code: "<p>Nothing to show.</p>" },
          services,
        ),
    } satisfies DockViewDescriptor),
  );

  // Widgets take the IDE's colors, now and when the theme changes.
  sub.add(
    effect(() => {
      const kind = services.theme.theme.value;
      queueMicrotask(() => refreshWidgetThemes(kind));
      return undefined;
    }),
  );

  register({
    id: "agent.openWidget",
    title: "Open widget in a tab",
    category: "Agent",
    description:
      "Opens a chat's show_widget widget (D334) full size in a tab of its own; its sendPrompt still sends to that chat.",
    input: s.object({ session: sessionInput, item: itemInput }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: ({ session, item }) => {
      const target = sessions.require(session);
      const w = widgetOf(target, item);
      const open = dock.tabs(WIDGET_VIEW).find((t) => {
        const st = tabState(t.viewState);
        return st?.session === target.id && st.item === item;
      });
      if (open) {
        dock.activateTab(open.id, true);
        return { tabId: open.id };
      }
      const state: TabState = { session: target.id, item, title: w.title, code: w.code };
      return { tabId: dock.openView(WIDGET_VIEW, state as unknown as Json, "main", true) };
    },
  });

  register({
    id: "agent.copyWidgetCode",
    title: "Copy widget code",
    category: "Agent",
    description: "Copies a show_widget widget's SVG or HTML code (D334) to the clipboard.",
    input: s.object({ session: sessionInput, item: itemInput }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ session, item }) => {
      const w = widgetOf(sessions.require(session), item);
      await clipboardIpc.writeText(w.code);
      notifications.show("info", "Copied the widget's code.");
      return { chars: w.code.length };
    },
  });

  register({
    id: "agent.saveWidget",
    title: "Save widget as file…",
    category: "Agent",
    description:
      "Saves a show_widget widget (D334) as a file through the system's save dialog: an SVG as .svg, an HTML widget as a whole .html page with the theme's colors.",
    input: s.object({
      session: sessionInput,
      item: itemInput,
      path: s.string().describe("Debug builds only: where, without the dialog").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, path }) => {
      const w = widgetOf(sessions.require(session), item);
      const theme = widgetTheme();
      const name = widgetFileName(w);
      const bytes = new TextEncoder().encode(widgetDocument(w, theme.vars, theme.scheme));
      const saved = await attachIpc.saveAs(name, bytes, path);
      if (!saved) return null;
      notifications.show("info", `Saved ${name}.`, {
        actions: [{ label: "Show in folder", run: () => void openerIpc.revealInOs(saved) }],
      });
      return { path: saved };
    },
  });

  register({
    id: "agent.sendFromWidget",
    title: "Send a widget's message",
    category: "Agent",
    description:
      "Sends a show_widget widget's sendPrompt text (D334) to its chat as the user's message, marked as from the widget (the user clicked in it). While the agent works it joins the turn at its next step. Limited to one message every 1.5 s and six a minute per widget.",
    input: s.object({
      session: sessionInput,
      item: itemInput,
      text: s.string().describe("The message"),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, text }) => {
      const target = sessions.require(session);
      const w = widgetOf(target, item);
      const message = promptText(text);
      if (!message) throw new Error("The widget sent no text.");
      const key = `${target.id}:${item}`;
      let limiter = limiters.get(key);
      if (!limiter) {
        limiter = new PromptLimiter();
        limiters.set(key, limiter);
      }
      if (!limiter.allow(Date.now()))
        throw new Error("The widget is sending too often; wait a moment.");
      const attachments = [
        { kind: "mention" as const, name: `From ${widgetLabel(w.title)}`, widget: true },
      ];
      const context = [
        `Sent from the widget ${w.title} (its sendPrompt, on the user's click), not typed.`,
      ];
      if (target.busyNow()) {
        // Waiting on a question: the widget's text answers it, as a typed message would.
        if (target.questions.peek().length && target.answer(message))
          return { session: target.id, answered: true };
        if (!target.canQueue()) throw new Error("The agent is busy for a moment; try again.");
        const queued = target.enqueue(message, context, { attachments });
        return { session: target.id, queued: queued.id };
      }
      void target
        .send(message, context, { attachments })
        .catch((err: unknown) =>
          notifications.show("error", err instanceof Error ? err.message : String(err)),
        );
      return { session: target.id, sent: true };
    },
  });

  sub.add(
    services.state.register("ide://agent/widgets", {
      description:
        "The active chat's inline widgets (show_widget, D334): each call's title, mode (svg/html), whether its frame drew it, its height, script errors, how many sendPrompt messages it sent and whether it was drawn while written (`streamed`, with its `paints`, D355); `drafts`: calls being written now, painted as they arrive; and the widget tabs open.",
      get: () => {
        const target = sessions.find(undefined);
        if (!target) return null;
        return {
          session: target.id,
          widgets: target.items.flatMap((it) => {
            if (it.type !== "tool" || it.name !== WIDGET_TOOL) return [];
            const w = parseWidget(it.args);
            const status = widgetStatus.get(`${target.id}:${it.id}`);
            return [
              {
                item: it.id,
                status: it.status,
                ...("error" in w
                  ? { error: w.error }
                  : { title: w.title, mode: w.mode, chars: w.code.length }),
                rendered: status?.rendered ?? false,
                height: status?.height ?? 0,
                errors: status?.errors ?? [],
                prompts: status?.prompts ?? 0,
                streamed: status?.streamed ?? false,
                paints: status?.paints ?? 0,
                loads: status?.loads ?? 0,
              },
            ];
          }),
          drafts: widgetDrafts(target.id),
          tabs: dock.tabs(WIDGET_VIEW).map((t) => {
            const st = tabState(t.viewState);
            return { tabId: t.id, item: st?.item ?? null, title: st?.title ?? "" };
          }),
        };
      },
    }),
  );

  // UI tests: a click inside a widget's frame, as the user's (the frame is another origin, which
  // dev.click can't reach).
  if (__DEV__)
    register({
      id: "dev.clickInWidget",
      title: "Click inside a widget",
      category: "Developer",
      description:
        "Clicks the first element matching a CSS selector inside a chat's show_widget frame (UI tests of D334), as the user would; its sendPrompt is then allowed for a moment.",
      input: s.object({ session: sessionInput, item: itemInput, selector: s.string() }),
      effects: ["write"],
      run: async ({ session, item, selector }) => {
        const target = sessions.require(session);
        const frame = widgetFrameOf(target.id, item);
        if (!frame) throw new Error("That widget isn't on screen.");
        return { clicked: await frame.testClick(selector) };
      },
    });
}
