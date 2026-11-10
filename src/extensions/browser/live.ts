// "Go Live" (Live Server's status bar button): previews the active HTML file — or the folder's
// index.html — with live reload, beside the editor. While a preview of a workspace file is open
// the item shows its port and stops the preview when clicked. In a multi-root workspace (D251)
// each folder has its entry point: the active file's folder's first, or `folder`'s; several
// folders with one: pick.
import { fsIpc, indexIpc } from "../../core/ipc/fs";
import { joinPath, resolveInRoot, samePath } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { activeFilePath } from "../editor/folderChoice";
import type { BrowserHost } from "./view";

type Register = WorkbenchServices["dispatcher"]["register"];

const HTML = /\.html?$/i;
const ENTRY_POINTS = ["index.html", "public/index.html", "src/index.html", "dist/index.html"];

export function registerLive(register: Register, host: BrowserHost): { dispose(): void } {
  const { services } = host;
  const { dock, dispatcher, workspace } = services;

  /** Browser tabs showing workspace files (live previews). */
  const liveTabs = () =>
    dock.tabs("browser").filter((t) => typeof stateField(t.viewState, "path") === "string");

  const isFile = (path: string) =>
    fsIpc
      .stat(path)
      .then((st) => st.kind === "file")
      .catch(() => false);
  const pickFile = async (files: readonly string[]): Promise<string> => {
    const picked = await services.quickInput.pick(
      files.map((p) => ({ id: p, label: workspace.relative(p), icon: "globe" as const })),
      { placeholder: "HTML file to preview" },
    );
    if (picked) return picked.id;
    throw new Error("No file chosen.");
  };
  /** The folders to look in: `folder` (a path or name), else every one, the active file's first. */
  const lookIn = (folder: string | undefined): string[] => {
    const folders = workspace.folders.peek();
    const root = workspace.root.peek();
    if (folder) {
      const found = folders.find((f) => samePath(f.path, folder) || f.name === folder);
      if (!found) throw new Error(`${folder} isn't a folder of this workspace.`);
      return [found.path];
    }
    if (folders.length <= 1) return root ? [root] : [];
    const near = activeFilePath(services);
    const own = near ? workspace.folderOf(near)?.path : undefined;
    const paths = folders.map((f) => f.path);
    return own ? [own, ...paths.filter((p) => p !== own)] : paths;
  };

  const entryFile = async (folder?: string): Promise<string> => {
    const roots = lookIn(folder);
    if (!roots.length) throw new Error("Open a folder first.");
    if (!folder) {
      const editor = dock.recentTab((t) => t.viewType === "editor");
      const path = editor ? stateField(editor.viewState, "path") : undefined;
      if (typeof path === "string" && HTML.test(path)) return path;
    }
    // Each folder's entry point; the active file's folder's wins, else several are a choice.
    const entries: string[] = [];
    for (const root of roots)
      for (const candidate of ENTRY_POINTS) {
        const abs = resolveInRoot(root, candidate);
        if (await isFile(abs)) {
          entries.push(abs);
          break;
        }
      }
    const near = activeFilePath(services);
    const ownFolder = near ? workspace.folderOf(near)?.path : undefined;
    const first = entries[0];
    if (first && (entries.length === 1 || (ownFolder && samePath(roots[0] ?? "", ownFolder))))
      return first;
    if (entries.length > 1) return pickFile(entries);
    // Any HTML file in the folders: the only one, or pick.
    const found = await indexIpc.query(".html", 50).catch(() => null);
    const files = (found?.items ?? [])
      // A non-first folder's item carries its folder (`root`); the first folder's path is relative to it.
      .map((i) => (i.root ? joinPath(i.root, i.path) : workspace.resolve(i.path)))
      .filter((p) => HTML.test(p))
      // `folder` given: only its files.
      .filter((p) => !folder || roots.some((r) => samePath(workspace.folderOf(p)?.path ?? "", r)));
    if (files.length === 1 && files[0]) return files[0];
    if (files.length > 1) return pickFile(files);
    throw new Error("No HTML file to preview: open one in the editor, or add an index.html.");
  };

  register({
    id: "browser.goLive",
    title: "Go Live",
    description:
      "Previews an HTML file with live reload (Live Server): `path`, else the active editor's HTML file, else the folder's index.html (in a multi-root workspace: `folder`'s, else the active file's folder's, else asks). Opens beside the editor; edits show as you type and CSS changes apply without a reload.",
    input: s.object({
      path: s.string().describe("HTML file in the workspace").optional(),
      folder: s
        .string()
        .describe("Multi-root workspaces: the folder (path or name) whose index.html to preview")
        .optional(),
    }),
    effects: ["network"],
    run: async ({ path, folder }) => {
      const root = workspace.root.peek();
      const file = path && root ? workspace.resolve(path) : await entryFile(folder);
      // Beside the editor when one is focused; otherwise in the editor area (not next to a
      // terminal panel).
      const toSide = dock.activeTab()?.viewType === "editor";
      return dispatcher.execute("browser.open", { path: file, toSide });
    },
  });
  register({
    id: "browser.toggleLive",
    title: "Toggle live preview",
    description: "Go Live, or stop the live preview if one is open (the status bar item).",
    input: s.empty(),
    effects: ["network"],
    palette: false,
    run: () => dispatcher.execute(liveTabs().length ? "browser.stopLive" : "browser.goLive", {}),
  });
  register({
    id: "browser.stopLive",
    title: "Stop live preview",
    description: "Closes the browser tabs previewing workspace files (Go Live).",
    input: s.empty(),
    effects: [],
    run: async () => {
      const tabs = liveTabs();
      for (const t of tabs) await dock.closeTab(t.id, true);
      return { closed: tabs.length };
    },
  });

  // One Go Live (D284): ours steps aside while a Live Server extension is on (the extensions area
  // sets the context key), or when the setting hides it. A running preview still shows its port.
  const liveServer = signal(services.context.get(LIVE_SERVER_CONTEXT) === true);
  const listening = services.context.onDidChange((keys) => {
    if (keys.includes(LIVE_SERVER_CONTEXT))
      liveServer.value = services.context.get(LIVE_SERVER_CONTEXT) === true;
  });
  const item = services.statusBar.add({
    id: "browser.live",
    name: "Go Live",
    alignment: "right",
    priority: 30,
    text: () => {
      dock.root.value;
      const tab = liveTabs()[0];
      if (!tab) {
        services.settings.version.value;
        const hidden =
          liveServer.value || services.settings.peek<boolean>("browser.goLive.statusBar") === false;
        return workspace.root.value && !hidden ? "$(radio-tower) Go Live" : "";
      }
      const view = host.views.get(tab.id);
      view?.page.url.value; // re-render once the page (and its proxy port) is up
      const port = view?.proxyOrigin?.match(/:(\d+)$/)?.[1];
      return port ? `$(circle-x) Port: ${port}` : "$(circle-x) Live";
    },
    tooltip: () => {
      dock.root.value;
      return liveTabs().length
        ? "Live preview running (reloads as you type). Click to stop."
        : "Preview the HTML file with live reload";
    },
    command: "browser.toggleLive",
  });
  return {
    dispose: () => {
      listening.dispose();
      item.dispose();
    },
  };
}

/**
 * Set by the extensions area (`extensions/actions.ts`) while an extension with a Go Live of its
 * own (Live Server…) is installed and enabled (D284).
 */
const LIVE_SERVER_CONTEXT = "liveServerExtensionEnabled";
