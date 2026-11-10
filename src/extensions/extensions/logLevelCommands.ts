// "Set log level…" (VS Code's Developer: Set Log Level): the level of extensions' log channels,
// the default one or a channel's own, kept across sessions (the global state's `logLevels`).
// The extensions' code hears it (runtime.ts → LogOutputChannel.onDidChangeLogLevel,
// env.onDidChangeLogLevel). `ide://extensions/logLevels` shows the levels and the channels.
import {
  DEFAULT_KEY,
  isLogLevel,
  LOG_LEVELS,
  type LogLevelName,
} from "../../core/extensions/logLevels";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

const LABELS: Record<LogLevelName, string> = {
  off: "Off",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warning: "Warning",
  error: "Error",
};

export function registerLogLevelCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput, persistence, state, extensionFeatures } = services;
  const levels = extensionFeatures.logLevels;
  const channels = extensionFeatures.logChannels;

  // Kept across sessions: read from the global state (extensions start before the window loads
  // it), then saved whenever they change.
  let loaded = false;
  let saving = false;
  void persistence
    .refreshGlobal()
    .catch(() => persistence.globalState())
    .then((global) => {
      if (sub.isDisposed) return;
      // Picked meanwhile: what the user picked wins.
      if (!levels.all.peek().size) levels.load(global.logLevels);
      loaded = true;
    });
  sub.add(
    effect(() => {
      levels.all.value;
      if (!loaded || saving) return undefined;
      saving = true;
      queueMicrotask(() => {
        saving = false;
        void persistence.saveGlobal({ logLevels: levels.toJSON() });
      });
      return undefined;
    }),
  );

  /** The channels to pick from: the default, then every extension's log channel open now. */
  const targets = () => [
    { id: DEFAULT_KEY, label: "Default", description: LABELS[levels.default] },
    ...channels.all.peek().map((c) => ({
      id: c.id,
      label: c.name,
      description: `${LABELS[levels.levelOf(c.id)]} · ${c.owner}`,
    })),
  ];

  sub.add(
    dispatcher.register({
      id: "extensions.setLogLevel",
      title: "Set log level…",
      category: "Developer",
      description:
        "Sets what extensions' log channels write (VS Code's Developer: Set Log Level): the default level, or one channel's own (`channel`: its Output channel id, or \"default\"). Levels: off, trace, debug, info, warning, error. Without input, asks. Kept across sessions; extensions hear the change (onDidChangeLogLevel). See ide://extensions/logLevels.",
      input: s.object({
        channel: s.string().optional(),
        level: s.enum([...LOG_LEVELS, "reset"] as const).optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ channel, level }) => {
        let key = channel;
        if (!key) {
          const picked = await quickInput.pick(targets(), { placeholder: "Set log level of" });
          if (!picked) return { changed: false };
          key = picked.id;
        }
        if (key !== DEFAULT_KEY && !channels.all.peek().some((c) => c.id === key))
          throw new Error(`No log channel ${key}. See ide://extensions/logLevels.`);
        let next: LogLevelName | "reset" | undefined = level;
        if (!next) {
          const current = key === DEFAULT_KEY ? levels.default : levels.levelOf(key);
          const own = key !== DEFAULT_KEY && levels.all.peek().has(key);
          const picked = await quickInput.pick(
            [
              ...LOG_LEVELS.map((l) => ({
                id: l as string,
                label: LABELS[l],
                ...(l === current && { description: "Current" }),
              })),
              ...(own ? [{ id: "reset", label: "Same as the default" }] : []),
            ],
            { placeholder: "Log level" },
          );
          if (!picked) return { changed: false };
          next = picked.id as LogLevelName | "reset";
        }
        levels.set(key, next === "reset" || !isLogLevel(next) ? null : next);
        return {
          changed: true,
          channel: key,
          level: key === DEFAULT_KEY ? levels.default : levels.levelOf(key),
        };
      },
    }),
  );

  sub.add(
    state.register("ide://extensions/logLevels", {
      description:
        "Log levels of extensions' log channels: the default, and each log channel open now with its level (its own or the default's). Change with extensions.setLogLevel.",
      get: () => ({
        default: levels.default,
        channels: channels.all.peek().map((c) => ({
          id: c.id,
          name: c.name,
          extension: c.owner,
          level: levels.levelOf(c.id),
          own: levels.all.peek().has(c.id),
        })),
      }),
    }),
  );
}
