// Output after a restart (D204, VS Code's persistent sessions): each terminal tab's last lines
// are saved with the workspace state ("terminal.outputs", by tab id) and given back to the tab
// restored with that id, which writes them dim above its new shell (persist.ts). Saves follow
// output (a few seconds behind) and finished commands, so a reload or a crash keeps what was
// on screen moments before.
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { TerminalPane } from "./pane";
import {
  DEFAULT_RESTORED_LINES,
  MAX_SAVED_CHARS,
  parseSavedOutputs,
  restoredBanner,
  type SavedOutput,
} from "./persist";
import type { TerminalService } from "./service";
import { isRestoreKeyOf, paneRestoreKey } from "./split";
import type { TerminalView } from "./view";

/** Output keeps the state this far behind at most (a save per few seconds while it streams). */
const SAVE_EVERY_MS = 3000;
/** A restored tab waits this long at most for the workspace state to be read. */
const RESTORE_WAIT_MS = 3000;
/** A restored tab's saved output is dropped this long after it was handed out. */
const FORGET_AFTER_MS = 10_000;

/** What a restored pane gets: the dim banner (a new shell), and the screen as saved. */
export interface TakenOutput {
  banner: string;
  /** The saved screen as it was (drawn as is when the process is taken back, m7.12). */
  text: string;
  /** The output offset that screen reflects. */
  offset?: number;
  /** The entry as saved (an idle new session keeps it, D253). */
  saved: SavedOutput;
}

export interface SessionOutputs {
  /** A restored pane's saved output (by its restore key; and forgets it), or undefined. */
  take(key: string): Promise<TakenOutput | undefined>;
}

export function registerSessionOutputs(
  sub: DisposableStore,
  services: WorkbenchServices,
  terminals: TerminalService,
  tabs: Map<string, TerminalView>,
  /** Hidden terminals' panes by restore key (D217; saved too, m7.12). */
  hiddenPanes: () => readonly (readonly [string, TerminalPane])[] = () => [],
): SessionOutputs {
  const { settings, persistence, dock, workspace } = services;
  const enabled = () => settings.peek<boolean>("terminal.enablePersistentSessions") !== false;
  const lines = () => {
    const n = settings.peek<number>("terminal.persistentSessionScrollback");
    return typeof n === "number" && Number.isFinite(n)
      ? Math.max(0, Math.min(10_000, Math.round(n)))
      : DEFAULT_RESTORED_LINES;
  };
  let saved = new Map<string, SavedOutput>();
  // Read once the workspace state has been (a tab restored with the layout asks before that).
  let ready: () => void = () => {};
  let whenRead = new Promise<void>((r) => (ready = r));
  const fresh = () => {
    whenRead = new Promise<void>((r) => (ready = r));
  };
  sub.add(
    persistence.register("terminal.outputs", {
      save: () => {
        if (!enabled()) return {};
        const out: Record<string, SavedOutput> = {};
        const n = lines();
        // A pane's screen now (with the output offset it reflects), else what it still carries.
        const keep = (key: string, pane: TerminalPane) => {
          const carried = pane.instance ? undefined : saved.get(key);
          const screen = pane.instance ? pane.savedScreen(n) : carried;
          if (!screen?.text) return;
          // A restored session where nothing ran: last session's lines stay as they were, with
          // their time, instead of gaining another "Restored session" line each restart (D253).
          // One saved before D253 (no plain lines, maybe drawn garbled) is replaced instead.
          const before = pane.instance?.restored ? pane.restoredFrom : undefined;
          if (before?.lines && "idle" in screen && screen.idle) {
            out[key] = {
              text: before.text.slice(-MAX_SAVED_CHARS),
              time: before.time,
              ...(before.lines && { lines: before.lines }),
            };
            return;
          }
          // Cut to the cap, the screen no longer matches its offset exactly: no offset then.
          const text = screen.text.slice(-MAX_SAVED_CHARS);
          out[key] = {
            text,
            time: carried?.time ?? Date.now(),
            ...(screen.offset !== undefined && text === screen.text && { offset: screen.offset }),
            ...(screen.lines && { lines: screen.lines.slice(-MAX_SAVED_CHARS) }),
          };
        };
        for (const tab of dock.tabs("terminal")) {
          const view = tabs.get(tab.id);
          // A tab not shown since the restart still has last session's output to carry over,
          // with that session's time (the banner says when it was, not when it was last saved).
          // Each pane of a split tab (D209) under its own key.
          if (!view) {
            for (const [key, entry] of saved)
              if (isRestoreKeyOf(key, tab.id))
                out[key] = { text: entry.text.slice(-MAX_SAVED_CHARS), time: entry.time };
            continue;
          }
          view.panes.forEach((pane, i) => {
            keep(paneRestoreKey(tab.id, i), pane);
          });
        }
        for (const [key, pane] of hiddenPanes()) keep(key, pane);
        return out;
      },
      restore: (data) => {
        saved = parseSavedOutputs(data);
        ready();
      },
    }),
  );
  // No saved outputs in the state at all: the restore above isn't called.
  sub.add(workspace.onDidOpen(() => ready()));
  sub.add(
    workspace.onDidClose(() => {
      saved = new Map();
      fresh();
    }),
  );
  // Started with a folder already open (its state read before this ran): nothing to wait for.
  if (workspace.root.peek() !== null) ready();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    if (timer || !enabled()) return;
    timer = setTimeout(() => {
      timer = undefined;
      persistence.scheduleSave();
    }, SAVE_EVERY_MS);
  };
  const forgets = new Set<ReturnType<typeof setTimeout>>();
  sub.add({
    dispose: () => {
      clearTimeout(timer);
      for (const t of forgets) clearTimeout(t);
    },
  });
  sub.add(terminals.onDidWrite(soon));

  const when = (time: number) => {
    try {
      return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return new Date(time).toISOString();
    }
  };
  return {
    take: async (tabId) => {
      // A folder reopened closes its views and the dock draws the same tabs again at once,
      // before the folder's state is read: a turn later the close is through and the wait is
      // for that read (it's then the one restore below).
      await new Promise((r) => setTimeout(r, 0));
      await Promise.race([whenRead, new Promise((r) => setTimeout(r, RESTORE_WAIT_MS))]);
      const entry = saved.get(tabId);
      // Forgotten a little later, not now: while a folder reopens the dock can start a tab's
      // view twice (the first one is dropped before its shell runs), and both ask.
      if (entry) {
        const forget = setTimeout(() => {
          forgets.delete(forget);
          if (saved.get(tabId) === entry) saved.delete(tabId);
        }, FORGET_AFTER_MS);
        forgets.add(forget);
      }
      if (!entry || !enabled() || lines() === 0) return undefined;
      return {
        banner: restoredBanner(entry, when(entry.time)),
        text: entry.text,
        ...(entry.offset !== undefined && { offset: entry.offset }),
        saved: entry,
      };
    },
  };
}
