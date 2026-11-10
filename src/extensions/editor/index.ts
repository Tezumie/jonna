// Built-in Editor: the "editor" dock view over EditorService (Monaco lazy-loaded after the shell
// paints), file commands, `ide://editors` and `ide://editors/active`, and status bar items.
// Tabs persist with the dock; this extension has no layout of its own.

import { matchesWhen } from "../../core/context/index";
import { diffLines, lineMarks, splitLines } from "../../core/diff/index";
import type { TabRef } from "../../core/dock/index";
import { on } from "../../core/dom/index";
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { formatIpc } from "../../core/ipc/process";
import type { Disposable } from "../../core/lifecycle/index";
import type { LanguageClient } from "../../core/lsp/client";
import { INTERACTIVE_EDITOR_ID, NOTEBOOK_EDITOR_ID } from "../../core/notebook/contextKeys";
import { isAbsolute as isAbsolutePath, pathKey, samePath } from "../../core/paths/index";
import { computed, effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import { knownIcon } from "../../ui/Icon";
import type { TabAction } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import { resourceContext } from "../../workbench/extensionFeatures";
import { uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { registerEditorActions } from "./actions";
import { registerEditorAi } from "./ai/index";
import { registerNextEdit } from "./ai/nextEdit";
import { createCodeCheck } from "./codeCheck";
import { registerConflictCommands } from "./conflictCommands";
import { registerDebugMarks } from "./debugMarks";
import { registerDiffToggles } from "./diffSettings";
import { registerDiffView } from "./diffView";
import { registerDiskSync } from "./diskSync";
import type { Diagnostic } from "./engine";
import { engineHost } from "./engine";
import { connectEngineKeybindings } from "./engineKeybindings";
import manifest from "./extension.json";
import { registerEditorExtensionHooks, runWillSave, withExtensionCursor } from "./extensionHooks";
import { registerFileFormatCommands } from "./fileFormat";
import { registerFileRuleCommands } from "./fileRuleCommands";
import { EditorFileRules } from "./fileRules";
import { registerFormatWith } from "./formatWith";
import { registerGutterMarks } from "./gutterMarks";
import { registerHotExit } from "./hotExit";
import { registerInlineDiagnostics } from "./inlineDiagnostics";
import { registerJsonSchemas } from "./jsonSchemas";
import { languageForPath, setContributedLanguages, setFileAssociations } from "./languages";
import { registerMergeView } from "./mergeCommands";
import { registerMultiDiffView } from "./multiDiffView";
import { registerNavigation } from "./navigation";
import { registerNotebooks } from "./notebook/index";
import { notebookOutlineTarget } from "./notebook/navigation";
import { notebookOutlineVersion } from "./notebook/view";
import { registerOutline } from "./outlineView";
import { EditorPositions } from "./positions";
import { registerProblems } from "./problems";
import { registerQuickDiff } from "./quickDiff";
import { registerRenderFile } from "./renderFile";
import { registerRenderMarkdown } from "./renderMarkdown";
import { documentLanguage, documentName, type EditorDocument, EditorService } from "./service";
import { codeActionsOnSave, editorSettings } from "./settings";
import { languageLabel, registerEditorState } from "./state";
import { registerTextCommands } from "./textCommands";
import { editorThemeFromTokens } from "./theme";
import { isUntitled } from "./untitled";
import { registerUntitled } from "./untitledCommands";
import { registerUserSnippets } from "./userSnippets";
import { type EditorView, type EditorViewHost, editorViewDescriptor } from "./view";

export const editorExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, workspace, context, events, dock, theme, settings } = services;
    const editors = sub.add(
      new EditorService(
        () => editorThemeFromTokens(theme),
        // An extension's cursor style (its `type` override, Vim) over editor.cursorStyle.
        (language, path) => withExtensionCursor(editorSettings(settings, language, path), services),
        engineHost(services),
      ),
    );
    // The explorer's activity badge: unsaved files, like VS Code (D134).
    sub.add(
      effect(() => {
        const n = editors.documents.value.filter((d) => d.dirty.value).length;
        services.views.setBadge(
          "explorer.view",
          n,
          n === 1 ? "1 unsaved file" : `${n} unsaved files`,
        );
        return undefined;
      }),
    );
    // Live text of open documents for previews (Markdown, SVG), unsaved edits included.
    sub.add(
      services.documents.setProvider((path) => {
        const doc = editors.find(path);
        if (doc?.kind !== "text") return null;
        return doc.model.peek()?.getText() ?? doc.initialText;
      }),
    );
    sub.add(editors.onDidChangeText((path) => services.documents.fire(path)));
    // Preview → editor scroll sync: the visible editors of that file follow.
    sub.add(
      // Inline notes after a line (git blame, D127): one at a time, on the editors of that file.
      (() => {
        let shown: Disposable[] = [];
        return services.documents.onDidAnnotate((note) => {
          for (const d of shown) d.dispose();
          shown = [];
          if (!note) return;
          for (const view of views.values())
            if (view.doc?.path.peek() === note.path && view.engineEditor)
              shown.push(view.engineEditor.annotateLine(note.line, note.text, "line-annotation"));
        });
      })(),
    );
    sub.add(
      services.documents.onDidRequestScroll(({ path, line }) => {
        for (const view of views.values())
          if (view.doc?.path.peek() === path && view.isVisible)
            view.engineEditor?.scrollToLine(line);
      }),
    );
    sub.add(
      services.documents.setHighlighter(async (code, lang) => {
        const engine = await editors.ensureEngine();
        const id = engine.languageFor(lang);
        return id ? engine.colorize(code, id) : null;
      }),
    );
    // Language servers: attach every running client to the engine (now or once it loads).
    const attached = new Map<LanguageClient, Disposable>();
    sub.add(
      effect(() => {
        const clients = services.languageClients.clients.value;
        editors.whenEngine((engine) => {
          for (const [client, handle] of attached)
            if (!clients.includes(client)) {
              handle.dispose();
              attached.delete(client);
            }
          for (const client of clients)
            if (!attached.has(client)) attached.set(client, engine.attachLanguageClient(client));
        });
        return undefined;
      }),
    );
    sub.add({ dispose: () => attached.forEach((h) => void h.dispose()) });
    // Languages, grammars and snippets from installed extensions (D102).
    sub.add(
      effect(() => {
        const languages = services.contributions.languages.value;
        setContributedLanguages(
          languages.map((l) => ({
            id: l.id,
            extensions: l.extensions,
            ...(l.filenames.length && { filenames: l.filenames }),
            ...(l.filenamePatterns?.length && { filenamePatterns: l.filenamePatterns }),
            ...(l.firstLine && { firstLine: l.firstLine }),
          })),
        );
        editors.whenEngine((engine) => engine.setContributedLanguages(languages));
        return undefined;
      }),
    );
    sub.add(
      effect(() => {
        const grammars = services.contributions.grammars.value;
        editors.whenEngine((engine) => engine.setContributedGrammars(grammars));
        return undefined;
      }),
    );
    sub.add(
      effect(() => {
        const scopes = services.contributions.semanticTokenScopes.value;
        editors.whenEngine((engine) => engine.setSemanticTokenScopes(scopes));
        return undefined;
      }),
    );
    sub.add(
      effect(() => {
        const snippets = services.contributions.snippets.value;
        editors.whenEngine((engine) => engine.setSnippets(snippets));
        return undefined;
      }),
    );
    // Language configurations extensions' code set (D258).
    sub.add(
      effect(() => {
        const list = services.extensionFeatures.languageConfigurations.all.value;
        editors.whenEngine((engine) => engine.setExtensionLanguageConfigurations(list));
        return undefined;
      }),
    );
    const announced = new Set<object>();
    sub.add(
      effect(() => {
        const docs = editors.documents.value;
        // Closed (D256: VS Code's onDidCloseTextDocument, for extensions' language clients).
        const open = new Set<object>(docs);
        for (const doc of [...announced])
          if (!open.has(doc)) {
            announced.delete(doc);
            const path = (doc as { path: { peek(): string } }).path.peek();
            events.emit("documents.didClose", { path });
          }
        for (const doc of docs) {
          if (doc.kind !== "text" || announced.has(doc)) continue;
          announced.add(doc);
          events.emit("documents.didOpen", {
            path: doc.path.peek(),
            languageId: documentLanguage(doc),
          });
        }
        return undefined;
      }),
    );
    sub.add(
      settings.model.onDidChange((keys) => {
        if (keys.some((k) => k.startsWith("editor."))) editors.applySettings();
      }),
    );
    const views = new Map<string, EditorView>();
    // files.associations (D201): detection follows them. Open files whose language came from
    // detection switch to the new one (one picked with Change language mode keeps it), and their
    // language's server starts as for a file just opened.
    setFileAssociations(settings.peek("files.associations"));
    sub.add(
      settings.model.onDidChange((keys) => {
        if (!keys.includes("files.associations")) return;
        const docs = editors.documents.peek().filter((d) => d.kind === "text");
        const before = new Map(docs.map((d) => [d, languageForPath(d.path.peek())]));
        setFileAssociations(settings.peek("files.associations"));
        const engine = editors.loadedEngine;
        for (const [doc, was] of before) {
          const model = doc.model.peek();
          const now = languageForPath(doc.path.peek());
          if (!engine || !model || now === was || model.languageId !== was) continue;
          engine.setLanguage(model, now);
          events.emit("documents.didOpen", { path: doc.path.peek(), languageId: now });
        }
        for (const v of views.values()) v.refreshStatus();
      }),
    );
    /** Mirrors the problems signal (created later) for the editors' file status bars. */
    const diagnostics = signal<readonly Diagnostic[]>([]);
    /** The editor tab commands like Save act on: the focused one, else the most recent. */
    const activeTabId = signal<string | null>(null);
    /** A preview or viewer of a file in focus (Markdown preview…): Outline follows its file. */
    const previewPath = signal<string | null>(null);
    const cursorVersion = signal(0);
    /** The last project formatter that ran (ide://editors/formatter). */
    const lastFormatter = signal<string | null>(null);
    // Where files were scrolled to (D190), per workspace; saved a while after scrolling stops.
    const positions = new EditorPositions();
    let positionsSave: ReturnType<typeof setTimeout> | undefined;
    positions.onChange = () => {
      clearTimeout(positionsSave);
      positionsSave = setTimeout(() => services.persistence.scheduleSave(), 1500);
    };
    sub.add({ dispose: () => clearTimeout(positionsSave) });
    sub.add(
      services.persistence.register("editor.positions", {
        save: () => positions.save(),
        restore: (d) => positions.load(d),
      }),
    );
    // Files from outside the folder the user opened (D190): only these come back into scope
    // when their tabs are restored. A tab opened another way (layout.openView by an agent or
    // an extension) never widens the scope.
    const outsideFiles = new Set<string>();
    sub.add(
      services.persistence.register("editor.outsideFiles", {
        save: () => [...outsideFiles].slice(-100),
        restore: (d) => {
          outsideFiles.clear();
          if (Array.isArray(d))
            for (const p of d) if (typeof p === "string") outsideFiles.add(pathKey(p));
        },
      }),
    );
    sub.add(
      services.workspace.onDidClose(() => {
        positions.load(null);
        outsideFiles.clear();
      }),
    );
    const navigation = registerNavigation(sub, services);
    const fileRules = new EditorFileRules(services);
    const host: EditorViewHost = {
      positions,
      fileRules,
      userOpenedOutside: (path) => outsideFiles.has(pathKey(path)),
      editors,
      views,
      run: (command, input = {}) => void dispatcher.execute(command, input).catch(() => {}),
      onActivity: (view) => {
        // A late focus or cursor event from an editor whose tab is no longer the one shown (a
        // file opened right after it) must not take "active" back from the newer tab — only that
        // case is ignored, so an editor whose group hasn't caught up yet still becomes active.
        const found = dock.findTab(view.tabId);
        const shown = found?.group.activeTabId;
        if (shown && shown !== view.tabId && activeTabId.peek() === shown) return;
        activeTabId.value = view.tabId;
        cursorVersion.value = cursorVersion.peek() + 1;
        // Previews of this file follow its scroll position.
        const editor = view.engineEditor;
        const path = view.doc?.path.peek();
        const cursor = editor?.activeState()?.cursor;
        if (path && cursor) navigation.record(path, cursor.line, cursor.column);
        if (editor && path)
          services.documents.fireScroll(
            path,
            editor.scrollLine(),
            (editor.activeState()?.cursor.line ?? 1) - 1,
          );
      },
      contextMenu: (view, at) => {
        // The breakpoint margin has the debugger's menu (add a conditional breakpoint…).
        const path = view.doc?.path.peek();
        if (at.gutterLine !== undefined && path) {
          services.debugMarks.gutterContextMenu(path, at.gutterLine, at.x, at.y);
          return;
        }
        editorMenu(view, at);
      },
      workspaceUndo: (view, how) => {
        // VS Code: Ctrl+Z in a file that a multi-file operation (replace all, accepted agent
        // edits, a rename with import updates) just wrote asks whether to undo it in every file;
        // after undoing it so, Ctrl+Y there offers to redo it everywhere.
        const doc = view.doc;
        const model = doc?.model.peek();
        const mark = doc?.reloadMark;
        const top = services.history.peek(how);
        if (!doc || !model || !mark || !top || top.kind === "text") return false;
        // The text is exactly what that reload left (same model, nothing typed since)…
        if (mark.model !== model || model.versionId !== mark.versionId) return false;
        // …and the reload came right after the operation ran.
        if (mark.at < top.appliedAt || mark.at - top.appliedAt > 15_000) return false;
        // The reload must come from this entry: nothing moved in the history after it.
        const other = services.history.peek(how === "undo" ? "redo" : "undo");
        if (other && other.appliedAt > top.appliedAt) return false;
        const path = doc.path.peek();
        if (!top.paths.some((p) => samePath(p, path))) return false;
        const files = top.kind === "file" ? 0 : new Set(top.paths.map((p) => p.toLowerCase())).size;
        const verb = how === "undo" ? "Undo" : "Redo";
        return showDialog<"all" | "file" | "cancel">({
          title: `${verb} "${top.label}" in all files?`,
          message: `It changed more than this file. ${verb} it everywhere, or only in this file (the other files stay as they are).`,
          actions: [
            { label: "Cancel", value: "cancel" },
            { label: `${verb} this file`, value: "file" },
            {
              label: files > 1 ? `${verb} in ${files} files` : `${verb} everywhere`,
              value: "all",
              variant: "primary",
            },
          ],
          cancelValue: "cancel",
          defaultValue: "all",
        }).then(async (answer) => {
          if (answer === "file") return false;
          if (answer === "all") await dispatcher.execute(`workspace.${how}`, {}).catch(() => {});
          return true;
        });
      },
      formatDocument: async (view) => {
        // The project's own formatter (Prettier, Biome, Ruff, rustfmt…, D140): only in trusted
        // folders (it runs the project's tools) and for real files.
        const doc = view.doc;
        const model = doc?.model.peek();
        const path = doc?.path.peek();
        if (!doc || !model || !path || isUntitled(path) || path.startsWith("virtual:"))
          return false;
        if (settings.peekAt<boolean | undefined>("editor.projectFormatters", path) === false)
          return false;
        if (services.trust.state.peek() !== "trusted") return false;
        const version = model.versionId;
        let result: Awaited<ReturnType<typeof formatIpc.project>>;
        try {
          result = await formatIpc.project(path, model.getText());
        } catch (err) {
          // A syntax error and the like: say so instead of formatting differently.
          services.notifications.show(
            "warning",
            `Couldn't format: ${err instanceof Error ? err.message : String(err)}`,
          );
          return true;
        }
        if (!result) return false;
        lastFormatter.value = result.formatter;
        // Typed into meanwhile: don't clobber it.
        if (model.versionId !== version) return true;
        const text = model.eol === "\r\n" ? result.text.replace(/\r?\n/g, "\r\n") : result.text;
        model.replaceText(text);
        return true;
      },
      chrome: {
        root: (path) => workspace.folderOf(path)?.path ?? workspace.root.peek(),
        folderName: (path) =>
          workspace.folders.peek().length > 1 ? (workspace.folderOf(path)?.name ?? null) : null,
        listDir: (path) => fsIpc.listDir(path),
        diagnostics: () => diagnostics.value,
        showBreadcrumbs: () => settings.get<boolean>("breadcrumbs.enabled") !== false,
        showFileStatus: () => settings.get<boolean>("editor.fileStatusBar.enabled") !== false,
        symbols: (doc) => editors.loadedEngine?.documentSymbols(doc) ?? Promise.resolve([]),
        run: (command, input = {}) => void dispatcher.execute(command, input).catch(() => {}),
      },
      actionsFor: (path) => {
        const preview = services.viewers.previewFor(path);
        // Extensions' buttons (`menus` "editor/title", D176), after the IDE's own.
        const keys = resourceContext(
          path,
          false,
          (() => {
            const doc = editors.find(path);
            return doc ? documentLanguage(doc) : undefined;
          })(),
        );
        const contributed: TabAction[] = services.extensionFeatures
          .menuItems("editor/title", (when) =>
            matchesWhen(when, (k: string) => (k in keys ? keys[k] : services.context.get(k))),
          )
          .slice(0, 5)
          .map((m) => ({
            icon: knownIcon(m.icon, "circle-dot"),
            // Its own image, the dark one with a dark theme (D262).
            ...((services.theme.theme.peek() === "dark" ? m.iconImageDark : m.iconImage) && {
              iconImage: services.theme.theme.peek() === "dark" ? m.iconImageDark : m.iconImage,
            }),
            title: m.title,
            command: m.command,
            input: { path },
          }));
        const own: TabAction[] = preview
          ? [
              {
                icon: "eye",
                title: "Open preview",
                command: "viewer.togglePreview",
                input: { path, tabId: "$tab" },
              },
              {
                icon: "columns-2",
                title: "Open preview to the side",
                command: "viewer.openPreview",
                input: { path, toSide: true },
              },
            ]
          : [];
        // A notebook's text (an .ipynb's JSON, D204): back to the notebook in this tab.
        if (services.notebooks.typeFor(path))
          own.push({
            icon: "notebook-cells",
            title: "Show as notebook",
            command: "notebook.toggleSource",
            input: { path, tabId: "$tab" },
          });
        return [...own, ...contributed];
      },
    };
    sub.add(dock.views.register(editorViewDescriptor(host)));
    // Extensions' title buttons came or went (one started after the editor opened): redraw the
    // groups' toolbars.
    let menusSeen = services.extensionFeatures.menus.peek();
    sub.add(
      effect(() => {
        const menus = services.extensionFeatures.menus.value;
        if (menus !== menusSeen) {
          menusSeen = menus;
          dock.decorations.value = dock.decorations.peek() + 1;
        }
        return undefined;
      }),
    );

    // Re-theme Monaco whenever the UI theme, accent or imported overrides change.
    sub.add(
      theme.onDidChange(() => void editors.loadedEngine?.applyTheme(editorThemeFromTokens(theme))),
    );

    const activeView = (): EditorView | undefined => {
      const id = activeTabId.peek();
      return id ? views.get(id) : undefined;
    };
    registerUserSnippets(sub, services);
    registerConflictCommands(sub, services, editors, () => activeView()?.doc?.path.peek());
    registerFileFormatCommands(
      sub,
      services,
      editors,
      () => activeView()?.doc?.path.peek(),
      (path) => fileRules.readOnly(path),
    );
    connectEngineKeybindings(sub, services, editors);
    registerDiffToggles(sub, services);
    registerOutline(sub, services, {
      // Cursor moves and switching editor tabs (no cursor event when a tab is just shown).
      version: computed(
        () =>
          `${cursorVersion.value}|${activeTabId.value}|${previewPath.value}|${notebookOutlineVersion.value}|${dock.root.value ? dock.activeTab()?.id : ""}`,
      ),
      active: () => {
        // A notebook (D204): its headings and code cells.
        const notebook = notebookOutlineTarget(services);
        if (notebook) return notebook;
        // A preview in focus: its file's document (open in an editor, or loaded for the preview).
        const preview = previewPath.peek();
        if (preview) {
          const shown = [...views.values()].find((v) => v.doc?.path.peek() === preview);
          const model = (shown?.doc ?? editors.find(preview))?.model.peek();
          if (model)
            return {
              path: preview,
              doc: model,
              line: shown?.engineEditor?.activeState()?.cursor.line ?? 1,
            };
        }
        const view = activeView();
        const doc = view?.doc;
        const model = doc?.model.peek();
        if (!view || !doc || !model) return null;
        return {
          path: doc.path.peek(),
          doc: model,
          line: view.engineEditor?.activeState()?.cursor.line ?? 1,
        };
      },
      symbols: (doc) => editors.loadedEngine?.documentSymbols(doc) ?? Promise.resolve([]),
      sortOrder: () => {
        const v = services.settings.peek<string>("outline.sortOrder");
        return v === "name" || v === "kind" ? v : "position";
      },
      followCursor: () => services.settings.peek<boolean>("outline.followCursor") !== false,
    });
    const quickDiffMenu = registerQuickDiff(sub, services, editors);
    const editorMenu = registerEditorActions(sub, services, activeView, (view, line) => {
      const path = view.doc?.path.peek();
      if (!path) return [];
      // Markdown / SVG: the preview commands, as in VS Code's editor menu.
      const preview = services.viewers.previewFor(path)
        ? [
            {
              label: "Open preview",
              icon: "eye" as const,
              keybinding: services.keyboard.labelFor("viewer.togglePreview"),
              run: () =>
                void dispatcher
                  .execute("viewer.togglePreview", { path, tabId: view.tabId })
                  .catch(() => {}),
            },
            {
              label: "Open preview to the side",
              icon: "columns-2" as const,
              keybinding: services.keyboard.labelFor("viewer.openPreviewToSide"),
              run: () =>
                void dispatcher
                  .execute("viewer.openPreview", { path, toSide: true })
                  .catch(() => {}),
            },
          ]
        : [];
      const ai =
        view.engineEditor &&
        !view.readOnly &&
        services.settings.peek<boolean>("editor.inlineEdit.enabled") === true
          ? [
              {
                label: "Edit with AI…",
                icon: "sparkles" as const,
                keybinding: services.keyboard.labelFor("editor.inlineEdit"),
                run: () => void dispatcher.execute("editor.inlineEdit", {}).catch(() => {}),
              },
            ]
          : [];
      return [...ai, ...preview, ...quickDiffMenu.items(path, line)];
    });
    registerDiffView(sub, services, editors);
    registerMultiDiffView(sub, services, editors);
    registerMergeView(sub, services, editors);
    registerJsonSchemas(sub, services, editors);
    registerRenderFile(sub, services);
    registerRenderMarkdown(sub, services);
    // Jupyter notebooks (D188); kernel completions and hovers join the extensions' providers.
    const notebookFeature = registerNotebooks(sub, services, editors);
    const problems = registerProblems(sub, services, editors);
    registerInlineDiagnostics(sub, services, views, problems);
    registerDebugMarks(sub, services, views, (fn) => editors.whenEngine(fn));
    registerGutterMarks(sub, services, views);
    sub.add(
      effect(() => {
        diagnostics.value = problems.value;
        return undefined;
      }),
    );
    registerDiskSync(sub, services, editors);
    sub.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        const focused = dock.activeTab();
        if (focused?.viewType === "editor") activeTabId.value = focused.id;
        const shownPath =
          focused && focused.viewType !== "editor"
            ? stateField(focused.viewState, "path")
            : undefined;
        previewPath.value =
          typeof shownPath === "string" && !shownPath.startsWith("virtual:") ? shownPath : null;
        if (focused?.viewType !== "editor" && !dock.findTab(activeTabId.peek() ?? "")) {
          activeTabId.value = dock.recentTab((t) => t.viewType === "editor")?.id ?? null;
        }
        context.set("editorFocus", focused?.viewType === "editor");
        return undefined;
      }),
    );

    // A relative path may start with a folder's name in a multi-root workspace (D251).
    const resolve = (path: string) => workspace.resolve(path);

    /**
     * Saves a document: formats it first when editor.formatOnSave is on (an explicit save, through
     * an editor showing it, at most 5 s: a project formatter is a process start), then writes.
     */
    /** The lines changed since the git index (added or modified), or null without a base. */
    const changedLines = async (path: string, doc: EditorDocument) => {
      const original = await services.quickDiff.original(path).catch(() => null);
      const text = doc.model.peek()?.getText();
      if (original === null || text === undefined) return null;
      return lineMarks(diffLines(splitLines(original), splitLines(text)))
        .filter((m) => m.kind !== "deleted")
        .map((m) => ({ startLine: m.startLine, endLine: m.endLine }));
    };
    const saveDoc = async (
      doc: EditorDocument,
      explicit: boolean,
      afterDelay = false,
    ): Promise<void> => {
      // editor.codeActionsOnSave (D200): organize imports, fix all — from the language servers,
      // their edits applied before the write; at most 3 s. Like VS Code, "always" runs on auto
      // saves from focus or window changes, not on afterDelay ones (that's mid-typing).
      // Both per language too (`"[python]": { "editor.formatOnSave": true }`, D201).
      const language = documentLanguage(doc);
      // And per folder in a multi-root workspace (its own settings.json, D251).
      const docPath = doc.path.peek();
      // Extensions' onWillSaveTextDocument edits first (VS Code's order: participants, then save).
      await runWillSave(
        services,
        doc,
        language,
        afterDelay ? "afterDelay" : explicit ? "manual" : "focusOut",
      );
      const kinds = afterDelay
        ? []
        : codeActionsOnSave(
            settings.peekForLanguageAt("editor.codeActionsOnSave", language, docPath),
            explicit,
          );
      const model = doc.model.peek();
      if (kinds.length && model) {
        const engine = await editors.ensureEngine();
        await Promise.race([
          engine.codeActionsOnSave?.(model, kinds).catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      if (explicit && editorSettings(settings, language, docPath).formatOnSave) {
        const view = [...views.values()].find((v) => v.doc === doc && v.engineEditor);
        const editor = view?.engineEditor;
        // editor.formatOnSaveMode (VS Code's, D279): the whole file, or only the lines changed
        // since the git index — "modificationsIfAvailable" formats the whole file when the file
        // has no git base.
        const mode = settings.peekForLanguageAt<string>(
          "editor.formatOnSaveMode",
          language,
          docPath,
        );
        const changed =
          mode === "modifications" || mode === "modificationsIfAvailable"
            ? await changedLines(docPath, doc)
            : null;
        const run =
          changed && editor
            ? editor.formatLines(changed).catch(() => false)
            : mode === "modifications"
              ? null
              : editor?.actionSupported("editor.action.formatDocument")
                ? editor
                    .runAction("editor.action.formatDocument", { silent: true })
                    .catch(() => false)
                : null;
        if (run) await Promise.race([run, new Promise((r) => setTimeout(r, 5000))]);
      }
      // An auto save leaves the lines under a cursor untrimmed (the space just typed stays).
      const keepLines = new Set<number>();
      if (!explicit)
        for (const v of views.values()) {
          const state = v.doc === doc ? v.engineEditor?.activeState() : null;
          for (const sel of state?.selections ?? []) keepLines.add(sel.end.line);
          if (state) keepLines.add(state.cursor.line);
        }
      await editors.save(doc, { keepLines });
    };

    // files.autoSave (VS Code's modes): after a pause, when the editor loses focus, or when the
    // window does. Never for files with a disk conflict, nor untitled ones (saving them asks where,
    // and VS Code never autosaves them either).
    const canAutoSave = (doc: EditorDocument) =>
      doc.kind === "text" &&
      !isUntitled(doc.path.peek()) &&
      doc.dirty.peek() &&
      doc.diskState.peek() === "ok" &&
      !doc.notUtf8 && // saving is refused (it would damage the file); don't retry it on every pause
      doc.model.peek() !== null;
    /** files.autoSave for `doc` (its folder's own in a multi-root workspace, D251). */
    const autoSaveOf = (doc: EditorDocument) =>
      editorSettings(settings, null, doc.path.peek()).autoSave;
    const autoSaveAll = (modes: readonly string[]) => {
      for (const doc of editors.documents.peek())
        if (modes.includes(autoSaveOf(doc).mode) && canAutoSave(doc))
          void saveDoc(doc, false).catch(() => {});
    };
    const autoSaveTimers = new Map<EditorDocument, ReturnType<typeof setTimeout>>();
    sub.add(
      editors.onDidChangeText((path) => {
        const doc = editors.find(path);
        if (!doc) return;
        const { mode, delay } = autoSaveOf(doc);
        if (mode !== "afterDelay") return;
        clearTimeout(autoSaveTimers.get(doc));
        autoSaveTimers.set(
          doc,
          setTimeout(() => {
            autoSaveTimers.delete(doc);
            if (canAutoSave(doc)) void saveDoc(doc, false, true).catch(() => {});
          }, delay),
        );
      }),
    );
    sub.add({
      dispose: () => {
        for (const t of autoSaveTimers.values()) clearTimeout(t);
      },
    });
    sub.add(
      on(window, "blur", () => {
        autoSaveAll(["onWindowChange", "onFocusChange"]);
      }),
    );
    let lastEditorTab: string | null = null;
    sub.add(
      effect(() => {
        dock.focusedGroupId.value;
        dock.root.value;
        const id = activeTabId.value;
        if (lastEditorTab && lastEditorTab !== id) {
          const doc = views.get(lastEditorTab)?.doc;
          if (doc && autoSaveOf(doc).mode === "onFocusChange" && canAutoSave(doc))
            void saveDoc(doc, false).catch(() => {});
        }
        lastEditorTab = id;
        return undefined;
      }),
    );
    const editorTabs = (path?: string): TabRef[] =>
      dock.tabs("editor").filter((t) => {
        const p = (t.viewState as { path?: unknown } | null)?.path;
        return path === undefined || (typeof p === "string" && samePath(p, path));
      });
    const targetDoc = (path: string | undefined) => {
      const doc = path ? editors.find(resolve(path)) : activeView()?.doc;
      if (!doc) throw new Error(path ? `${path} is not open.` : "No editor is open.");
      return doc;
    };
    sub.add(
      dispatcher.register({
        id: "editor.setLanguage",
        title: "Change language mode…",
        category: "View",
        description:
          "Sets the language of an open file (syntax colors, comments, brackets) — `language` is an id such as typescript, json, markdown, shellscript; without it a picker opens. Until the file is reopened.",
        input: s.object({
          path: s.string().optional(),
          language: s.string().describe("Language id, e.g. typescript").optional(),
        }),
        effects: [],
        run: async ({ path, language }) => {
          const doc = targetDoc(path);
          const model = doc.model.peek();
          if (!model) throw new Error("The file isn't loaded yet.");
          const engine = await editors.ensureEngine();
          const known = engine.languages();
          let id = language;
          if (!id) {
            const current = model.languageId;
            const picked = await services.quickInput.pick(
              known
                .map((l) => ({
                  id: l.id,
                  label: languageLabel(l.id),
                  description: l.id === current ? `${l.id} · current` : l.id,
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
              { placeholder: "Select a language" },
            );
            if (!picked) return { language: current };
            id = picked.id;
          }
          const match = known.find(
            (l) => l.id === id || l.aliases.some((a) => a.toLowerCase() === id?.toLowerCase()),
          );
          if (!match) throw new Error(`Unknown language "${id}".`);
          engine.setLanguage(model, match.id);
          for (const v of views.values()) if (v.doc === doc) v.refreshStatus();
          return { language: match.id };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.formatDocument",
        title: "Format document",
        category: "Editor",
        description:
          "Formats the active editor's file: with the project's own formatter when it has one (Prettier or Biome from node_modules, Ruff or Black configured in pyproject.toml, rustfmt, gofmt, clang-format; trusted folders only, editor.projectFormatters), else the language's formatter. The file is changed in the editor, not saved. Returns which formatter ran.",
        input: s.empty(),
        effects: ["write"],
        agent: "discoverable",
        run: async () => {
          const editor = activeView()?.engineEditor;
          if (!editor) throw new Error("No active text editor");
          lastFormatter.value = null;
          const ran = await editor.runAction("editor.action.formatDocument");
          if (!ran) throw new Error("No formatter for this file.");
          return { formatter: lastFormatter.peek() ?? "language" };
        },
      }),
    );
    registerFormatWith(sub, services, activeView, async (languageId) => {
      const known = (await editors.ensureEngine()).languages();
      return known.find((l) => l.id === languageId)?.aliases[0] ?? languageLabel(languageId);
    });
    const closeWelcome = () => {
      for (const t of dock.tabs("welcome")) void dock.closeTab(t.id, true);
    };

    /** Opens (or reveals) an editor tab for `path`. Prefers a tab in the focused group. */
    const openEditor = (path: string, focus: boolean, preview = false, toSide = false): string => {
      const existing = editorTabs(path);
      const focusedGroup = dock.focusedGroup();
      if (toSide && focusedGroup) {
        // VS Code's "Open to the side": the editor group to the right, or a new split.
        const right = dock.neighbor(focusedGroup.id, "right");
        const rightGroup = right ? dock.findGroup(right) : undefined;
        const there = existing.find((t) => rightGroup?.tabs.some((x) => x.id === t.id));
        if (there) {
          dock.activateTab(there.id, focus);
          return there.id;
        }
        const placement =
          right &&
          rightGroup &&
          (rightGroup.tabs.length === 0 || rightGroup.tabs.some(dock.isEditorLike))
            ? { groupId: right }
            : { groupId: focusedGroup.id, split: "right" as const };
        const tabId = dock.openView("editor", { path }, placement, focus);
        const ref = dock.findTab(tabId);
        const tab = ref?.group.tabs[ref.index];
        if (tab) dock.view(tab);
        return tabId;
      }
      const maximized = dock.maximizedGroupId();
      const inGroup = (groupId: string | undefined) =>
        existing.find((t) => dock.findTab(t.id)?.group.id === groupId);
      const inFocused = inGroup(maximized ?? focusedGroup?.id);
      const reuse = inFocused ?? existing[0];
      if (reuse) {
        // Open behind a maximized group: the layout comes back to show it, even when the
        // keyboard focus stays where it is (a single click in the explorer, D398).
        if (maximized && dock.findTab(reuse.id)?.group.id !== maximized)
          dock.toggleMaximize(maximized);
        dock.activateTab(reuse.id, focus);
        if (!preview && reuse.preview) dock.pinTab(reuse.id);
        return reuse.id;
      }
      // New editors go to the focused group if it holds editors, else to the main region.
      // A maximized group takes it instead (dock.openView).
      const editorGroup =
        !maximized && focusedGroup?.tabs.some(dock.isEditorLike) ? focusedGroup.id : undefined;
      const tabId = dock.openView(
        "editor",
        { path },
        editorGroup ? { groupId: editorGroup } : "main",
        focus,
        { preview: preview && settings.peek<boolean>("workbench.editor.enablePreview") !== false },
      );
      const ref = dock.findTab(tabId);
      const tab = ref?.group.tabs[ref.index];
      if (tab) dock.view(tab); // create now so the document is retained before the sweep
      closeWelcome();
      return tabId;
    };

    sub.add(
      dispatcher.register({
        id: "editor.openFile",
        title: "Open file",
        category: "File",
        description:
          "Opens a file in an editor tab, or reveals its tab if already open (prefers the focused group). Files with a default viewer (images) open in it; other binary files show a notice instead of text.",
        input: s.object({
          path: s.string().describe("File path, absolute or relative to the workspace root"),
          preserveFocus: s.boolean().describe("Keep keyboard focus where it is").optional(),
          preview: s
            .boolean()
            .describe("Open as a preview tab that the next preview replaces (single-click)")
            .optional(),
          line: s.integer({ min: 1 }).describe("Line to reveal (1-based)").optional(),
          column: s.integer({ min: 1 }).describe("Column to reveal (1-based)").optional(),
          toSide: s
            .boolean()
            .describe("Open beside the focused group (VS Code's Open to the side)")
            .optional(),
          asText: s
            .boolean()
            .describe("Open in the text editor even if the file has a default viewer (images)")
            .optional(),
        }),
        effects: ["read"],
        agent: "core",
        run: async ({ path: given, preserveFocus, preview, line, column, asText, toSide }, ctx) => {
          // "C:\a\..\b.txt" is C:\b.txt: one spelling for the scope check, the tab and its key.
          const path = isAbsolutePath(given) ? workspace.resolve(given) : given;
          // An untitled document, or a file of an extension's file system (D233: "memfs:/a.txt").
          if (isUntitled(path) || services.extensionFeatures.fileSystems.owns(path)) {
            const doc = await editors.load(path);
            const tabId = openEditor(path, !preserveFocus, false, toSide ?? false);
            return { path, language: documentLanguage(doc), kind: doc.kind, tabId };
          }
          if (!workspace.root.peek() && !isAbsolutePath(path))
            throw new Error("Open a folder first, or pass an absolute path.");
          // A file from outside the open folder (D190), as VS Code allows: the user's own choice
          // (a path they typed, clicked or dropped), that file only. Agents and extensions stay
          // inside the folder.
          const root0 = workspace.root.peek();
          if (
            isAbsolutePath(path) &&
            !workspace.contains(path) &&
            (ctx.caller.kind === "user" || ctx.caller.kind === "test")
          ) {
            await fsIpc.allowFile(path).catch(() => {});
            outsideFiles.delete(pathKey(path));
            outsideFiles.add(pathKey(path));
            services.persistence.scheduleSave();
          }
          // Files with a default viewer (images) open in it, like VS Code.
          const viewer = asText ? undefined : services.viewers.defaultFor(resolve(path));
          if (viewer)
            return dispatcher.execute("viewer.open", {
              path: resolve(path),
              viewer: viewer.id,
              // "Open to the side" works the same for an image as for text (D190).
              ...(toSide !== undefined && { toSide }),
              ...(preserveFocus !== undefined && { preserveFocus }),
              ...(preview !== undefined && { preview }),
            });
          const doc = await editors.load(resolve(path));
          if (workspace.root.peek() !== root0) {
            // The folder changed while reading: don't open the old folder's file in the new one.
            if (doc.refs === 0) {
              editors.retain(doc);
              editors.release(doc);
            }
            throw new Error("The folder changed while the file was opening.");
          }
          const tabId = openEditor(
            doc.path.peek(),
            !preserveFocus,
            preview ?? false,
            toSide ?? false,
          );
          if (line) views.get(tabId)?.revealPosition(line, column ?? 1);
          return { path: doc.path.peek(), language: documentLanguage(doc), kind: doc.kind, tabId };
        },
      }),
    );
    const pathInput = (what: string) =>
      s
        .string()
        .describe(`${what}, absolute or relative to the workspace root (default: active editor)`)
        .optional();
    sub.add(
      dispatcher.register({
        id: "editor.save",
        title: "Save",
        category: "File",
        description:
          "Saves an editor's text to disk (atomic write, keeps the file's line endings).",
        input: s.object({ path: pathInput("File") }),
        effects: ["write"],
        when: "activeEditor",
        run: async ({ path }) => {
          // The active tab is a notebook (VS Code's Save saves it: Jupyter Keymap's S).
          if (!path && dock.activeTab()?.viewType === "notebook" && dispatcher.has("notebook.save"))
            return dispatcher.execute("notebook.save", {});
          const doc = targetDoc(path);
          if (doc.kind !== "text") return { saved: null };
          await saveDoc(doc, true);
          return { saved: doc.path.peek() };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.toggleVimMode",
        title: "Toggle Vim mode",
        category: "Preferences",
        description:
          "Turns Vim key bindings in the editor on or off (editor.vimMode, off by default). Returns the new state.",
        input: s.empty(),
        effects: ["write"],
        run: async () => {
          const on = services.settings.peek<boolean>("editor.vimMode") !== true;
          await services.settings.update("editor.vimMode", on, "user");
          return { vimMode: on };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.saveAll",
        title: "Save all",
        category: "File",
        description: "Saves every document with unsaved changes.",
        input: s.empty(),
        effects: ["write"],
        when: "activeEditor",
        run: async () => {
          const dirty = editors.documents.peek().filter((d) => d.dirty.peek());
          for (const doc of dirty) await saveDoc(doc, true);
          return { saved: dirty.map((d) => d.path.peek()) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.closeTab",
        title: "Close editor",
        category: "View",
        description:
          "Closes the editor tabs showing a file (default: the active editor tab). Unsaved changes ask Save / Don't save / Cancel. `layout.closeTab` closes any tab by id.",
        input: s.object({ path: pathInput("File whose tabs to close") }),
        effects: ["write"],
        when: "activeEditor",
        run: async ({ path }) => {
          const ids = path
            ? editorTabs(resolve(path)).map((t) => t.id)
            : [activeTabId.peek()].filter((x) => x !== null);
          if (ids.length === 0)
            throw new Error(path ? `${path} is not open.` : "No editor is open.");
          for (const id of ids) if (!(await dock.closeTab(id))) return { closed: false };
          return { closed: true };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.closeAll",
        title: "Close all editors",
        category: "View",
        description: "Closes every editor tab in every group, asking once about unsaved changes.",
        input: s.empty(),
        effects: ["write"],
        when: "activeEditor",
        run: async () => {
          if (!(await editors.confirmCloseAll())) return { closed: false };
          for (const t of dock.tabs("editor")) await dock.closeTab(t.id, true);
          return { closed: true };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.focusTab",
        title: "Focus editor tab",
        category: "View",
        description: "Activates and focuses an open editor tab by file path.",
        input: s.object({ path: s.string().describe("Path of an open file") }),
        effects: [],
        when: "activeEditor",
        run: ({ path }) => {
          const target = path.startsWith("virtual:") || uriScheme(path) ? path : resolve(path);
          const tab = editorTabs(target)[0];
          if (!tab) throw new Error(`No open editor for ${path}`);
          dock.activateTab(tab.id, true);
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "editor.openReadOnly",
        title: "Open read-only text",
        category: "View",
        description:
          "Shows generated text (reports, state dumps) in a read-only editor tab that is not restored after a restart. `title` picks the language by extension, e.g. state.json.",
        input: s.object({
          title: s.string({ minLength: 1 }).describe("Tab title, e.g. state.json"),
          content: s.string().describe("Text to show"),
          panel: s
            .boolean()
            .describe("In the bottom panel (with the terminal, problems…) instead of the editors")
            .optional(),
        }),
        effects: [],
        agent: "hidden",
        run: ({ title, content, panel }) => {
          const doc = editors.openVirtual(title, title, content);
          const path = doc.path.peek();
          if (!panel) return void openEditor(path, true);
          // Output-like text (a test run's): with the terminal and problems, like VS Code's panel.
          const existing = editorTabs(path)[0];
          if (existing) dock.activateTab(existing.id, true);
          else dock.openView("editor", { path }, "bottom", true);
        },
      }),
    );

    // Context keys and the window title follow the active editor.
    sub.add(
      effect(() => {
        const id = activeTabId.value;
        dock.decorations.value;
        dock.root.value;
        dock.focusedGroupId.value;
        const view = id ? views.get(id) : undefined;
        const doc = view?.doc;
        services.titleDetail.value = doc
          ? `${doc.dirty.value ? "● " : ""}${documentName(doc)}`
          : null;
        context.setMany({
          // VS Code's editor id for a notebook (extensions test `activeEditor ==
          // 'workbench.editor.notebook'`); true for the IDE's own `when: "activeEditor"`.
          activeEditor: activeEditorId(dock.activeTab()) ?? (!!id && !!dock.findTab(id)),
          activeEditorDirty: doc?.dirty.value ?? false,
          activeEditorLanguage: doc ? documentLanguage(doc) : null,
        });
        return undefined;
      }),
    );

    // Keep tabs in sync with file operations done through commands.
    sub.add(
      events.on("files.didRename", ({ from, to }) => {
        editors.renamed(from, to);
        positions.rename(from, to);
      }),
    );
    sub.add(
      events.on("files.didDelete", ({ path }) => {
        // Clean tabs close; dirty ones stay (saving recreates the file).
        const gone = new Set(editors.under(path).filter((d) => !d.dirty.peek()));
        for (const view of [...views.values()])
          if (view.doc && gone.has(view.doc)) void dock.closeTab(view.tabId, true);
      }),
    );
    sub.add(editors.onDidSave((path) => events.emit("files.didSave", { path })));

    // Folder switch / window close: ask about unsaved work once (the dock then closes the tabs).
    // Hot exit (D120): closing the window keeps unsaved edits that have a backup (restored next
    // time) instead of asking about them; registerHotExit adds that question.
    registerHotExit(sub, services, editors);
    registerUntitled(sub, services, editors);
    sub.add(workspace.onDidClose(() => editors.closeAll()));

    registerEditorState(sub, services, { editors, views, activeView, cursorVersion, activeTabId });
    registerFileRuleCommands(sub, services, {
      rules: fileRules,
      activeView,
      cursorVersion,
      activeTabId,
    });
    registerEditorAi(sub, services, editors, activeView);
    registerNextEdit(sub, services, views, activeView);
    registerTextCommands(sub, services, editors, activeView);
    registerEditorExtensionHooks(sub, services, editors);
    // Third-party extensions' hovers, completions and decorations (D176), once the engine is up.
    sub.add(
      effect(() => {
        const features = services.extensionFeatures.languages.value;
        editors.whenEngine((engine) => engine.setExtensionFeatures([...features, notebookFeature]));
        return undefined;
      }),
    );
    sub.add(
      effect(() => {
        const decorations = services.extensionFeatures.decorations.value;
        editors.whenEngine((engine) => engine.setExtensionDecorations(decorations));
        return undefined;
      }),
    );
    Object.assign(services.codeCheck, createCodeCheck(editors));

    // Warm Monaco up shortly after the shell has painted (not on the startup path).
    const warm = setTimeout(() => void editors.ensureEngine().catch((e) => console.error(e)), 250);
    sub.add({ dispose: () => clearTimeout(warm) });
  },
};

/**
 * VS Code's id of the active editor for the tabs whose `activeEditor` extensions test
 * (`activeEditor == 'workbench.editor.notebook'`, Jupyter's `… == 'workbench.editor.interactive'`);
 * undefined for the rest (the IDE's own `when: "activeEditor"` only tests that there's one).
 */
function activeEditorId(tab: TabRef | undefined): string | undefined {
  if (tab?.viewType !== "notebook") return undefined;
  const path = stateField(tab.viewState, "path");
  return typeof path === "string" && /\.interactive$/i.test(path)
    ? INTERACTIVE_EDITOR_ID
    : NOTEBOOK_EDITOR_ID;
}
