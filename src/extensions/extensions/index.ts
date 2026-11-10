// Third-party extensions (PLAN §9, D102; docs/extensions.md). This built-in hosts them: the
// ExtensionManager finds, checks and starts them; each runs in a sandboxed worker (runtime.ts);
// the Extensions sidebar view lists them. `ide://extensions` shows the same for agents.

import apiTypes from "../../api/index.d.ts?raw";
import { output } from "../../core/diagnostics/output";
import type { BuiltinExtension } from "../../core/extensions/index";
import { channelsOf } from "../../core/extensions/rpcOutput";
import { commandPrefix } from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { isTauri } from "../../core/ipc/invoke";
import { dialogIpc } from "../../core/ipc/system";
import { isAbsolute, joinPath, resolveInRoot } from "../../core/paths/index";
import { effect, untracked } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { isInWorkspaceFolders, workspaceFolderName } from "../../workbench/workspaceFolder";
import { registerExtensionActions } from "./actions";
import { registerAuthoringCommands } from "./authoring";
import { registerBisect } from "./bisectCommands";
import { extensionPageDescriptor } from "./details";
import manifest from "./extension.json";
import { registerFromRepo } from "./fromRepo";
import { registerFromVsix } from "./fromVsix";
import { registerHookCommands } from "./hookCommands";
import { registerLogLevelCommands } from "./logLevelCommands";
import { ExtensionManager } from "./manager";
import { registerMediaCommands } from "./media";
import { registerMoreCommands } from "./moreCommands";
import { authorsFor } from "./newAuthors";
import { downloadNode, nodeDownload } from "./nodeRuntime";
import { registerStore } from "./store";
import { storePageDescriptor } from "./storePage";
import manifestTemplate from "./template/extension.json.tpl?raw";
import mainTemplate from "./template/main.js.tpl?raw";
import readmeTemplate from "./template/README.md.tpl?raw";
import {
  contributionSummary,
  ExtensionsView,
  extensionsQuery,
  extensionsSectionShown,
} from "./view";
import { registerWorkbenchProviders } from "./workbenchCommands";

const EXT_NAME = /^[a-z][a-z0-9-]{0,40}$/;
/** Text safe inside a JSON string (the templates put names in extension.json). */
const jsonText = (text: string) => JSON.stringify(text).slice(1, -1);

export const extensionsExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, views, state, extensionGate } = services;
    const manager = sub.add(new ExtensionManager(services));
    extensionGate.authorize = (request) => manager.authorize(request);
    extensionGate.folders = () => manager.records.peek().map((r) => ({ id: r.id, root: r.root }));
    // Which are on (built-in language servers step aside for an extension serving their language).
    sub.add(
      effect(() => {
        const ids = manager.records.value
          .filter((r) => r.status !== "disabled" && r.status !== "invalid")
          .map((r) => r.id.toLowerCase());
        const before = extensionGate.enabledIds.peek();
        if (ids.length !== before.length || ids.some((id, i) => id !== before[i]))
          extensionGate.enabledIds.value = ids;
        return undefined;
      }),
    );
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Extensions", ...c }));
    registerFromRepo(services, manager, register);
    registerFromVsix(services, manager, register);
    registerStore(sub, services, manager, register);
    registerExtensionActions(sub, services, manager, register);
    // The pinned Node.js for extensions' code (D267): downloaded on request, its progress shown.
    register({
      id: "extensions.downloadNode",
      title: "Download Node.js for extensions",
      description:
        "Downloads the IDE's pinned Node.js from nodejs.org (about 30 MB, checked against its published SHA-256) into the app's data folder, for VS Code extensions' code on a computer without Node.js. Node.js on PATH is used first when there is one. Returns the program's path.",
      input: s.object({}),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        const status = await extIpc.nodeStatus();
        if (status.path) return { path: status.path, version: status.version };
        if (!status.available) throw new Error("There's no Node.js download for this platform.");
        return { path: await downloadNode(services), version: status.version };
      },
    });
    sub.add(
      services.statusBar.add({
        id: "extensions.nodeDownload",
        name: "Node.js download",
        alignment: "left",
        priority: 99,
        text: () => (nodeDownload.value ? `$(download) ${nodeDownload.value}` : ""),
      }),
    );
    // Another folder: its "Disable (workspace)" choices apply (D258).
    sub.add(services.workspace.onDidOpen(() => void manager.refresh().catch(() => {})));
    registerBisect(sub, services, manager, register);
    registerWorkbenchProviders(sub, services, register);
    registerHookCommands(sub, services, register);
    const idInput = s.object({ id: s.string().describe("Extension id, e.g. acme.todo") });

    sub.add(services.dock.views.register(extensionPageDescriptor(services, manager)));
    sub.add(services.dock.views.register(storePageDescriptor(services, manager)));
    sub.add(
      views.register({
        id: "extensions.view",
        title: "Extensions",
        icon: "blocks",
        command: "extensions.show",
        actions: [
          { command: "extensions.create", icon: "file-plus", title: "Create extension…" },
          { command: "extensions.loadUnpacked", icon: "folder-plus", title: "Load unpacked…" },
          { command: "extensions.installFromFolder", icon: "plus", title: "Install from folder…" },
          { command: "extensions.reload", icon: "refresh-cw", title: "Reload extensions" },
        ],
        // The view's ⋯ menu: bundled extensions that were uninstalled come back from here (D183).
        menu: () => [
          { label: "Update extensions from the store", command: "extensions.updateFromStore" },
          { label: "Browse themes…", command: "extensions.browseThemes" },
          { label: "Install from VSIX…", command: "extensions.installFromVsix" },
          { label: "Install from GitHub…", command: "extensions.installFromRepo" },
          { label: "Browse official extensions…", command: "extensions.browseOfficial" },
          { label: "Restore bundled extensions", command: "extensions.restoreBundled" },
        ],
        create: (host) => new ExtensionsView(host, services, manager),
      }),
    );
    // Recommended and Open VSX as sections under the installed ones (D258, VS Code's panes):
    // collapsible, resizable, each scrolling on its own; shown when they have something.
    for (const [part, title, order, height] of [
      ["recommended", "Recommended", 1, 240],
      ["store", "Open VSX", 2, 420],
    ] as const)
      sub.add(
        views.register({
          id: `extensions.${part}`,
          title,
          icon: part === "store" ? "cloud-download" : "star",
          sectionOf: "extensions.view",
          sectionOnly: true,
          sectionOrder: order,
          sectionDefault: { collapsed: false, height },
          sectionWhen: () => extensionsSectionShown(services, part),
          create: (host) => new ExtensionsView(host, services, manager, part),
        }),
      );

    register({
      id: "extensions.show",
      title: "Show extensions",
      category: "View",
      description:
        "Shows the Extensions view (installed and unpacked extensions); `query` fills its filter box.",
      input: s.object({ query: s.string().describe("Text for the filter box").optional() }),
      effects: [],
      agent: "hidden",
      run: async ({ query }, ctx) => {
        await ctx.execute("view.show", { id: "extensions.view" });
        if (query !== undefined) extensionsQuery.value = query;
      },
    });
    registerMoreCommands(sub, services, manager);
    registerLogLevelCommands(sub, services);
    // Extensions' webview panels that can come back after a restart (VS Code's serializers): saved
    // with the folder's state; each waits until its extension is loaded (runtimeWebviewPanels.ts).
    const restorable = services.extensionFeatures.restorablePanels;
    sub.add(
      services.persistence.register("extensions.webviewPanels", {
        save: () =>
          restorable.save(
            services.extensionFeatures.webviewPanels.all.peek().flatMap((entry) => {
              const saved = entry.saved?.();
              return saved ? [saved] : [];
            }),
          ),
        restore: (data) => restorable.load(data),
      }),
    );
    sub.add(services.workspace.onDidClose(() => restorable.clear()));
    registerMediaCommands(sub, services, manager);
    registerAuthoringCommands(sub, services, manager);
    register({
      id: "extensions.list",
      title: "List extensions",
      description:
        "Lists third-party extensions: id, version, status (active, disabled, needsPermission, failed, invalid), permissions granted and what each adds. Same as ide://extensions.",
      input: s.empty(),
      effects: ["read"],
      run: () => ({ extensions: snapshot() }),
    });
    /** The folder from input (relative to the workspace's folders, or absolute), else picked. */
    const pick = async (folder: string | undefined, title: string) => {
      if (folder === undefined) return dialogIpc.pickFolder(title);
      const root = services.workspace.root.peek();
      return root && !isAbsolute(folder) ? services.workspace.resolve(folder) : folder;
    };
    register({
      id: "extensions.installFromFolder",
      title: "Install extension from folder…",
      description:
        "Copies an extension folder (with extension.json, or a VS Code extension's package.json) into the installed extensions and asks the user to grant the permissions it asks for.",
      input: s.object({
        folder: s.string().describe("Absolute path of the extension folder").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ folder }, ctx) => {
        const path = await pick(folder, "Install extension from folder");
        if (!path) return { id: null };
        const id = await manager.installFrom(path, ctx.caller.kind !== "test");
        if (!id) return { id: null, cancelled: true };
        // From a folder now: no longer updated from a repository it may have come from.
        await manager.setSource(id, undefined);
        services.notifications.show(
          "success",
          `Installed ${manager.get(id)?.manifest?.displayName ?? id}.`,
        );
        return { id };
      },
    });
    register({
      id: "extensions.create",
      title: "Create extension…",
      description: `Creates a new extension in the open folder (default <folder>/<workspace folder>/extensions/<name>; the first folder of a multi-root workspace) from a template — extension.json, main.js, ide.d.ts (API types) and a README with the rules — and loads it unpacked, so it reloads whenever its files change. Then edit its files to build it: declare commands/views/settings/permissions in extension.json and implement them in main.js (see the README). Check ide://extensions for its status and log.`,
      input: s.object({
        name: s
          .string()
          .describe("Short name: lowercase letters, digits and dashes, e.g. todo-list")
          .optional(),
        displayName: s.string().describe("Shown in the UI, e.g. TODO list").optional(),
        description: s.string().describe("One sentence: what it does").optional(),
        folder: s
          .string()
          .describe(
            "Where to create it (relative to the open folder or absolute; in a multi-root workspace it may start with a folder's name)",
          )
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ name, displayName, description, folder }, ctx) => {
        const root = services.workspace.root.peek();
        if (!root) throw new Error("Open a folder first.");
        const short =
          name ??
          (await services.quickInput.prompt({
            prompt: "Extension name (lowercase, e.g. todo-list)",
            validate: (v) =>
              EXT_NAME.test(v) ? undefined : "Lowercase letters, digits and dashes",
          }));
        if (!short) return { id: null };
        if (!EXT_NAME.test(short))
          throw new Error(`"${short}": use lowercase letters, digits and dashes (e.g. todo-list).`);
        const id = `local.${short}`;
        const title = displayName ?? short.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
        // In the first folder by default; `folder` as the workspace resolves it (D251: it may
        // start with a folder's name).
        const target =
          folder !== undefined
            ? services.workspace.resolve(folder)
            : resolveInRoot(root, `${workspaceFolderName()}/extensions/${short}`);
        // Its authors (D185): the agent that made it and the person, when known.
        const authors = await authorsFor(services, ctx.caller);
        const fill = (template: string) =>
          template
            .replace(/^[ \t]*"authors": __AUTHORS__,\r?\n/m, () =>
              authors.length ? `  "authors": ${JSON.stringify(authors)},\n` : "",
            )
            .replaceAll("__ID__", id)
            .replaceAll("__PREFIX__", commandPrefix(id))
            .replaceAll("__TITLE__", jsonText(title))
            .replaceAll("__DESCRIPTION__", jsonText(description ?? `${title}.`));
        const files: [string, string][] = [
          ["extension.json", fill(manifestTemplate)],
          ["main.js", fill(mainTemplate)],
          ["README.md", fill(readmeTemplate)],
          ["ide.d.ts", apiTypes],
        ];
        if (
          await fsIpc.stat(joinPath(target, "extension.json")).then(
            () => true,
            () => false,
          )
        )
          throw new Error(`${target} already has an extension.json.`);
        for (const [file, text] of files)
          await fsIpc.write(joinPath(target, file), new TextEncoder().encode(text), "extension");
        await manager.loadUnpacked(target, ctx.caller.kind === "user");
        void services.dispatcher
          .execute("editor.openFile", { path: joinPath(target, "main.js") })
          .catch(() => {});
        return { id, folder: target, files: files.map(([f]) => joinPath(target, f)) };
      },
    });
    register({
      id: "extensions.loadUnpacked",
      title: "Load unpacked extension…",
      description:
        "Runs an extension from its folder in place, for development: it reloads whenever its files change.",
      input: s.object({
        folder: s.string().describe("Absolute path of the extension folder").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ folder }, ctx) => {
        const path = await pick(folder, "Load unpacked extension");
        if (!path) return { id: null };
        return { id: await manager.loadUnpacked(path, ctx.caller.kind !== "test") };
      },
    });
    const nameOf = (id: string) => manager.get(id)?.manifest?.displayName ?? id;
    register({
      id: "extensions.uninstall",
      title: "Uninstall extension",
      description:
        "Stops an extension and deletes its files: an installed one's copy, or an unpacked one's folder (to the IDE's trash when it is inside the open folder).",
      input: idInput,
      effects: ["destructive"],
      agent: "hidden",
      confirm: ({ id }) => {
        const r = manager.get(id);
        return r?.dev
          ? `Uninstall ${nameOf(id)} and delete its folder ${r.root}?`
          : `Uninstall ${nameOf(id)}? Its files are deleted.`;
      },
      run: async ({ id }, ctx) => {
        // Those that depend on it (D295, VS Code asks); a test run uninstalls only it.
        const also =
          ctx.caller.kind === "test" ? [] : await manager.askAboutDependents(id, "uninstall");
        if (also === null) return { deleted: false, cancelled: true };
        for (const dependent of also) await manager.uninstall(dependent, true);
        return manager.uninstall(id, true);
      },
    });
    register({
      id: "extensions.restoreBundled",
      title: "Restore bundled extensions",
      description:
        "Brings back the extensions that come with the IDE (TODO tree, Canvas) after they were uninstalled. They come back turned off.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        const ids = await extIpc.restoreBundled();
        await manager.refresh();
        services.notifications.show(
          "info",
          ids.length
            ? `Restored ${ids.map(nameOf).join(", ")} (turned off: enable in the Extensions view).`
            : "Every bundled extension is already installed.",
        );
        return { restored: ids };
      },
    });
    register({
      id: "extensions.remove",
      title: "Remove extension from the list",
      description:
        "Stops an unpacked (development) extension and takes it off the list; its folder stays on disk and can be loaded again.",
      input: idInput,
      effects: ["write"],
      agent: "hidden",
      run: async ({ id }) => {
        if (!manager.get(id)?.dev)
          throw new Error(`${nameOf(id)} is installed, not unpacked: use Uninstall.`);
        return manager.uninstall(id, false);
      },
    });
    register({
      id: "extensions.showDetails",
      title: "Show extension details",
      description: "Opens an extension's page: README, what it adds, permissions and log.",
      input: idInput,
      effects: [],
      agent: "hidden",
      run: ({ id }) => {
        manager.require(id);
        // Like VS Code: one tab per extension, and a page opened from the list is a preview the
        // next one replaces (double-click its tab, or interact with it, to keep it).
        const open = services.dock
          .tabs("extension")
          .find((t) => (t.viewState as { id?: string } | null)?.id === id);
        if (open) services.dock.activateTab(open.id, true);
        else services.dock.openView("extension", { id }, "main", true, { preview: true });
      },
    });
    register({
      id: "extensions.revealFolder",
      title: "Reveal extension folder",
      description:
        "Shows the extension's folder: in the explorer when it is inside the open folder, else in the system file manager.",
      input: s.object({
        id: s.string().describe("Extension id, e.g. acme.todo").optional(),
        folder: s.string().describe("Or an extension folder that isn't loaded").optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ id, folder }, ctx) => {
        const r = id ? manager.require(id) : undefined;
        const dir = r?.root ?? folder;
        if (!dir) throw new Error("Give id or folder.");
        if (services.workspace.contains(dir))
          await ctx.execute("explorer.reveal", {
            path: r ? joinPath(r.root, r.manifestFile) : dir,
          });
        else await ctx.execute("explorer.revealInOs", { path: dir });
      },
    });
    register({
      id: "extensions.loadFromWorkspace",
      title: "Load extension from this folder",
      description: `Loads an extension folder under <workspace folder>/extensions in the open folder (any folder of a multi-root workspace) that isn't loaded yet (see notLoaded in ide://extensions), like Load unpacked. The user is asked to grant its permissions. Prefer extensions.create for new extensions.`,
      input: s.object({
        folder: s
          .string()
          .describe(
            "The extension folder (absolute, or relative to the open folder; in a multi-root workspace it may start with a folder's name)",
          ),
      }),
      effects: ["write"],
      run: async ({ folder }, ctx) => {
        const root = services.workspace.root.peek();
        if (!root) throw new Error("No folder is open.");
        const path = services.workspace.resolve(folder);
        // Any folder's extensions in a multi-root workspace (D251).
        const folders = services.workspace.folderPaths();
        if (
          !(folders.length ? folders : [root]).some((f) =>
            isInWorkspaceFolders(f, path, "extensions"),
          )
        )
          throw new Error(
            folders.length > 1
              ? `Only folders under ${workspaceFolderName()}/extensions (or .vscode's) in the workspace's folders can be loaded this way.`
              : `Only folders under ${workspaceFolderName()}/extensions (or .vscode's) in the open folder can be loaded this way.`,
          );
        const id = await manager.loadUnpacked(path, ctx.caller.kind !== "test");
        return { id, status: manager.get(id)?.status ?? null };
      },
    });
    register({
      id: "extensions.enable",
      title: "Enable extension",
      description: "Enables a disabled extension.",
      input: idInput,
      effects: ["write"],
      agent: "hidden",
      run: ({ id }) => manager.setEnabled(id, true),
    });
    register({
      id: "extensions.disable",
      title: "Disable extension",
      description:
        "Stops an extension and keeps it stopped (it stays installed). When other extensions depend on it, asks whether to disable them too.",
      input: idInput,
      effects: ["write"],
      agent: "hidden",
      run: async ({ id }, ctx) => {
        // Those that depend on it (D295, VS Code asks); a test run disables only it.
        const also =
          ctx.caller.kind === "test" ? [] : await manager.askAboutDependents(id, "disable");
        if (also === null) return { cancelled: true };
        for (const dependent of also) await manager.setEnabled(dependent, false);
        await manager.setEnabled(id, false);
        return { disabled: [id, ...also] };
      },
    });
    register({
      id: "extensions.reload",
      title: "Reload extensions",
      description:
        "Restarts one extension (`id`) or all of them, and looks for added or removed extensions.",
      input: s.object({ id: s.string().describe("Extension id; all when omitted").optional() }),
      effects: [],
      run: ({ id }) => manager.reload(id),
    });
    register({
      id: "extensions.grantPermissions",
      title: "Review extension permissions",
      description:
        "Asks the user (in a dialog) to allow the permissions an extension's manifest lists; it can't run until they do. Agents call this after adding permissions to an extension they build. Test scripts pass `grant` to answer without the dialog.",
      input: s.object({
        id: s.string().describe("Extension id, e.g. local.todo-list"),
        grant: s.boolean().describe("Test scripts only: grant (true) or refuse (false)").optional(),
      }),
      // The dialog is the user's consent; nothing else changes.
      effects: [],
      run: async ({ id, grant }, ctx) => {
        if (grant !== undefined && ctx.caller.kind !== "test")
          throw new Error("Only the user can grant permissions.");
        return { granted: await manager.reviewPermissions(id, grant) };
      },
    });
    register({
      id: "extensions.showLog",
      title: "Show extension log",
      description: "Opens an extension's log (its console output, errors and denied requests).",
      input: idInput,
      effects: [],
      run: async ({ id }, ctx) => {
        const lines = manager
          .logOf(id)
          .map((l) => `${new Date(l.time).toLocaleTimeString()} [${l.level}] ${l.text}`);
        await ctx.execute("editor.openReadOnly", {
          title: `${id}.log`,
          content: lines.length ? lines.join("\n") : "(nothing logged yet)",
        });
      },
    });

    /** What a running extension has registered right now (D176). */
    const liveOf = (id: string) => {
      const f = services.extensionFeatures;
      const mine = <T extends { owner: string }>(list: readonly T[]) =>
        list.filter((x) => x.owner === id);
      return {
        languageProviders: mine(f.languages.peek()).length,
        decorations: mine(f.decorations.peek()).reduce((n, d) => n + d.ranges.length, 0),
        // Decoration types in use (D234) and which provider kinds it registered.
        decorationTypes: new Set(mine(f.decorations.peek()).flatMap((d) => d.custom?.id ?? []))
          .size,
        providerKinds: [
          ...new Set(
            mine(f.languages.peek()).flatMap((l) =>
              Object.keys(l).filter((k) => !["owner", "languages", "schemes"].includes(k)),
            ),
          ),
        ],
        menus: mine(f.menus.peek()).map((m) => `${m.location}: ${m.command}`),
        agents: mine(f.agents.peek()).map((a) => a.name),
        mcpServers: mine(f.mcpServers.peek()).map((m) => m.name),
        providers: mine(f.providers.peek()).map((p) => p.name),
        problems: (services.problems.all.peek().get(`ext:${id}`) ?? []).length,
        // What it plugs into the workbench (D233; ide://extensions/providers has the details).
        terminals: f.terminals.of(id).length,
        taskProviders: f.tasks.of(id).length,
        sourceControls: f.sourceControls.of(id).length,
        debugAdapters: f.debugAdapters.of(id).map((d) => d.type),
        authenticationProviders: f.authentication.of(id).map((p) => p.id),
        fileSystems: f.fileSystems.of(id).map((x) => x.scheme),
        // Pages its code wrote for its views, and what their frames show (D260).
        codePages: manager.codePages(id),
        // Its own Output channels (ide.ui.createOutputChannel): output.show { channel }.
        outputChannels: channelsOf(
          id,
          output.list().map((c) => c.id),
        ),
      };
    };
    const snapshot = () =>
      manager.records.peek().map((r) => ({
        id: r.id,
        name: r.manifest?.displayName ?? r.id,
        version: r.manifest?.version ?? null,
        format: r.manifest?.format ?? null,
        status: r.status,
        running: manager.isRunning(r.id),
        unpacked: r.dev,
        root: r.root,
        ...(r.manifest?.authors.length && { authors: r.manifest.authors.map((a) => a.name) }),
        ...(r.source && { source: r.source }),
        // A development copy replacing the installed version (D189); a bundled one the user changed.
        ...(r.replaces && { replaces: r.replaces.version }),
        ...(r.customized && { customized: true }),
        ...(r.error && { error: r.error }),
        ...(r.warnings.length && { warnings: r.warnings }),
        permissions: {
          asked: r.codeWaiting ?? r.manifest?.permissions ?? [],
          granted: manager.granted(r.id),
        },
        // A VS Code package whose code waits for those permissions (D256): themes and the like work.
        ...(r.codeWaiting && { codeWaiting: true }),
        adds: contributionSummary(r),
        commands: r.manifest?.contributes.commands.map((c) => c.id) ?? [],
        live: liveOf(r.id),
        log: manager.logOf(r.id).slice(-20),
      }));
    sub.add(
      state.register("ide://extensions", {
        description:
          "Third-party extensions: status, permissions, what they add, and their latest log lines. ?id=<id> for one; ?brief=1 for one line each (the default when there are more than 8; ?brief=0 for all in full).",
        get: ({ params }) => {
          // D191: with dozens of extensions the full list (every command, the log) is too much.
          const full = params.id ? snapshot().filter((e) => e.id === params.id) : snapshot();
          if (params.id && !full.length) return { error: `No extension ${params.id}.` };
          const brief =
            !params.id && (params.brief === "1" || (params.brief !== "0" && full.length > 8));
          return {
            extensions: brief
              ? full.map((e) => ({
                  id: e.id,
                  name: e.name,
                  version: e.version,
                  status: e.status,
                  ...(e.unpacked && { unpacked: true }),
                  ...(e.error && { error: e.error }),
                  commands: e.commands.length,
                  errors: e.log.filter((l) => l.level === "error").length,
                }))
              : full,
            ...(brief && {
              note: "Brief: one extension in full with ?id=<id>, all with ?brief=0.",
            }),
            // Folders in <workspace folder>/extensions that aren't loaded: fix `error`, then extensions.loadFromWorkspace.
            notLoaded: manager.workspace.peek(),
          };
        },
      }),
    );

    if (isTauri()) {
      void manager.refresh().catch((err: unknown) => {
        console.warn("extensions unavailable", err);
      });
      // Not trusted (revoked, or another folder opened, D261): code running in Node stops. An
      // empty window counts as trusted (D268): code started there stops when a folder that
      // isn't trusted opens in it (trust reads the folder's decision on open, before this).
      sub.add(
        services.workspace.onDidOpen(() => {
          if (services.trust.state.peek() !== "trusted") void manager.stopUntrustedCode();
        }),
      );
      // An empty window counts as trusted (D268): closing the folder ("unknown" with no folder)
      // mustn't stop the code (D275: Claude Code's activity bar icon, which waits for a context
      // key its code sets once, went away).
      const isTrusted = () =>
        services.trust.state.value === "trusted" || services.workspace.root.value === null;
      let wasTrusted = untracked(isTrusted);
      sub.add(
        effect(() => {
          const trusted = isTrusted();
          if (wasTrusted && !trusted) void manager.stopUntrustedCode();
          // Trusted after it stopped (the user trusted the folder, D273): it starts again.
          if (!wasTrusted && trusted) manager.resumeTrustedCode();
          wasTrusted = trusted;
          return undefined;
        }),
      );
      // Another folder, or folders added or taken out (D251): look for their
      // <workspace folder>/extensions (and restart the slow poll).
      let shown: string | null = null;
      let queued = false;
      sub.add(
        effect(() => {
          const key = JSON.stringify([
            services.workspace.root.value,
            ...services.workspace.folders.value.map((f) => f.path),
          ]);
          const changed = shown !== null && key !== shown;
          shown = key;
          // Once for an open (its folders and root are set one after the other).
          if (changed && !queued) {
            queued = true;
            // A refresh already running read the old folder: run another after it.
            queueMicrotask(() => {
              queued = false;
              manager.workspace.value = [];
              void manager
                .refresh()
                .catch(() => {})
                .then(() => manager.refresh())
                .catch(() => {});
            });
          }
          return undefined;
        }),
      );
    }
  },
};
