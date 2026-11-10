// Claude Code's IDE integration (D204): with `mcp.claudeCode.enabled`, the IDE writes the lock
// file `~/.claude/ide/<port>.lock` that Claude Code's `/ide` looks for and serves the tools it
// calls over a local WebSocket (Rust: src-tauri/src/mcp/ide_ws.rs). Here: the tools —
// getCurrentSelection, getLatestSelection, getOpenEditors, getWorkspaceFolders, getDiagnostics,
// openFile, openDiff (a diff tab; Accept writes the file and answers FILE_SAVED, Reject answers
// DIFF_REJECTED), checkDocumentDirty, saveDocument, close_tab, closeAllDiffTabs — and the
// `selection_changed` notifications. Off by default: it lets a program on this computer that
// has the lock file's token read the open editors.
// D207: getDiagnostics gives each diagnostic's whole range; executeCode runs code in the kernel
// of a Jupyter notebook open here, after the user says yes, in a new cell at the notebook's end
// (so what ran stays visible); "Send selection to Claude Code" (mcp.sendSelectionToClaudeCode)
// sends `at_mentioned` with the file and its lines. The DOM-free parts are core/mcp/ideTools.ts.

import { fsIpc } from "../../core/ipc/fs";
import { isTauri } from "../../core/ipc/invoke";
import { type IdeIntegrationInfo, ideIntegrationIpc, type McpRequest } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathToUri, uriToPath } from "../../core/lsp/uri";
import {
  atMention,
  executeCodeResult,
  type IdeDiagnosticItem,
  ideDiagnostics,
  notebookForCode,
} from "../../core/mcp/ideTools";
import { basename, isAbsolute, samePath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

interface PendingDiff {
  id: string;
  tabName: string;
  path: string;
  contents: string;
  tabId: string | null;
  /** The bridge request it answers: dropped when Claude Code disconnects (D223). */
  callId: number;
  resolve(answer: "accept" | "reject"): void;
}

interface Selection {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown) => text(JSON.stringify(v));

export function registerIdeIntegration(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, state, workspace, statusBar, notifications, dock } = services;
  const running = signal<IdeIntegrationInfo | null>(null);
  const pending = signal<readonly PendingDiff[]>([]);
  let latest: Selection | null = null;
  let nextDiff = 1;
  const root = () => workspace.root.peek();
  /** Every folder of the workspace (D251), the first first. */
  const workspaceFolders = (): { path: string; name: string }[] => {
    const r = root();
    if (!r) return [];
    const list = workspace.folders.peek();
    return list.length
      ? list.map((f) => ({ path: f.path, name: f.name }))
      : [{ path: r, name: basename(r) }];
  };
  const abs = (p: string) => {
    const path = (p.startsWith("file:") ? uriToPath(p) : null) ?? p;
    // A workspace-relative path ("api/src/x.ts" with several folders) as the workspace reads it.
    return root() && !isAbsolute(path) ? workspace.resolve(path) : path;
  };

  const currentSelection = async (): Promise<Selection | null> => {
    const a = (await state
      .get("ide://editors/active")
      .then((x) => x.value)
      .catch(() => null)) as {
      absolutePath?: string | null;
      selectedText?: string;
      selections?: {
        start: { line: number; column: number };
        end: { line: number; column: number };
      }[];
      cursor?: { line: number; column: number };
    } | null;
    if (!a?.absolutePath) return null;
    const sel = a.selections?.[0] ?? (a.cursor ? { start: a.cursor, end: a.cursor } : null);
    if (!sel) return null;
    const start = { line: sel.start.line - 1, character: sel.start.column - 1 };
    const end = { line: sel.end.line - 1, character: sel.end.column - 1 };
    return {
      text: a.selectedText ?? "",
      filePath: a.absolutePath,
      fileUrl: pathToUri(a.absolutePath),
      selection: {
        start,
        end,
        isEmpty: start.line === end.line && start.character === end.character,
      },
    };
  };

  const finishDiff = (id: string, answer: "accept" | "reject") => {
    const diff = pending.peek().find((d) => d.id === id);
    if (!diff) return false;
    pending.value = pending.peek().filter((d) => d !== diff);
    diff.resolve(answer);
    if (diff.tabId) void dock.closeTab(diff.tabId, true);
    return true;
  };

  const tools: Record<
    string,
    (input: Record<string, unknown>, callId: number) => Promise<unknown>
  > = {
    getCurrentSelection: async () => {
      const sel = await currentSelection();
      return json(
        sel ? { success: true, ...sel } : { success: false, message: "No active editor found" },
      );
    },
    getLatestSelection: async () => {
      const sel = (await currentSelection()) ?? latest;
      return json(
        sel ? { success: true, ...sel } : { success: false, message: "No selection available" },
      );
    },
    getOpenEditors: async () => {
      const ed = (await state.get("ide://editors").then((x) => x.value)) as {
        documents: { path: string; language: string; dirty: boolean }[];
      };
      const active = await currentSelection();
      return json({
        tabs: ed.documents.map((d) => {
          const path = abs(d.path);
          return {
            uri: pathToUri(path),
            isActive: !!active && samePath(active.filePath, path),
            label: basename(path),
            languageId: d.language,
            isDirty: d.dirty,
          };
        }),
      });
    },
    getWorkspaceFolders: async () => {
      const r = root() ?? null;
      return json({
        success: true,
        folders: workspaceFolders().map((f) => ({
          name: f.name,
          uri: pathToUri(f.path),
          path: f.path,
        })),
        rootPath: r,
      });
    },
    getDiagnostics: async ({ uri }) => {
      const d = (await state.get("ide://diagnostics", { budget: 50_000 }).then((x) => x.value)) as {
        items: IdeDiagnosticItem[];
      };
      const only = typeof uri === "string" ? abs(uri) : null;
      return json(
        ideDiagnostics(
          d.items.map((i) => ({ ...i, path: abs(i.path) })),
          pathToUri,
          only ? (path) => samePath(only, path) : undefined,
        ),
      );
    },
    executeCode: async ({ code }) => {
      if (typeof code !== "string" || !code.trim()) throw new Error("code is required");
      const nb = (await state.get("ide://notebook").then((x) => x.value)) as {
        open?: string[];
        active?: { path?: string } | null;
      };
      const target = notebookForCode(nb);
      if ("error" in target) return { ...text(target.error), isError: true };
      const path = abs(target.path);
      // Like the VS Code extension: the user says yes to each run.
      for (;;) {
        const firstLine = code.trim().split("\n")[0] ?? "";
        const picked = await services.quickInput.pick(
          [
            {
              id: "run",
              label: "Run it",
              description: `in ${basename(path)}'s kernel, in a new cell`,
            },
            { id: "show", label: "Show the code…" },
            { id: "deny", label: "Don't run", description: "Claude Code is told you said no" },
          ],
          {
            placeholder: `Claude Code wants to run code in ${basename(path)}: ${firstLine.slice(0, 120)}`,
          },
        );
        if (picked?.id === "show") {
          await dispatcher
            .execute("editor.openReadOnly", { title: "Claude Code's code.py", content: code })
            .catch(() => {});
          continue;
        }
        if (picked?.id !== "run")
          return { ...text("The user declined to run the code."), isError: true };
        break;
      }
      const read = (await dispatcher.execute("notebook.read", { path })) as {
        cells: unknown[];
      };
      const cell = (await dispatcher.execute("notebook.insertCell", {
        path,
        index: read.cells.length,
        kind: "code",
        source: code,
      })) as { cellId: string };
      const run = (await dispatcher.execute("notebook.runCell", {
        path,
        cellId: cell.cellId,
        images: true,
      })) as Parameters<typeof executeCodeResult>[0];
      return executeCodeResult(run);
    },
    openFile: async ({ filePath, preview, startText, endText, makeFrontmost }) => {
      if (typeof filePath !== "string") throw new Error("filePath is required");
      const path = abs(filePath);
      await dispatcher.execute(
        "editor.openFile",
        { path, preview: preview === true },
        {
          kind: "mcp",
          client: "claude-code",
        },
      );
      if (typeof startText === "string" && startText) {
        const body = new TextDecoder().decode(await fsIpc.read(path).catch(() => new Uint8Array()));
        const at = body.indexOf(startText);
        if (at >= 0) {
          const stop =
            typeof endText === "string" && endText
              ? body.indexOf(endText, at) + endText.length
              : at + startText.length;
          const lineOf = (i: number) => body.slice(0, i).split("\n").length;
          await dispatcher
            .execute("editor.select", {
              startLine: lineOf(at),
              endLine: lineOf(Math.max(at, stop)),
            })
            .catch(() => {});
        }
      }
      return makeFrontmost === false
        ? json({ success: true, filePath: path })
        : text(`Opened file: ${path}`);
    },
    openDiff: async ({ old_file_path, new_file_path, new_file_contents, tab_name }, callId) => {
      if (typeof new_file_path !== "string" || typeof new_file_contents !== "string")
        throw new Error("new_file_path and new_file_contents are required");
      const path = abs(new_file_path);
      const id = `d${nextDiff++}`;
      const scheme = `claudeDiff:${id}`;
      const content = services.quickDiff.registerContent(scheme, async () => new_file_contents);
      const answer = new Promise<"accept" | "reject">((resolve) => {
        const diff: PendingDiff = {
          id,
          tabName: typeof tab_name === "string" ? tab_name : basename(path),
          path,
          contents: new_file_contents,
          tabId: null,
          callId,
          resolve,
        };
        pending.value = [...pending.peek(), diff];
      });
      try {
        const opened = (await dispatcher
          .execute("editor.openDiff", {
            path: typeof old_file_path === "string" ? abs(old_file_path) : path,
            base: "disk",
            baseLabel: "On disk",
            head: scheme,
            headLabel: `Claude Code: ${typeof tab_name === "string" ? tab_name : "proposed"}`,
          })
          .catch(() => null)) as { tabId?: string } | null;
        const diff = pending.peek().find((d) => d.id === id);
        if (diff && opened?.tabId) diff.tabId = opened.tabId;
        notifications.show("info", `Claude Code proposes changes to ${basename(path)}.`, {
          title: "Claude Code",
          actions: [
            { label: "Accept", run: () => void finishDiff(id, "accept") },
            { label: "Reject", run: () => void finishDiff(id, "reject") },
          ],
        });
        const result = await answer;
        if (result === "reject") return text("DIFF_REJECTED");
        await fsIpc.write(path, new TextEncoder().encode(new_file_contents));
        return {
          content: [
            { type: "text", text: "FILE_SAVED" },
            { type: "text", text: new_file_contents },
          ],
        };
      } finally {
        content.dispose();
        pending.value = pending.peek().filter((d) => d.id !== id);
      }
    },
    checkDocumentDirty: async ({ filePath }) => {
      if (typeof filePath !== "string") throw new Error("filePath is required");
      const ed = (await state.get("ide://editors").then((x) => x.value)) as {
        documents: { path: string; dirty: boolean }[];
      };
      const doc = ed.documents.find((d) => samePath(abs(d.path), abs(filePath)));
      return json(
        doc
          ? {
              success: true,
              filePath,
              isDirty: doc.dirty,
              isUntitled: doc.path.startsWith("untitled"),
            }
          : { success: false, message: `Document not open: ${filePath}` },
      );
    },
    saveDocument: async ({ filePath }) => {
      if (typeof filePath !== "string") throw new Error("filePath is required");
      try {
        await dispatcher.execute("editor.save", { path: abs(filePath) });
        return json({
          success: true,
          filePath,
          saved: true,
          message: "Document saved successfully",
        });
      } catch (err) {
        return json({
          success: false,
          filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    close_tab: async ({ tab_name }) => {
      for (const d of pending.peek().filter((x) => x.tabName === tab_name))
        finishDiff(d.id, "reject");
      return text("TAB_CLOSED");
    },
    closeAllDiffTabs: async () => {
      const all = [...pending.peek()];
      for (const d of all) finishDiff(d.id, "reject");
      return text(`CLOSED_${all.length}_DIFF_TABS`);
    },
  };

  const handle = (request: McpRequest) => {
    // Claude Code went away mid-call (D223): its diff tab closes, nothing is written.
    if (request.kind === "cancel") {
      for (const d of pending.peek().filter((x) => x.callId === request.id)) {
        finishDiff(d.id, "reject");
        notifications.show(
          "info",
          `Claude Code disconnected: its proposed change to ${basename(d.path)} was dropped.`,
        );
      }
      return;
    }
    if (request.kind !== "call") {
      void ideIntegrationIpc.respond(request.id, null, "not supported").catch(() => {});
      return;
    }
    const tool = tools[request.command];
    const input = (
      request.input && typeof request.input === "object" ? request.input : {}
    ) as Record<string, unknown>;
    const work = tool
      ? tool(input, request.id)
      : Promise.reject(new Error(`unknown tool ${request.command}`));
    const fail = (err: unknown) =>
      ideIntegrationIpc.respond(request.id, null, err instanceof Error ? err.message : String(err));
    // A result that can't be sent still answers, with why: Claude Code would wait for it.
    void work
      .then((result) => ideIntegrationIpc.respond(request.id, result).catch(fail), fail)
      .catch(() => {});
  };

  // Claude Code finds the window by any of its folders (its lock file lists them all, D251).
  const folders = () => workspaceFolders().map((f) => f.path);
  /**
   * The start in flight, shared: the setting's effect and mcp.claudeCodeIntegration both start
   * it (two starts at once each wrote a lock file), and a stop must wait for it, or a server
   * that finished starting after the setting went off kept running.
   */
  let starting: Promise<void> | null = null;
  let disposed = false;
  const wanted = () => !disposed && settings.peek<boolean>("mcp.claudeCode.enabled") === true;
  const start = (): Promise<void> => {
    if (!isTauri() || running.peek()) return Promise.resolve();
    if (starting) return starting;
    const attempt = (async () => {
      try {
        running.value = await ideIntegrationIpc.start(handle, folders(), product.nameLong);
      } catch (err) {
        notifications.show(
          "error",
          `Claude Code integration didn't start: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        starting = null;
      }
      // Turned off (or disposed) while it started: the stop that ran then found nothing yet.
      if (!wanted()) await stop();
    })();
    starting = attempt;
    return attempt;
  };
  const stop = async () => {
    if (starting) {
      await starting;
      if (wanted()) return;
    }
    if (!running.peek()) return;
    await ideIntegrationIpc.stop().catch(() => {});
    running.value = null;
    for (const d of [...pending.peek()]) finishDiff(d.id, "reject");
  };
  sub.add(
    effect(() => {
      void (settings.get<boolean>("mcp.claudeCode.enabled") === true ? start() : stop());
      return undefined;
    }),
  );
  sub.add({
    dispose: () => {
      disposed = true;
      void stop();
    },
  });
  const updateFolders = () => {
    if (running.peek()) void ideIntegrationIpc.update(folders()).catch(() => {});
  };
  sub.add(workspace.onDidOpen(updateFolders));
  sub.add(workspace.onDidClose(updateFolders));
  sub.add(workspace.onDidChangeFolders(updateFolders));

  // selection_changed: what's selected, when it changes (checked twice a second while on).
  let lastKey = "";
  const poll = setInterval(() => {
    if (!running.peek()) return;
    void currentSelection().then((sel) => {
      if (!sel) return;
      const key = JSON.stringify([sel.filePath, sel.selection]);
      if (key === lastKey) return;
      lastKey = key;
      latest = sel;
      void ideIntegrationIpc.notify("selection_changed", sel).catch(() => {});
    });
  }, 500);
  sub.add({ dispose: () => clearInterval(poll) });
  const infoPoll = setInterval(() => {
    if (running.peek())
      void ideIntegrationIpc
        .info()
        .then((i) => {
          if (i && i.connected !== running.peek()?.connected) running.value = i;
        })
        .catch(() => {});
  }, 3000);
  sub.add({ dispose: () => clearInterval(infoPoll) });

  sub.add(
    statusBar.add({
      id: "mcp.claudeCode",
      name: "Claude Code connection",
      alignment: "right",
      priority: 9,
      text: () =>
        pending.value.length
          ? `$(file-diff) Claude Code: ${pending.value.length} diff${pending.value.length === 1 ? "" : "s"}`
          : running.value
            ? `$(radio) Claude Code${running.value.connected ? "" : " (waiting)"}`
            : "",
      tooltip: () =>
        pending.value.length
          ? "Claude Code proposes changes: click to accept or reject"
          : running.value
            ? `Claude Code can connect with /ide (lock file ${running.value.lockFile})`
            : "",
      command: "mcp.reviewIdeDiff",
    }),
  );

  const pickDiff = (id?: string) =>
    id ? pending.peek().find((d) => d.id === id) : pending.peek()[0];
  sub.add(
    dispatcher.register({
      id: "mcp.acceptIdeDiff",
      title: "Accept Claude Code's diff",
      category: "MCP",
      description:
        "Accepts the diff Claude Code opened (the oldest, or `id`): the file is written and Claude Code is told FILE_SAVED.",
      input: s.object({ id: s.string().optional() }),
      effects: ["write"],
      agent: "hidden",
      run: ({ id }) => {
        const d = pickDiff(id);
        if (!d) throw new Error("No diff from Claude Code is waiting.");
        finishDiff(d.id, "accept");
        return { accepted: d.path };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "mcp.rejectIdeDiff",
      title: "Reject Claude Code's diff",
      category: "MCP",
      description:
        "Rejects the diff Claude Code opened (the oldest, or `id`): nothing is written; Claude Code is told DIFF_REJECTED.",
      input: s.object({ id: s.string().optional() }),
      effects: [],
      agent: "hidden",
      run: ({ id }) => {
        const d = pickDiff(id);
        if (!d) throw new Error("No diff from Claude Code is waiting.");
        finishDiff(d.id, "reject");
        return { rejected: d.path };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "mcp.reviewIdeDiff",
      title: "Claude Code integration",
      category: "MCP",
      description:
        "Accept or reject a diff Claude Code waits on, or show how Claude Code connects.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async () => {
        const d = pending.peek()[0];
        if (!d) {
          const info = running.peek();
          notifications.show(
            "info",
            info
              ? `Claude Code finds the IDE with /ide (lock file ${info.lockFile}); ${info.connected} connected.`
              : "The Claude Code integration is off (mcp.claudeCode.enabled).",
          );
          return null;
        }
        const picked = await services.quickInput.pick(
          [
            { id: "accept", label: "Accept", description: `write ${basename(d.path)}` },
            { id: "reject", label: "Reject" },
          ],
          { placeholder: `Claude Code's changes to ${basename(d.path)}` },
        );
        if (picked) finishDiff(d.id, picked.id === "accept" ? "accept" : "reject");
        return { answered: picked?.id ?? null };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "mcp.claudeCodeIntegration",
      title: "Claude Code integration (/ide)",
      category: "MCP",
      description:
        "Turns Claude Code's IDE integration on or off (mcp.claudeCode.enabled): a lock file in ~/.claude/ide lets Claude Code's /ide find the IDE, read the selection, open editors and diagnostics, and show its edits as diffs here.",
      input: s.object({ enabled: s.boolean().optional() }),
      effects: [],
      agent: "hidden",
      run: async ({ enabled }, ctx) => {
        // It opens a local server that reads the editors: the user's choice, like the setting
        // (settings.set refuses mcp.claudeCode.enabled to agents; this writes it directly).
        if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test")
          throw new Error("Only you can turn on Claude Code's IDE integration.");
        const on = enabled ?? settings.peek<boolean>("mcp.claudeCode.enabled") !== true;
        await settings.update("mcp.claudeCode.enabled", on, "user");
        if (on) await start();
        else await stop();
        return { enabled: on, ...(running.peek() && { port: running.peek()?.port }) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "mcp.sendSelectionToClaudeCode",
      title: "Send selection to Claude Code",
      category: "MCP",
      description:
        "Sends the active editor's file and selected lines to the connected Claude Code sessions as an @-mention (`at_mentioned`; Claude Code's Insert @-mention). `path`, `startLine` and `endLine` (1-based) name another range. Needs the Claude Code integration on (mcp.claudeCode.enabled) and Claude Code connected with /ide.",
      input: s.object({
        path: s.string().optional(),
        startLine: s.integer({ min: 1 }).optional(),
        endLine: s.integer({ min: 1 }).optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ path, startLine, endLine }) => {
        if (!running.peek())
          throw new Error(
            "The Claude Code integration is off: turn it on with mcp.claudeCodeIntegration.",
          );
        let params: ReturnType<typeof atMention>;
        const sel = await currentSelection();
        // The editor menu passes its file (D222): with no lines, that editor's selection.
        const own = path && startLine === undefined && sel && samePath(sel.filePath, abs(path));
        if (path && !own) {
          const start = startLine ?? 1;
          params = atMention(abs(path), start, endLine ?? start, 2);
        } else {
          if (!sel) throw new Error("No file editor is active: open the file to send.");
          params = atMention(
            sel.filePath,
            sel.selection.start.line + 1,
            sel.selection.end.line + 1,
            sel.selection.end.character + 1,
          );
        }
        const sent = await ideIntegrationIpc.notify("at_mentioned", params);
        if (!sent)
          notifications.show(
            "info",
            "No Claude Code session is connected: run /ide in Claude Code, then send again.",
          );
        else
          notifications.show(
            "info",
            `Sent ${basename(params.filePath)}:${params.lineStart + 1}-${params.lineEnd + 1} to Claude Code.`,
          );
        return { sent, ...params };
      },
    }),
  );
  // The editor's menu and key (D222; the VS Code extension's Insert @-mention): only while the
  // integration runs (claudeCodeIdeRunning).
  sub.add(
    effect(() => {
      services.context.set("claudeCodeIdeRunning", running.value !== null);
      return undefined;
    }),
  );
  sub.add({ dispose: () => services.context.set("claudeCodeIdeRunning", undefined) });
  sub.add(
    services.extensionFeatures.addMenus([
      {
        owner: "builtin.mcp",
        location: "editor/context",
        command: "mcp.sendSelectionToClaudeCode",
        title: "Send selection to Claude Code",
        icon: "at-sign",
        when: "claudeCodeIdeRunning",
      },
    ]),
  );
  sub.add(
    state.register("ide://mcp/claudeCode", {
      description:
        "Claude Code's IDE integration (D204): whether it's on, its port and lock file, how many Claude Code sessions are connected, and the diffs waiting for an answer.",
      get: async () => {
        const info = running.peek() ? await ideIntegrationIpc.info().catch(() => null) : null;
        return {
          enabled: settings.peek<boolean>("mcp.claudeCode.enabled") === true,
          running: !!info,
          ...(info && { port: info.port, lockFile: info.lockFile, connected: info.connected }),
          pendingDiffs: pending.peek().map((d) => ({ id: d.id, path: d.path, tabName: d.tabName })),
        };
      },
    }),
  );
}
