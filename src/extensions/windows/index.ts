// Windows and the command line (D209): what other launches hand to this window — `<cli>
// file:line[:col]` opens at that place, `--diff a b` side by side, `--wait` answers once their
// tabs are closed (git's editor) — "Install shell command in PATH" and its undo, and
// `ide://windows`. A file that doesn't exist yet opens as an untitled editor that saves there
// (VS Code); `--diff` works without a folder open. The folder already open in another window is focused by the explorer's open
// commands (instancesIpc.focusFolder); the last session's windows are reopened at startup
// (main.ts, restore.ts: window.restoreWindows).
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { instancesIpc, type OpenRequest } from "../../core/ipc/instances";
import { isTauri } from "../../core/ipc/invoke";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { startupRestored, whenStartupRestored } from "../../workbench/restoreWindows";
import type { WorkbenchServices } from "../../workbench/services";
import { locationLabel } from "../../workbench/workspace";
import manifest from "./extension.json";

export const windowsExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, dock, state, notifications, settings } = services;
    /** `--wait` requests: their tabs; answered when none is left. */
    const waiting = new Map<number, Set<string>>();
    const tabOf = (result: unknown): string | null => {
      const id =
        result && typeof result === "object" ? (result as { tabId?: unknown }).tabId : undefined;
      return typeof id === "string" ? id : null;
    };
    const finish = (id: number) => {
      waiting.delete(id);
      void instancesIpc.done(id).catch(() => {});
    };
    // A waited-for tab closed (or moved out of this window): the request is done when all are.
    sub.add(
      effect(() => {
        dock.root.value;
        for (const [id, tabs] of [...waiting]) {
          for (const tab of [...tabs]) if (!dock.findTab(tab)) tabs.delete(tab);
          if (!tabs.size) finish(id);
        }
        return undefined;
      }),
    );

    /** Opens what a launch asked for; the user's own action, so files outside the folder too. */
    const open = async (request: OpenRequest): Promise<{ tabs: string[]; errors: string[] }> => {
      const tabs: string[] = [];
      const errors: string[] = [];
      // `--add <folder>` (D251): the folders join this window's workspace first.
      if (request.add?.length) {
        try {
          await dispatcher.execute("workspace.addFolder", { paths: request.add });
        } catch (err) {
          errors.push(`--add: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const file of request.files) {
        try {
          const result = file.missing
            ? await dispatcher.execute("workspace.newUntitledFile", { path: file.path })
            : await dispatcher.execute("editor.openFile", {
                path: file.path,
                ...(file.line && { line: file.line }),
                ...(file.column && { column: file.column }),
              });
          const tab = tabOf(result);
          if (tab) tabs.push(tab);
        } catch (err) {
          errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (request.diff) {
        const [left, right] = request.diff;
        try {
          // Two files the user named on the command line may be outside the folder.
          await Promise.all([fsIpc.allowFile(left), fsIpc.allowFile(right)]).catch(() => {});
          const result = await dispatcher.execute("editor.compareFiles", {
            path: right,
            against: left,
          });
          const tab = tabOf(result);
          if (tab) tabs.push(tab);
        } catch (err) {
          errors.push(`--diff: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length) notifications.show("error", errors.join("\n"), { title: "Command line" });
      return { tabs, errors };
    };
    if (isTauri())
      void instancesIpc
        .listen((request) => {
          void (async () => {
            // The folder (and its layout) first: a tab opened before it's restored would go.
            await whenStartupRestored();
            // A link to the IDE (D255): the extension it names handles it.
            if (request.url)
              void dispatcher
                .execute("extensions.openUri", { uri: request.url })
                .catch((err: unknown) =>
                  notifications.show("error", err instanceof Error ? err.message : String(err), {
                    title: "Link",
                  }),
                );
            const { tabs } = await open(request).catch(() => ({ tabs: [] as string[] }));
            if (!request.wait) return;
            const live = tabs.filter((t) => dock.findTab(t));
            if (!live.length) finish(request.id);
            else waiting.set(request.id, new Set(live));
          })();
        })
        .catch(() => {});

    sub.add(
      dispatcher.register({
        id: "window.openFromCommandLine",
        title: "Open from the command line",
        category: "Window",
        description:
          "Opens what the command line would: files (each at `line` / `column`; `missing`: an untitled editor that saves to that path), or two files side by side (`diff`: [left, right], with or without a folder open). The same as `<cli> file:line:col` or `<cli> --diff a b`.",
        input: s.object({
          files: s
            .array(
              s.object({
                path: s.string(),
                line: s.integer({ min: 1 }).optional(),
                column: s.integer({ min: 1 }).optional(),
                missing: s
                  .boolean()
                  .describe("It doesn't exist yet: an untitled editor that saves there")
                  .optional(),
              }),
            )
            .optional(),
          diff: s.array(s.string()).describe("[left, right]").optional(),
        }),
        effects: ["read"],
        agent: "hidden",
        run: async ({ files, diff }) => {
          const pair = diff && diff.length === 2 ? (diff as [string, string]) : null;
          return open({
            id: 0,
            files: (files ?? []).map((f) => ({
              path: f.path,
              line: f.line ?? null,
              column: f.column ?? null,
              ...(f.missing && { missing: true }),
            })),
            diff: pair,
            wait: false,
          });
        },
      }),
    );

    const describe = (steps: readonly string[], note: string | null) =>
      [...steps.map((step, i) => `${i + 1}. ${step}`), ...(note ? ["", note] : [])].join("\n");
    sub.add(
      dispatcher.register({
        id: "workbench.installShellCommand",
        title: "Install shell command in PATH",
        category: "Shell command",
        description:
          "Makes the IDE's command line (`<name> folder`, `<name> file:line`, `--diff`, `--wait`) available in new terminals. Windows: a .cmd shim in the app's folder, added to the user PATH (never the system PATH); the shim makes terminals wait for `--help`, `--version` and `--wait`. macOS: a link in /usr/local/bin (the system asks for an administrator password when needed; refused, ~/.local/bin). Linux: a link in ~/.local/bin. Says what it will do and asks first; `dryRun` only reports it.",
        input: s.object({ dryRun: s.boolean().describe("Only say what it would do").optional() }),
        effects: ["write"],
        agent: "hidden",
        run: async ({ dryRun }) => {
          const plan = await instancesIpc.shellCommandPlan();
          if (dryRun) return plan;
          const ok = await confirmAction(
            `Install the “${plan.name}” command?`,
            describe(plan.steps, plan.note),
            "Install",
          );
          if (!ok) return { ...plan, cancelled: true };
          const done = await instancesIpc.installShellCommand();
          notifications.show(
            "success",
            `“${done.name}” is installed${done.note ? `. ${done.note}` : "."}`,
            { title: "Shell command" },
          );
          return done;
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "workbench.uninstallShellCommand",
        title: "Uninstall shell command from PATH",
        category: "Shell command",
        description:
          "Removes the command line from PATH: the .cmd shim and its user PATH entry (Windows), or the link in /usr/local/bin (macOS, asking for an administrator password when needed) or ~/.local/bin.",
        input: s.object({ dryRun: s.boolean().optional() }),
        effects: ["write"],
        agent: "hidden",
        run: async ({ dryRun }) => {
          const plan = await instancesIpc.shellCommandPlan();
          if (dryRun) return plan;
          const ok = await confirmAction(
            `Remove the “${plan.name}” command?`,
            `Removes ${plan.path}${services.platform === "windows" ? ` and ${plan.folder} from your user PATH` : ""}.`,
            "Remove",
            true,
          );
          if (!ok) return { ...plan, cancelled: true };
          const done = await instancesIpc.uninstallShellCommand();
          notifications.show("success", `“${done.name}” was removed.`, { title: "Shell command" });
          return done;
        },
      }),
    );

    // The taskbar's jump list (Windows, D229) and the Dock icon's menu (macOS): the recent folders
    // (pinned first, as File → Open recent) and "New window", rewritten when the list changes. A
    // folder the user removed from the jump list leaves the recent list too, as in VS Code. Linux
    // has the desktop file's New window action (src-tauri/linux/main.desktop), nothing to write.
    const { workspace } = services;
    let jumpList: { folders: string[]; applied: boolean; error: string | null } = {
      folders: [],
      applied: false,
      error: null,
    };
    if (isTauri() && (services.platform === "windows" || services.platform === "mac")) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      sub.add({ dispose: () => clearTimeout(timer) });
      const write = async () => {
        const folders = workspace.recentOrdered().slice(0, 10);
        try {
          const result = await instancesIpc.setJumpList({
            folders: folders.map((path) => ({ path, title: locationLabel(path) })),
            category: "Recent folders",
            newWindow: "New window",
          });
          jumpList = { folders, applied: result.applied, error: null };
          for (const path of result.removed) await workspace.removeRecent(path);
        } catch (err) {
          jumpList = { folders, applied: false, error: String(err) };
        }
      };
      sub.add(
        effect(() => {
          workspace.recent.value;
          workspace.pinned.value;
          clearTimeout(timer);
          timer = setTimeout(() => void write(), 500);
          return undefined;
        }),
      );
    }

    sub.add(
      state.register("ide://windows", {
        description:
          "This window and the command line: `<cli> file:line` / `--diff` / `--wait` requests still waiting for their tabs to close, window.restoreWindows, and the taskbar jump list (Windows) or Dock menu (macOS): the recent folders it shows, whether it was written.",
        get: () => ({
          waiting: [...waiting].map(([id, tabs]) => ({ id, tabs: [...tabs] })),
          restoreWindows: settings.peek<string>("window.restoreWindows") ?? "all",
          jumpList,
        }),
      }),
    );
  },
};

/** main.ts has reopened the folder (startup is done): files from the command line open now. */
export function windowsStartupDone(): void {
  startupRestored();
}
