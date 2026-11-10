// Output channels in the workbench (D209, VS Code's Output panel and "Set log level"): the
// channels' files in this session's logs folder, `log.level` as every channel's default and
// `log.channelLevels` for a channel's own (the Window channel's is the session log's), the Git
// channel (the git command lines the IDE ran, from Rust's git journal), the Agent channel (what
// agents, ACP agents and MCP clients ran), the Output tab and its commands, `ide://output`. The
// Window channel is the session log's (errorCapture.ts); Extension host, language servers and
// Tasks write theirs where they log.
import {
  type ChannelEntry,
  OUTPUT_LEVELS,
  type OutputLevel,
  output,
  parseChannelLevels,
  parseLevel,
} from "../../core/diagnostics/output";
import { gitCallRecord } from "../../core/diagnostics/outputText";
import { callerLabel } from "../../core/dispatcher/types";
import { logIpc } from "../../core/ipc/diagnostics";
import { isTauri, onCall } from "../../core/ipc/invoke";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import {
  outputViewDescriptor,
  outputViewOptions,
  setOutputFilter,
  setOutputWordWrap,
  showChannel,
  shownChannel,
} from "./outputView";

/** After a git call settles, its command lines are fetched this much later (one fetch a burst). */
const GIT_FETCH_DELAY_MS = 300;

const LEVEL_TITLES: Record<OutputLevel, string> = {
  trace: "Trace: everything, including git's queries (status, log, diff…)",
  debug: "Debug: also every command that ran",
  info: "Info (default): what happened, and the git commands that change something",
  warn: "Warning: problems only",
  error: "Error: errors only",
};

const LEVEL_OR_DEFAULT = [...OUTPUT_LEVELS, "default"] as const;

export function registerOutput(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock, settings, quickInput } = services;
  sub.add(dock.views.register(outputViewDescriptor(services)));

  // Channels' files (the Window channel's is the session log itself).
  output.setSink((entries: ChannelEntry[]) =>
    logIpc.write(
      entries.map((e) => ({
        level: e.level,
        source: e.source,
        message: e.message,
        channel: e.channel,
      })),
    ),
  );
  sub.add({
    dispose: () => {
      void output.flush();
      output.setSink(null);
    },
  });
  sub.add(
    effect(() => {
      output.setLevel(parseLevel(settings.watch("log.level").value));
      output.setChannelLevels(parseChannelLevels(settings.watch("log.channelLevels").value));
      return undefined;
    }),
  );

  // Git: the command lines the IDE ran, how long each took and how it failed (VS Code's Git
  // output). Rust keeps them (git/journal.rs); they're fetched shortly after a call that runs git
  // settles (the git panel's, the agent's worktrees'), one fetch for a burst of calls.
  // Kept across a reload of this window (the journal is the process's): the calls already
  // listed aren't listed again.
  const SEQ_KEY = "output.lastGitSeq";
  let lastGitSeq = 0;
  try {
    lastGitSeq = Number(sessionStorage.getItem(SEQ_KEY)) || 0;
  } catch {
    // No session storage: from the start.
  }
  let gitTimer: ReturnType<typeof setTimeout> | undefined;
  let fetching = false;
  let disposed = false;
  const fetchGitCalls = async () => {
    gitTimer = undefined;
    if (disposed) return;
    if (fetching) {
      gitTimer = setTimeout(() => void fetchGitCalls(), GIT_FETCH_DELAY_MS);
      return;
    }
    fetching = true;
    try {
      const calls = await logIpc.gitCommands(lastGitSeq);
      for (const call of calls) {
        lastGitSeq = Math.max(lastGitSeq, call.seq);
        const { level, text } = gitCallRecord(call);
        output.append("git", level, text);
      }
      try {
        sessionStorage.setItem(SEQ_KEY, String(lastGitSeq));
      } catch {
        // Not kept: a reload lists them again.
      }
    } catch {
      // The next git call fetches again.
    } finally {
      fetching = false;
    }
  };
  const scheduleGitFetch = () => {
    gitTimer ??= setTimeout(() => void fetchGitCalls(), GIT_FETCH_DELAY_MS);
  };
  sub.add({
    dispose: () => {
      disposed = true;
      clearTimeout(gitTimer);
    },
  });
  onCall((command, ms, error) => {
    if (!command.startsWith("git_") && !command.startsWith("agent_")) return;
    scheduleGitFetch();
    // A git call that failed before running git (no folder, a bad argument): its own line.
    if (error && command.startsWith("git_") && error.code !== "Git" && error.code !== "GitMissing")
      output.append(
        "git",
        "warn",
        `${command} failed after ${Math.round(ms)} ms: ${error.code}: ${error.message}`,
      );
  });
  sub.add({ dispose: () => onCall(null) });
  // What ran before this page loaded (the folder's first status) is in the journal already.
  if (isTauri()) scheduleGitFetch();

  // Agent: the commands agents (the IDE's, ACP agents, MCP clients) ran, as tool calls.
  sub.add(
    services.events.on("command.executed", (e) => {
      const kind = e.caller.kind;
      if (kind !== "agent" && kind !== "acp" && kind !== "mcp") return;
      const what = `${callerLabel(e.caller)} ran ${e.id} (${e.status}, ${Math.round(e.durationMs)} ms)`;
      output.append(
        "agent",
        e.error && e.status !== "denied" ? "warn" : "info",
        e.error ? `${what}: ${e.error}` : what,
      );
    }),
  );

  const channelInput = s
    .string()
    .describe(
      'A channel id (ide://output lists them): "window", "exthost", "git", "tasks", "agent", "lsp.<server>"',
    );
  const known = (channel: string) => {
    if (!output.has(channel))
      throw new Error(
        `No output channel "${channel}" (${output
          .list()
          .map((c) => c.id)
          .join(", ")}).`,
      );
    return channel;
  };

  sub.add(
    dispatcher.register({
      id: "output.show",
      title: "Show output",
      category: "View",
      description:
        "Opens the Output tab (VS Code's Output panel) on a channel: Window (the session log), Extension host, Git, Tasks, Agent, or a language server's. Without `channel`: the tab as it was (Window the first time); the user picks one when the tab is already open.",
      input: s.object({ channel: channelInput.optional() }),
      effects: [],
      run: async ({ channel }, ctx) => {
        let id = channel;
        if (id === undefined && ctx.caller.kind === "user" && shownChannel() !== null) {
          const picked = await quickInput.pick(
            output.list().map((c) => ({
              id: c.id,
              label: c.label,
              description: `${c.records} line${c.records === 1 ? "" : "s"}`,
            })),
            { placeholder: "Select an output channel" },
          );
          if (!picked) return { channel: null };
          id = picked.id;
        }
        id = known(id ?? shownChannel() ?? "window");
        dock.openView("output", { channel: id }, "bottom", true);
        showChannel(id);
        return { channel: id, lines: output.records(id).length };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "output.clear",
      title: "Clear output",
      category: "View",
      description:
        "Clears an output channel's lines in the Output tab (the shown one by default); its file in the logs folder keeps them.",
      input: s.object({ channel: channelInput.optional() }),
      effects: [],
      run: ({ channel }) => {
        const id = known(channel ?? shownChannel() ?? "window");
        output.clear(id);
        return { channel: id };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "output.read",
      title: "Read output channel",
      category: "View",
      description:
        "An output channel's last lines (time, level, text): the session log's window channel, the extension host, the git command lines the IDE ran, tasks, agents' commands, a language server's log.",
      input: s.object({
        channel: channelInput,
        lines: s.integer({ min: 1, max: 5000 }).describe("How many (default 200)").optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      palette: false,
      run: ({ channel, lines }) => {
        const id = known(channel);
        return { channel: id, label: output.label(id), text: output.text(id, lines ?? 200) };
      },
    }),
  );

  /** The channels' own levels as saved (log.channelLevels). */
  const channelLevels = () => parseChannelLevels(settings.peek("log.channelLevels"));
  /** The level picker: the default (`target` null) or a channel's, with "Default" for one. */
  const pickLevel = async (target: string | null) => {
    const current = target === null ? output.level : output.ownLevel(target);
    const reset =
      target === null
        ? []
        : [
            {
              id: "default",
              label: `Default (${output.level})`,
              ...(current === undefined && { description: "current" }),
            },
          ];
    const picked = await quickInput.pick(
      [
        ...reset,
        ...OUTPUT_LEVELS.map((l) => ({
          id: l,
          label: LEVEL_TITLES[l],
          ...(l === current && { description: "current" }),
        })),
      ],
      {
        placeholder:
          target === null
            ? "Select the default log level"
            : `Select the log level of ${output.label(target) ?? target}`,
      },
    );
    if (!picked) return undefined;
    return picked.id === "default" ? ("default" as const) : parseLevel(picked.id);
  };
  sub.add(
    dispatcher.register({
      id: "log.setLevel",
      title: "Set log level",
      category: "Developer",
      description:
        "Sets what output channels keep (VS Code's Set log level). With `channel`: that channel's own level (log.channelLevels; \"default\" goes back to log.level). Without: the default for every channel without its own, and the session log (log.level). Levels: trace, debug, info, warn, error. Without `level` the user picks (first the default or a channel, without `channel`).",
      input: s.object({
        level: s.enum(LEVEL_OR_DEFAULT).optional(),
        channel: channelInput.optional(),
      }),
      effects: ["write"],
      run: async ({ level, channel }, ctx) => {
        let target: string | null = channel === undefined ? null : known(channel);
        let next: OutputLevel | "default" | undefined = level;
        if (!next && target === null && ctx.caller.kind === "user") {
          // VS Code's first step: the default, or one channel.
          const picked = await quickInput.pick(
            [
              { id: "", label: "Default", description: `log.level: ${output.level}` },
              ...output.list().map((c) => ({
                id: c.id,
                label: c.label,
                description: c.ownLevel ? c.level : `default (${c.level})`,
              })),
            ],
            { placeholder: "Select the default log level or a channel's" },
          );
          if (!picked) return { level: output.level };
          target = picked.id || null;
        }
        if (!next) {
          next = await pickLevel(target);
          if (!next)
            return target === null
              ? { level: output.level }
              : { channel: target, level: output.levelOf(target) };
        }
        if (target === null) {
          if (next === "default") throw new Error('"default" is for a channel: pass `channel`.');
          await dispatcher.execute("settings.set", { key: "log.level", value: next });
          output.setLevel(next);
          return { level: next };
        }
        const levels = channelLevels();
        if (next === "default") delete levels[target];
        else levels[target] = next;
        await dispatcher.execute("settings.set", { key: "log.channelLevels", value: levels });
        output.setChannelLevels(levels);
        return { channel: target, level: output.levelOf(target), ownLevel: next !== "default" };
      },
    }),
  );

  /** Opens the Output tab when it isn't (the filter and wrap commands act on it). */
  const openTab = () => {
    if (outputViewOptions()) return;
    dock.openView("output", { channel: shownChannel() ?? "window" }, "bottom", true);
  };
  sub.add(
    dispatcher.register({
      id: "output.setFilter",
      title: "Filter output",
      category: "View",
      description:
        'Filters the Output tab\'s lines (VS Code\'s Output filter): comma-separated terms; a line shows when it holds one of them and none of the "!" ones ("error, !timeout"), case-insensitive. Empty text shows every line. The tab\'s filter box runs it as the user types.',
      input: s.object({ text: s.string().describe('The filter, e.g. "error, !timeout"') }),
      effects: [],
      palette: false,
      run: ({ text }) => {
        openTab();
        setOutputFilter(text);
        return { filter: text };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "output.toggleWordWrap",
      title: "Toggle output word wrap",
      category: "View",
      description:
        "Turns word wrap in the Output tab on or off (`on`; flips it without). Long lines wrap by default.",
      input: s.object({ on: s.boolean().optional() }),
      effects: [],
      run: ({ on }) => {
        openTab();
        const next = on ?? !(outputViewOptions()?.wordWrap ?? true);
        setOutputWordWrap(next);
        return { wordWrap: next };
      },
    }),
  );
  sub.add(
    services.state.register("ide://output", {
      description:
        "Output channels (VS Code's Output panel): each channel's id, label, line count and log level (its own from log.channelLevels, else the default), the default level (log.level), the channel the Output tab shows, and the tab's filter and word wrap (null while it's closed). output.read gives a channel's lines.",
      get: () => ({
        level: output.level,
        shown: shownChannel(),
        tab: outputViewOptions(),
        channels: output.list(),
      }),
    }),
  );
}
