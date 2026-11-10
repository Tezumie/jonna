// The status line command (D357, core/agent/statusLine.ts), Claude Code's `statusLine`: the user's
// `agent.statusLine` command (user settings only: a folder's settings mustn't add commands) gets
// the active chat as JSON on stdin and the first line it prints shows in the status bar, beside
// the agent's model, ANSI colors in the theme's terminal colors. It runs in the open folder, through
// the same runner as the agent's commands (PowerShell on Windows), in trusted folders only (it's
// the user's script, but it runs inside the repository), again when the conversation changes, at
// most every 300 ms. ide://agent/statusLine.
// D373: OSC 8 links in the line are clickable (agent.openStatusLineLink): web pages, files at a
// line, and the IDE's commands that change nothing.

import { DEFAULT_STYLE } from "../../core/agent/outputStyles";
import {
  plainStatus,
  type StatusLineChat,
  statusLineInput,
  statusLineSegments,
  statusLineSetting,
  statusLineText,
  statusLinkTarget,
  Throttle,
} from "../../core/agent/statusLine";
import { h } from "../../core/dom/index";
import { execIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { ansiNodes } from "../editor/notebook/ansi";
import { modelLabel } from "./menus";
import { activeOutputStyle } from "./outputStyles";
import type { ProviderRegistry } from "./providers";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

const SETTING = "agent.statusLine";
/** Commands a person let status line links run, in this window (D379). */
const confirmedLinks = new Set<string>();
/** At most this often (Claude Code's 300 ms). */
const EVERY_MS = 300;
/** A command that takes longer is stopped (the line keeps its last text). */
const TIMEOUT_MS = 5000;
/** The most of its output kept: the first line is all that's shown. */
const KEPT_OUTPUT = 16_000;

/** When each chat was first seen in this window and how long its turns ran (the cost fields). */
interface Clock {
  since: number;
  busySince: number | null;
  busyMs: number;
}

export function registerStatusLine(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): void {
  const { settings, workspace, dock, state, statusBar } = services;
  /** The line now (with its colors), and what the last run said. */
  const line = signal("");
  const info = {
    runs: 0,
    lastMs: 0,
    error: null as string | null,
    exitCode: null as number | null,
    skipped: null as string | null,
  };
  const clocks = new Map<string, Clock>();
  let seq = 0;
  let dataDir: string | null = null;
  void appIpc
    .info()
    .then((i) => {
      dataDir = i.dataDir;
    })
    .catch(() => {});

  const clockOf = (s: AgentSession): Clock => {
    let c = clocks.get(s.id);
    if (!c) {
      c = { since: Date.now(), busySince: null, busyMs: 0 };
      clocks.set(s.id, c);
    }
    return c;
  };

  /** The chat the line is about: the active one, when a chat tab is open. */
  const activeChat = (): AgentSession | undefined => {
    const id = sessions.active.peek();
    const chat = id ? sessions.find(id) : undefined;
    return chat && dock.tabs("agent").length > 0 ? chat : undefined;
  };

  const chatInfo = async (s: AgentSession, cwd: string): Promise<StatusLineChat> => {
    const clock = clockOf(s);
    const now = Date.now();
    const lines = s.changeset.totals();
    const usage = s.usage.peek();
    const style = await activeOutputStyle(services).catch(() => null);
    return {
      sessionId: s.id,
      transcriptPath: dataDir
        ? joinPath(joinPath(joinPath(dataDir, "agent"), "sessions"), `${s.id}.json`)
        : null,
      cwd,
      projectDir: workspace.root.peek() ?? cwd,
      model: { id: s.model.peek() ?? "", displayName: modelLabel(providers, s) },
      version: product.version,
      outputStyle: style?.style.name ?? DEFAULT_STYLE,
      cost: s.cost.peek(),
      durationMs: now - clock.since,
      apiDurationMs: clock.busyMs + (clock.busySince !== null ? now - clock.busySince : 0),
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.limit ?? null,
    };
  };

  const runOnce = async (): Promise<void> => {
    const setting = statusLineSetting(settings.peek(SETTING));
    const chat = activeChat();
    const cwd = workspace.root.peek();
    info.skipped = !setting
      ? "no command"
      : !chat
        ? "no chat"
        : !cwd
          ? "no folder"
          : !services.trust.trusted
            ? "the folder isn't trusted"
            : null;
    if (!setting || !chat || !cwd || info.skipped) {
      line.value = "";
      return;
    }
    const input = statusLineInput(await chatInfo(chat, cwd));
    let output = "";
    const started = Date.now();
    try {
      const r = await execIpc.run(
        `statusline-${++seq}`,
        setting.command,
        { cwd, timeoutMs: TIMEOUT_MS, stdin: input },
        (chunk) => {
          if (output.length < KEPT_OUTPUT) output += chunk;
        },
      );
      info.runs++;
      info.lastMs = Date.now() - started;
      info.exitCode = r.exitCode;
      info.error = r.timedOut ? `timed out after ${TIMEOUT_MS / 1000} s` : null;
      // A command that failed or timed out without a word keeps the last line.
      const text = statusLineText(output);
      if (text || r.exitCode === 0)
        line.value = text ? `${" ".repeat(setting.padding)}${text}` : "";
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
    }
  };

  const throttle = new Throttle(EVERY_MS, runOnce, {
    now: () => Date.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  sub.add({ dispose: () => throttle.dispose() });

  // Runs again when the conversation or what the line shows changes.
  sub.add(
    effect(() => {
      const setting = settings.get(SETTING);
      settings.get("agent.outputStyle");
      workspace.root.value;
      // Trust given or taken back.
      services.trust.state.value;
      const id = sessions.active.value;
      const chat = id ? sessions.find(id) : undefined;
      if (chat) {
        chat.version.value;
        chat.cost.value;
        chat.model.value;
        chat.usage.value;
        chat.changeset.files.value;
        const status = chat.status.value;
        const clock = clockOf(chat);
        if (status !== "idle" && clock.busySince === null) clock.busySince = Date.now();
        else if (status === "idle" && clock.busySince !== null) {
          clock.busyMs += Date.now() - clock.busySince;
          clock.busySince = null;
        }
      }
      if (statusLineSetting(setting)) queueMicrotask(() => throttle.request());
      else line.value = "";
      return undefined;
    }),
  );

  sub.add(
    statusBar.add({
      id: "agent.statusLine",
      name: "Agent status line",
      alignment: "right",
      // Beside the agent's model (15), on its left.
      priority: 14,
      text: () => {
        const text = line.value;
        // Only while a chat tab is open, like the model's item.
        sessions.active.value;
        return activeChat() ? text : "";
      },
      // One span: the item's gap mustn't open between colored pieces and links.
      nodes: (text) => [
        h(
          "span",
          { class: "statusline-text" },
          ...statusLineSegments(text).flatMap(({ text: part, href }) =>
            href && statusLinkTarget(href)
              ? [
                  h(
                    "span",
                    {
                      class: "statusline-link",
                      role: "link",
                      title: href,
                      "data-command": "agent.openStatusLineLink",
                      "data-input": JSON.stringify({ href }),
                    },
                    ...ansiNodes(part),
                  ),
                ]
              : ansiNodes(part),
          ),
        ),
      ],
      tooltip: () => `${plainStatus(line.value).trim()} · Status line (agent.statusLine)`,
    }),
  );

  sub.add(
    services.dispatcher.register({
      id: "agent.openStatusLineLink",
      title: "Open status line link",
      category: "Agent",
      description:
        "Opens a link from the status line command's output (an OSC 8 hyperlink, D373): http(s) in the browser, file:// at its line in an editor, command:<id>?<JSON input> runs that IDE command when it changes nothing (no write, exec, network or destructive effect).",
      input: s.object({ href: s.string() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ href }, ctx) => {
        const target = statusLinkTarget(href);
        if (!target) throw new Error(`Not a link the status line opens: ${href}`);
        const { dispatcher } = services;
        if (target.kind === "web") return dispatcher.execute("agent.openLink", { url: target.url });
        if (target.kind === "file")
          return dispatcher.execute("editor.openFile", {
            path: target.path,
            ...(target.line && { line: target.line }),
          });
        // The line is a script's output: a link may show, not change, anything. A command's
        // declared effects don't prove that (some with none start a turn or close the folder,
        // D379), so a person is asked once per command in this window, by its name.
        const info = dispatcher.info(target.id);
        if (!info) throw new Error(`No command ${target.id}.`);
        if (info.effects.some((e) => e !== "read") || info.agent === "hidden")
          throw new Error(
            `${target.id} changes things, so it doesn't run from a status line link.`,
          );
        if (ctx.caller.kind === "user" && !confirmedLinks.has(info.id)) {
          const ok = await confirmAction(
            `Run "${info.title}"?`,
            `A link in the status line (your agent.statusLine command's output) runs the command ${info.id}. Asked once per command in this window.`,
            "Run",
          );
          if (!ok) return { ran: false };
          confirmedLinks.add(info.id);
        }
        return dispatcher.execute(target.id, target.input);
      },
    }),
  );

  sub.add(
    state.register("ide://agent/statusLine", {
      description:
        "The status line command (agent.statusLine, D357): the command, the line it printed last (`text` without its colors, `raw` with them), how many times it ran, its last run's time, exit code and error, and why it doesn't run (`skipped`: no command, no chat, no folder, an untrusted folder).",
      get: () => {
        const setting = statusLineSetting(settings.peek(SETTING));
        return {
          command: setting?.command ?? null,
          text: plainStatus(line.peek()),
          raw: line.peek(),
          runs: info.runs,
          lastMs: info.lastMs,
          exitCode: info.exitCode,
          error: info.error,
          skipped: info.skipped,
        };
      },
    }),
  );
}
