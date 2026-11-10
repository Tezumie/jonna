// Built-in language-server client: servers start on demand (documents.didOpen), restart when
// lsp.* settings change, stop when the folder closes. Commands for people (restart, log) and for
// agents (hover, definition, references, symbols, call and type hierarchies — the server's
// answers as plain data). State: ide://lsp, ide://lsp/hierarchy.
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import type { LanguageClient } from "../../core/lsp/client";
import type * as lsp from "../../core/lsp/types";
import { pathToUri, uriToPath } from "../../core/lsp/uri";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import { showDismissible } from "../../workbench/notices";
import type { WorkbenchServices } from "../../workbench/services";
import { languageForPath } from "../editor/languages";
import manifest from "./extension.json";
import { registerHierarchy } from "./hierarchy";
import { installCommand, installProgram, methodsFor, pickInstall } from "./install";
import { LspManager } from "./manager";
import { pickInterpreter, pyrightSettings, venvCandidates } from "./python";
import { serverChanges } from "./serverSettings";
import type { ServerConfig } from "./servers";
import { registerServerSettings } from "./settingsCommands";

export const lspExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, events, workspace, settings, statusBar, state, quickInput } = services;
    const manager = sub.add(new LspManager(services));
    const opened = new Set<string>();

    sub.add(
      events.on("documents.didOpen", ({ languageId }) => {
        opened.add(languageId);
        manager.ensureFor(languageId);
      }),
    );
    // Documents opened before this extension activated (restored tabs).
    void state
      .get("ide://editors")
      .then((snap) => {
        const docs =
          (snap?.value as { documents?: { language: string; kind: string }[] } | null)?.documents ??
          [];
        for (const d of docs)
          if (d.kind === "text" && !opened.has(d.language)) {
            opened.add(d.language);
            manager.ensureFor(d.language);
          }
      })
      .catch(() => {});
    sub.add(
      events.on("files.didSave", ({ path }) => {
        for (const c of services.languageClients.clients.peek()) c.didSave(path);
      }),
    );
    sub.add(
      workspace.onDidClose(() => {
        opened.clear();
        manager.waitingForTrust = false;
        void manager.reset();
      }),
    );
    // A folder added to or taken out of the workspace (D251): the running servers are told.
    sub.add(workspace.onDidChangeFolders(() => manager.foldersChanged()));
    // Trusted now (the dialog, Manage workspace trust): the open files' servers start; trust
    // taken away stops them (they ran the folder's code).
    let wasTrusted = services.trust.trusted;
    sub.add(
      effect(() => {
        const trusted = services.trust.state.value === "trusted";
        if (trusted === wasTrusted) return undefined;
        wasTrusted = trusted;
        if (trusted) {
          manager.waitingForTrust = false;
          for (const id of opened) manager.ensureFor(id);
        } else void manager.stopAll();
        return undefined;
      }),
    );
    // A change to running servers' settings alone reaches them with didChangeConfiguration
    // (VS Code's way, D204); anything else under lsp.* restarts them. New servers start when a
    // file of theirs is open.
    sub.add(
      settings.model.onDidChange((keys) => {
        if (!keys.some((k) => k.startsWith("lsp."))) return;
        const live = manager.liveConfigs();
        const next = manager.configs();
        const { restart, reconfigure } = serverChanges(
          live,
          next.filter((c) => live.some((l) => l.name === c.name)),
        );
        if (!restart.length && keys.every((k) => k === "lsp.servers")) {
          manager.reconfigure(next.filter((c) => reconfigure.includes(c.name)));
          for (const id of opened) manager.ensureFor(id);
          return;
        }
        void manager.stopAll().then(() => {
          for (const id of opened) manager.ensureFor(id);
        });
      }),
    );
    // A plugin's language servers came or went (D375): servers start again with the new set.
    let pluginKey: string | null = null;
    sub.add(
      effect(() => {
        const key = JSON.stringify(services.languageClients.plugins.value);
        if (pluginKey === null || key === pluginKey) {
          pluginKey = key;
          return undefined;
        }
        pluginKey = key;
        void manager.stopAll().then(() => {
          for (const id of opened) manager.ensureFor(id);
        });
        return undefined;
      }),
    );
    // An extension that serves a language itself (Pyrefly, ms-python, rust-analyzer's) turns the
    // built-in server for it off while enabled, and back on when it's gone (yieldTo).
    const toldYield = new Set<string>();
    let yieldKey = "";
    sub.add(
      effect(() => {
        services.extensionGate.enabledIds.value;
        const yielded = manager.yielded();
        const key = yielded.map((y) => `${y.name}>${y.extension}`).join(",");
        if (key === yieldKey) return undefined;
        const first = yieldKey === "" && !key;
        yieldKey = key;
        if (first) return undefined;
        void manager.stopAll().then(() => {
          for (const id of opened) manager.ensureFor(id);
        });
        for (const y of yielded)
          if (!toldYield.has(y.name)) {
            toldYield.add(y.name);
            // Every start says so otherwise: "Don't show again" ends it for good (D344).
            showDismissible(
              services,
              `lsp.yield.${y.name}.${y.extension}`,
              "info",
              `${y.title} is off while the ${y.extension} extension provides its languages. To run both, set lsp.servers.${y.name}.yieldTo to [].`,
            );
          }
        return undefined;
      }),
    );
    registerServerSettings(sub, services, manager);

    const names = () => manager.statuses.peek().map((st) => st.name);
    const pickServer = async (given?: string): Promise<string | undefined> => {
      if (given) return given;
      const list = manager.statuses.peek();
      if (list.length <= 1) return list[0]?.name;
      const picked = await quickInput.pick(
        list.map((st) => ({
          id: st.name,
          label: st.name,
          description: `${st.state} · ${st.languages.join(", ")}`,
        })),
        { placeholder: "Select a language server" },
      );
      return picked?.id;
    };

    sub.add(
      dispatcher.register({
        id: "lsp.list",
        title: "List language servers",
        category: "Language servers",
        description:
          "Known language servers (built-in and from lsp.servers) with their languages and state (running, missing = not installed, failed…).",
        input: s.empty(),
        effects: ["read"],
        agent: "discoverable",
        run: () => listing(),
      }),
    );
    const listing = () => {
      const statuses = new Map(manager.statuses.peek().map((st) => [st.name, st]));
      return manager.configs().map((c) => ({
        name: c.name,
        command: c.command,
        languages: c.languages,
        source: c.source,
        state: statuses.get(c.name)?.state ?? "idle",
        error: statuses.get(c.name)?.error,
      }));
    };
    sub.add(
      dispatcher.register({
        id: "lsp.restart",
        title: "Restart language server",
        category: "Language servers",
        description:
          "Restarts a language server (all running ones if `server` is omitted and there's only one; else asks).",
        input: s.object({ server: s.string().describe("Server name (see lsp.list)").optional() }),
        effects: ["exec"],
        run: async ({ server }) => {
          const name = await pickServer(server);
          const config = manager.configs().find((c) => c.name === name);
          if (!config)
            throw new Error(
              name ? `No language server named ${name}.` : "No language server is running.",
            );
          await manager.start(config);
          return manager.statuses.peek().find((st) => st.name === name) ?? null;
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.stop",
        title: "Stop language server",
        category: "Language servers",
        description:
          "Stops a language server until a file of its language is opened again (or all with `all`).",
        input: s.object({
          server: s.string().describe("Server name").optional(),
          all: s.boolean().describe("Stop every server").optional(),
        }),
        effects: [],
        run: async ({ server, all }) => {
          if (all) await manager.stopAll();
          else {
            const name = await pickServer(server);
            if (name) await manager.stop(name);
          }
          opened.clear();
          return { servers: names() };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.showLog",
        title: "Show language server log",
        category: "Language servers",
        description: "Opens a server's log (its stderr and log messages) in a read-only tab.",
        input: s.object({ server: s.string().describe("Server name").optional() }),
        effects: [],
        run: async ({ server }, ctx) => {
          const name = await pickServer(server);
          if (!name) throw new Error("No language server has run yet.");
          await ctx.execute("editor.openReadOnly", {
            title: `${name}.log`,
            content: manager.log(name).join("\n"),
          });
        },
      }),
    );

    // ---- Queries for agents ----
    const target = s.object({
      path: s.string().describe("File, absolute or workspace-relative"),
      line: s.integer({ min: 1 }).describe("1-based line"),
      column: s.integer({ min: 1 }).describe("1-based column (UTF-16)"),
    });
    /** Runs `fn` with the file open in its server (opened from disk briefly if needed). */
    const withDoc = async <T>(
      path: string,
      fn: (client: LanguageClient, uri: string) => Promise<T>,
    ): Promise<T> => {
      const abs = workspace.resolve(path);
      const languageId = languageForPath(abs);
      manager.ensureFor(languageId);
      let client = manager.clientFor(languageId);
      for (
        let i = 0;
        !client && i < 100 && manager.statuses.peek().some((st) => st.state === "starting");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        client = manager.clientFor(languageId);
      }
      if (!client)
        throw new Error(`No language server is running for ${languageId} files (see lsp.list).`);
      const release = client.isOpen(abs)
        ? () => {}
        : client.openTemporarily(abs, languageId, new TextDecoder().decode(await fsIpc.read(abs)));
      try {
        return await fn(client, pathToUri(abs));
      } finally {
        release();
      }
    };
    const pos = (line: number, column: number) => ({ line: line - 1, character: column - 1 });
    const where = (uri: string, range: lsp.Range) => ({
      path: workspace.relative(uriToPath(uri) ?? uri),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    });
    const locations = (r: lsp.Location | lsp.Location[] | lsp.LocationLink[] | null) =>
      (r ? (Array.isArray(r) ? r : [r]) : []).map((l) =>
        "targetUri" in l ? where(l.targetUri, l.targetSelectionRange) : where(l.uri, l.range),
      );
    sub.add(
      dispatcher.register({
        id: "lsp.hover",
        title: "Language server: hover",
        category: "Language servers",
        description: "The language server's hover text (type, docs) at a position.",
        input: target,
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: ({ path, line, column }) =>
          withDoc(path, async (client, uri) => {
            const h = await client.request<lsp.Hover | null>("textDocument/hover", {
              textDocument: { uri },
              position: pos(line, column),
            });
            const parts = !h ? [] : Array.isArray(h.contents) ? h.contents : [h.contents];
            return { text: parts.map((p) => (typeof p === "string" ? p : p.value)).join("\n\n") };
          }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.codeActions",
        title: "Language server: quick fixes",
        category: "Language servers",
        description:
          "The language server's quick fixes and refactorings at a position (the lightbulb's list), with the diagnostics they fix. Apply one in the editor with Ctrl+. (D199).",
        input: target,
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: ({ path, line, column }) =>
          withDoc(path, async (client, uri) => {
            const at = pos(line, column);
            const r = await client.request<(lsp.CodeAction | lsp.Command)[] | null>(
              "textDocument/codeAction",
              {
                textDocument: { uri },
                range: { start: at, end: at },
                context: { diagnostics: [], triggerKind: 1 },
              },
            );
            return {
              actions: (r ?? []).map((a) => ({
                title: a.title,
                ...("kind" in a && a.kind ? { kind: a.kind } : {}),
                ...("isPreferred" in a && a.isPreferred ? { preferred: true } : {}),
              })),
            };
          }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.definition",
        title: "Language server: definition",
        category: "Language servers",
        description: "Where the symbol at a position is defined (paths, 1-based lines/columns).",
        input: target,
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: ({ path, line, column }) =>
          withDoc(path, async (client, uri) =>
            locations(
              await client.request("textDocument/definition", {
                textDocument: { uri },
                position: pos(line, column),
              }),
            ),
          ),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.references",
        title: "Language server: references",
        category: "Language servers",
        description: "Every reference to the symbol at a position, including its declaration.",
        input: target,
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: ({ path, line, column }) =>
          withDoc(path, async (client, uri) =>
            locations(
              await client.request("textDocument/references", {
                textDocument: { uri },
                position: pos(line, column),
                context: { includeDeclaration: true },
              }),
            ),
          ),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "lsp.symbols",
        title: "Language server: document symbols",
        category: "Language servers",
        description:
          "The outline of a file from its language server: names, kinds and line ranges (nested).",
        input: s.object({ path: s.string().describe("File, absolute or workspace-relative") }),
        effects: ["read"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: ({ path }) =>
          withDoc(path, async (client, uri) => {
            const r = await client.request<(lsp.DocumentSymbol | lsp.SymbolInformation)[] | null>(
              "textDocument/documentSymbol",
              { textDocument: { uri } },
            );
            type Out = {
              name: string;
              kind: number;
              line: number;
              endLine: number;
              children?: Out[];
            };
            const one = (x: lsp.DocumentSymbol | lsp.SymbolInformation): Out =>
              "location" in x
                ? {
                    name: x.name,
                    kind: x.kind,
                    line: x.location.range.start.line + 1,
                    endLine: x.location.range.end.line + 1,
                  }
                : {
                    name: x.name,
                    kind: x.kind,
                    line: x.range.start.line + 1,
                    endLine: x.range.end.line + 1,
                    ...(x.children?.length ? { children: x.children.map(one) } : {}),
                  };
            return (r ?? []).map(one);
          }),
      }),
    );

    // ---- On-demand install (D199) ----
    const prompted = new Set<string>();
    const dontOffer = () => settings.peek<string[]>("lsp.dontOfferInstall") ?? [];
    const titleOf = (c: ServerConfig) => c.title ?? c.name;
    sub.add(
      manager.onMissing((config) => {
        if (config.source === "settings" || !config.install?.length) return;
        if (settings.peek<boolean>("lsp.offerInstall") === false) return;
        if (prompted.has(config.name) || dontOffer().includes(config.name)) return;
        prompted.add(config.name);
        const what =
          config.name === "typescript"
            ? "Types across the whole project (imports, F12 into any file, tsconfig) need typescript-language-server. The built-in service works meanwhile."
            : `${config.description ?? config.languages.join(", ")}: completions, errors and go to definition need ${titleOf(config)}, which isn't installed.`;
        services.notifications.show("info", what, {
          actions: [
            {
              label: "Install",
              run: () =>
                void dispatcher.execute("lsp.install", { server: config.name }).catch(() => {}),
            },
            {
              label: "Don't ask again",
              run: () =>
                void settings
                  .update("lsp.dontOfferInstall", [...dontOffer(), config.name], "user")
                  .catch(() => {}),
            },
          ],
        });
      }),
    );
    // TypeScript 7 (the native port) has no tsserver.js, so typescript-language-server installed
    // beside it can't start (D369): Repair installs it again with TypeScript 6.
    sub.add(
      manager.onFailed(({ config, message }) => {
        if (config.name !== "typescript" || !/valid TypeScript installation/i.test(message)) return;
        if (prompted.has("typescript-repair")) return;
        prompted.add("typescript-repair");
        services.notifications.show(
          "warning",
          "The TypeScript language server can't find a TypeScript it can run: TypeScript 7 no longer includes tsserver. Repair installs it again with TypeScript 6.",
          {
            actions: [
              {
                label: "Repair",
                run: () =>
                  void dispatcher.execute("lsp.install", { server: "typescript" }).catch(() => {}),
              },
            ],
          },
        );
      }),
    );
    manager.ask = (config, message, actions) =>
      new Promise<string | null>((resolve) => {
        let answered = false;
        const done = (v: string | null) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          shown.dispose();
          sub.delete(cleanup);
          resolve(v);
        };
        const shown = services.notifications.show("info", `${titleOf(config)}: ${message}`, {
          actions: actions.map((label) => ({ label, run: () => done(label) })),
        });
        // Unanswered questions don't hold the server forever (the notification goes too).
        const timer = setTimeout(() => done(null), 60_000);
        const cleanup = sub.add({ dispose: () => done(null) });
      });
    sub.add({
      dispose: () => {
        manager.ask = async () => null;
      },
    });
    sub.add(
      dispatcher.register({
        id: "lsp.install",
        title: "Install a language server…",
        category: "Language servers",
        description:
          "Installs a language server (`server`, see lsp.list; asked when omitted) with a package manager you have (npm, pip, go, rustup, dotnet, gem, brew or winget), in a terminal, then starts it. Returns the command run and its exit code.",
        input: s.object({ server: s.string().optional() }),
        effects: ["exec"],
        agent: "hidden",
        run: async ({ server }) => {
          const configs = manager.configs().filter((c) => c.install?.length);
          let name = server;
          if (!name) {
            const statuses = new Map(manager.statuses.peek().map((st) => [st.name, st.state]));
            const picked = await quickInput.pick(
              configs.map((c) => ({
                id: c.name,
                label: titleOf(c),
                description: `${c.description ?? ""}${statuses.get(c.name) === "running" ? " · running" : statuses.get(c.name) === "missing" ? " · not installed" : ""}`,
              })),
              { placeholder: "Install a language server" },
            );
            if (!picked) return null;
            name = picked.id;
          }
          const config = configs.find((c) => c.name === name);
          if (!config) throw new Error(`No installable language server named ${name}.`);
          const platform = services.platform;
          const methods = methodsFor(config.install, platform);
          const installed = await execIpc
            .installed(methods.map((m) => installProgram(m.tool, platform)))
            .catch(() => methods.map(() => false));
          const method = pickInstall(methods, installed);
          if (!method) {
            const needs = [...new Set(methods.map((m) => m.tool))].join(" or ");
            throw new Error(
              needs
                ? `${titleOf(config)} installs with ${needs}, which isn't on this computer. Install one of them first, or install ${config.command} yourself and restart the server.`
                : `Install ${config.command} yourself (see its documentation), then restart the server.`,
            );
          }
          const command = installCommand(method, platform);
          const r = (await dispatcher.execute("terminal.runCommand", {
            command,
            timeoutMs: 15 * 60_000,
          })) as { exitCode?: number | null } | null;
          const exitCode = r?.exitCode ?? null;
          if (exitCode === 0) {
            prompted.delete(config.name);
            // winget and installers add to PATH for new processes only (D200).
            await appIpc.refreshPath().catch(() => false);
            await manager.start(config);
            const state = manager.statuses.peek().find((st) => st.name === config.name)?.state;
            services.notifications.show(
              state === "running" ? "success" : "warning",
              state === "running"
                ? `${titleOf(config)} is installed and running.`
                : `${titleOf(config)} installed, but it didn't start (${state ?? "unknown"}). If it was installed into a folder that isn't on PATH yet, restart the IDE.`,
            );
          }
          return { server: config.name, command, exitCode };
        },
      }),
    );

    // Files changed on disk: servers re-read them (didChangeWatchedFiles).
    sub.add(events.on("files.didCreate", ({ path }) => manager.filesChanged([{ path, type: 1 }])));
    sub.add(events.on("files.didChange", ({ path }) => manager.filesChanged([{ path, type: 2 }])));
    sub.add(events.on("files.didDelete", ({ path }) => manager.filesChanged([{ path, type: 3 }])));
    sub.add(
      events.on("files.didRename", ({ from, to }) =>
        manager.filesChanged([
          { path: from, type: 3 },
          { path: to, type: 1 },
        ]),
      ),
    );

    // ---- Status bar: the active file's language server (D199) ----
    sub.add(
      dispatcher.register({
        id: "lsp.statusAction",
        title: "Language server of the active file",
        category: "Language servers",
        description:
          "The status bar's language server item: installs the active file's server when it's missing, else (for a person) offers its log, its settings and a restart; otherwise shows its log.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        palette: false,
        run: async (_input, ctx) => {
          const a = activeServer();
          if (!a) return null;
          const server = a.config.name;
          if (a.state === "missing") return dispatcher.execute("lsp.install", { server });
          if (ctx.caller.kind !== "user") return dispatcher.execute("lsp.showLog", { server });
          const picked = await quickInput.pick(
            [
              { id: "lsp.showLog", label: "Show log" },
              { id: "lsp.openServerSettings", label: "Settings…" },
              { id: "lsp.restart", label: "Restart" },
            ],
            { placeholder: a.config.title ?? server },
          );
          return picked ? dispatcher.execute(picked.id, { server }) : null;
        },
      }),
    );
    const progressTick = signal(0);
    sub.add(manager.onProgress(() => (progressTick.value = progressTick.peek() + 1)));
    const activeLanguage = (): string | null => {
      services.dock.root.value;
      services.dock.focusedGroupId.value;
      const tab = services.dock.activeTab();
      const path = tab?.viewType === "editor" ? stateField(tab.viewState, "path") : undefined;
      return typeof path === "string" && !path.startsWith("virtual:")
        ? languageForPath(path)
        : null;
    };
    const activeServer = () => {
      const lang = activeLanguage();
      if (!lang) return null;
      const config = manager.configs().find((c) => c.languages.includes(lang));
      if (!config) return null;
      const st = manager.statuses.value.find((x) => x.name === config.name);
      return { config, state: st?.state ?? "idle", error: st?.error };
    };
    sub.add(
      statusBar.add({
        id: "lsp.status",
        name: "Language server",
        alignment: "right",
        priority: 20,
        text: () => {
          progressTick.value;
          const a = activeServer();
          if (!a) return "";
          const title = titleOf(a.config);
          const busy = manager.progress().length > 0;
          switch (a.state) {
            case "running":
              return `$(braces) ${title}${busy ? " …" : ""}`;
            case "starting":
              return `$(braces) ${title} starting…`;
            case "missing":
              return a.config.install?.length ? `$(download) Install ${title}` : "";
            case "failed":
              return `$(triangle-alert) ${title}`;
            default:
              return "";
          }
        },
        tooltip: () => {
          progressTick.value;
          const a = activeServer();
          if (!a) return "";
          const lines = [
            `${titleOf(a.config)} (${a.config.command}): ${a.state}${a.error ? ` — ${a.error}` : ""}`,
            ...manager.progress(),
          ];
          lines.push(a.state === "missing" ? "Click to install it" : "Click for its log");
          return lines.join("\n");
        },
        command: "lsp.statusAction",
      }),
    );

    // The Python interpreter for Pyright (D200): the setting, else the folder's venv. Each folder
    // of a multi-root workspace its own (D251): Pyright asks per folder (`scopeUri`).
    const python = signal<{
      interpreter?: string;
      venvs: string[];
      /** Per folder (multi-root): its interpreter. */
      folders: { path: string; name: string; interpreter?: string }[];
    }>({ venvs: [], folders: [] });
    let pythonSeq = 0;
    const refreshPython = async () => {
      const mine = ++pythonSeq;
      const root = services.workspace.root.peek();
      if (!root) {
        python.value = { venvs: [], folders: [] };
        return;
      }
      const listed = services.workspace.folders.peek();
      const folders = listed.length ? listed : [{ path: root, name: root, index: 0 }];
      const perFolder = await Promise.all(
        folders.map(async (folder) => {
          const found = await Promise.all(
            venvCandidates(folder.path, services.platform).map((p) =>
              fsIpc.stat(p).then(
                (st) => (st.kind === "file" ? p : null),
                () => null,
              ),
            ),
          );
          const venvs = found.filter((p): p is string => !!p);
          const setting = services.settings.peekAt<string>(
            "python.defaultInterpreterPath",
            folder.path,
          );
          // Pyright runs the interpreter to find its packages: one a repository chose (its
          // settings, a committed .venv) only in a trusted folder; otherwise Pyright finds Python
          // on PATH.
          const interpreter = services.trust.trusted
            ? pickInterpreter(setting, folder.path, venvs)
            : undefined;
          return { folder, venvs, interpreter };
        }),
      );
      if (mine !== pythonSeq) return;
      const before = python.peek();
      const next = {
        interpreter: perFolder[0]?.interpreter,
        venvs: perFolder.flatMap((f) => f.venvs),
        folders: perFolder.map((f) => ({
          path: f.folder.path,
          name: f.folder.name,
          ...(f.interpreter !== undefined && { interpreter: f.interpreter }),
        })),
      };
      python.value = next;
      const changed =
        before.interpreter !== next.interpreter ||
        before.folders.length !== next.folders.length ||
        next.folders.some((f, i) => before.folders[i]?.interpreter !== f.interpreter);
      if (changed) manager.configurationChanged("python");
    };
    /** The interpreter for a file or folder Pyright asks about: its folder's, else the first's. */
    const interpreterFor = (scope?: string): string | undefined => {
      const { interpreter, folders } = python.peek();
      if (!scope || folders.length <= 1) return interpreter;
      const own = services.workspace.folderOf(scope);
      return (own && folders.find((f) => f.path === own.path)?.interpreter) ?? interpreter;
    };
    manager.extraSettings = (config, scope) =>
      config.languages.includes("python") ? pyrightSettings(interpreterFor(scope)) : undefined;
    sub.add({
      dispose: () => {
        manager.extraSettings = () => undefined;
      },
    });
    sub.add(
      effect(() => {
        services.workspace.root.value;
        // Every folder's venvs (D251): a folder added later is looked at too.
        services.workspace.folders.value;
        services.settings.version.value;
        services.trust.state.value;
        void refreshPython();
        return undefined;
      }),
    );
    sub.add(
      dispatcher.register({
        id: "python.selectInterpreter",
        title: "Select Python interpreter…",
        category: "Python",
        description:
          "Sets the Python interpreter Pyright resolves imports with (python.defaultInterpreterPath, in the folder's settings): `path` to an interpreter, or picked from the folder's virtual environments (.venv, venv, env). An empty `path` goes back to finding one by itself. Returns the interpreter in use.",
        input: s.object({ path: s.string().optional() }),
        effects: ["write"],
        when: "workspaceOpen",
        run: async ({ path }) => {
          if (!services.trust.trusted)
            throw new Error(
              "Trust this folder first (Manage workspace trust): Pyright runs the interpreter it's given.",
            );
          await refreshPython();
          let chosen = path;
          if (chosen === undefined) {
            const { venvs, interpreter } = python.peek();
            const items = [
              ...venvs.map((p) => ({
                id: p,
                // "api/.venv/…" names its folder in a multi-root workspace (D251).
                label: services.workspace.relative(p),
                description: p === interpreter ? "in use" : "virtual environment",
              })),
              { id: "", label: "Find it by itself", description: "the folder's venv, else PATH" },
              { id: "::enter", label: "Enter interpreter path…", description: "" },
            ];
            const picked = await services.quickInput.pick(items, {
              placeholder: `Python interpreter${interpreter ? ` (now ${interpreter})` : ""}`,
            });
            if (!picked) return { interpreter };
            chosen =
              picked.id === "::enter"
                ? await services.quickInput.prompt({
                    prompt: "Path to a Python interpreter",
                    placeholder:
                      services.platform === "windows" ? "C:\\…\\python.exe" : "/usr/bin/python3",
                  })
                : picked.id;
            if (chosen === undefined) return { interpreter };
          }
          await services.settings.update(
            "python.defaultInterpreterPath",
            chosen.trim() || undefined,
            "workspace",
          );
          await refreshPython();
          return { interpreter: python.peek().interpreter ?? null };
        },
      }),
    );
    sub.add(
      statusBar.add({
        id: "python.interpreter",
        name: "Python interpreter",
        alignment: "right",
        priority: 21,
        text: () => {
          if (activeLanguage() !== "python") return "";
          const { interpreter } = python.value;
          if (!interpreter) return "Python";
          const parts = interpreter.split(/[\\/]/);
          // ".venv/bin/python" → ".venv"; a plain path → the file name.
          const env = parts.length >= 3 ? parts[parts.length - 3] : undefined;
          return env && /^(\.?venv|env)$/.test(env)
            ? `Python (${env})`
            : `Python (${parts.at(-1)})`;
        },
        tooltip: () => python.value.interpreter ?? "Pyright finds Python on PATH. Click to choose.",
        command: "python.selectInterpreter",
      }),
    );

    // Call and type hierarchies: the hierarchy tab, its commands and ide://lsp/hierarchy.
    registerHierarchy(sub, services, manager, {
      withDoc,
      rel: (path) => workspace.relative(path),
      activeLanguage,
    });

    sub.add(
      state.register("ide://lsp", {
        description:
          "Language servers: name, command, languages, source (extension or settings) and state; `yielded`: built-in servers off while an extension serves their languages; `waitingForTrust` when an open file's server waits for the folder to be trusted (they run its code); the Python interpreter (per folder in a multi-root workspace: one server has every folder).",
        get: () => ({
          servers: listing(),
          waitingForTrust: manager.waitingForTrust,
          // Built-in servers off while an extension serves their languages (yieldTo).
          yielded: manager.yielded(),
          python: {
            interpreter: python.peek().interpreter ?? null,
            venvs: python.peek().venvs,
            // Each folder's own (multi-root, D251).
            ...(python.peek().folders.length > 1 && {
              folders: python.peek().folders.map((f) => ({
                folder: f.name,
                interpreter: f.interpreter ?? null,
              })),
            }),
          },
        }),
      }),
    );
  },
};
