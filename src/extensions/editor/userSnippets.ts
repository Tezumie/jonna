// User and project snippets in VS Code's formats (D117): `<user data>/snippets/<language>.json`,
// `<user data>/snippets/*.code-snippets`, the folder's `.vscode/*.code-snippets` and
// `<workspace folder>/snippets/*` (a `.code-snippets` file's entries name their languages in `scope`, else
// they apply everywhere). They join extension snippets in the editor's suggestions, and reload
// when one of these files is saved or the folder changes. A multi-root workspace's folders each
// have theirs (D251): all of them are read, and new ones go in the folder of the file the user is
// in (or the one asked).

import { fsIpc } from "../../core/ipc/fs";
import { type DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { basename, dirname, joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import type { SnippetEntry } from "../../workbench/contributions";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPaths } from "../../workbench/workspaceFolder";
import { parseSnippets } from "../extensions/contributions";
import { chooseFolder } from "./folderChoice";

/** VS Code language ids that are named differently here. */
const LANGUAGE_IDS: Record<string, string> = {
  typescriptreact: "tsx",
  javascriptreact: "jsx",
};
const languageId = (id: string) => LANGUAGE_IDS[id.trim()] ?? id.trim();

/** Snippet entries of one file; `fileName` decides the language of a `<language>.json` file. */
export function snippetsFromFile(fileName: string, json: unknown, source: string): SnippetEntry[] {
  if (!json || typeof json !== "object") return [];
  if (fileName.endsWith(".json")) {
    const language = languageId(fileName.slice(0, -".json".length));
    return parseSnippets(json, language, source);
  }
  const out: SnippetEntry[] = [];
  for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
    const scope = raw && typeof raw === "object" ? (raw as { scope?: unknown }).scope : undefined;
    const languages =
      typeof scope === "string" && scope.trim()
        ? scope.split(",").map(languageId).filter(Boolean)
        : ["*"];
    for (const language of languages) out.push(...parseSnippets({ [name]: raw }, language, source));
  }
  return out;
}

const isSnippetFile = (name: string, allowJson: boolean) =>
  name.endsWith(".code-snippets") || (allowJson && name.endsWith(".json"));

const TEMPLATE = `{
  // Snippets for this project, in VS Code's format. Each one: a name, the prefix you type, the
  // body ($1, $2 for tab stops, \${1:default} for placeholders, $0 for the end) and optionally the
  // languages it's for ("scope": "typescript,tsx") — without a scope it works everywhere.
  // "Log a value": {
  //   "scope": "javascript,typescript,jsx,tsx",
  //   "prefix": "log",
  //   "body": ["console.log('$1', $1);", "$0"],
  //   "description": "console.log with a label"
  // }
}
`;

export function registerUserSnippets(sub: DisposableStore, services: WorkbenchServices): void {
  const { settings, workspace, contributions } = services;
  const current = sub.add(new MutableDisposable());
  let loading = 0;

  const userDir = (): string | null => {
    const file = settings.filePath("user");
    return file ? joinPath(dirname(file), "snippets") : null;
  };
  /** The workspace's folders (just the root with one), each with its name when there are several. */
  const roots = (): { path: string; label: string | null }[] => {
    const list = workspace.folders.peek();
    if (list.length > 1) return list.map((f) => ({ path: f.path, label: f.name }));
    const root = workspace.root.peek();
    return root ? [{ path: root, label: null }] : [];
  };
  const folders = (): { dir: string; json: boolean; source: string; label: string | null }[] => {
    const user = userDir();
    return [
      ...(user ? [{ dir: user, json: true, source: "user", label: null }] : []),
      ...roots().flatMap(({ path: root, label }) => [
        // VS Code keeps *.code-snippets directly in .vscode; ours are in <folder>/snippets (D189).
        { dir: joinPath(root, ".vscode"), json: false, source: "workspace", label },
        ...workspaceFolderPaths(root, "snippets").map((dir) => ({
          dir,
          json: true,
          source: "workspace",
          label,
        })),
      ]),
    ];
  };

  const load = async (): Promise<void> => {
    const token = ++loading;
    const found: SnippetEntry[] = [];
    for (const { dir, json, source, label } of folders()) {
      const list = await fsIpc.listDir(dir).catch(() => []);
      for (const e of list) {
        if (e.kind !== "file" || !isSnippetFile(e.name, json)) continue;
        try {
          const text = new TextDecoder().decode(await fsIpc.read(e.path));
          const parsed = parseJsonc(text);
          if (parsed.ok)
            found.push(
              ...snippetsFromFile(
                e.name,
                parsed.value,
                // Several folders: which one's file ("workspace:api/project.code-snippets").
                `${source}:${label ? `${label}/` : ""}${e.name}`,
              ),
            );
        } catch {
          // An unreadable or half-written file just contributes nothing until it's fixed.
        }
      }
    }
    if (token !== loading || sub.isDisposed) return;
    current.value = contributions.addSnippets(found);
  };

  sub.add(
    effect(() => {
      workspace.root.value;
      workspace.folders.value;
      void load();
      return undefined;
    }),
  );
  sub.add(
    services.events.on("files.didSave", ({ path }) => {
      const name = basename(path);
      if (folders().some((f) => dirname(path) === f.dir && isSnippetFile(name, f.json)))
        void load();
    }),
  );

  sub.add(
    services.dispatcher.register({
      id: "editor.configureSnippets",
      title: "Configure snippets",
      category: "Preferences",
      description:
        "Opens (creating it if needed) a snippets file in VS Code's format: the project's `.vscode/<name>.code-snippets` (scope: workspace) or your own `<language>.json` / `<name>.code-snippets` (scope: user). Snippets show in the editor's suggestions by prefix. In a multi-root workspace, project snippets go in `folder` (a folder's path or name; default: the active file's folder, else asks).",
      input: s.object({
        scope: s
          .enum(["workspace", "user"])
          .describe("Project (.vscode) or your own snippets; asks when left out")
          .optional(),
        name: s
          .string()
          .describe("File name without extension: a language id for user files (e.g. typescript)")
          .optional(),
        folder: s
          .string()
          .describe("Multi-root workspaces: the folder (path or name) for project snippets")
          .optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async (input) => {
        let { scope, name } = input;
        const hasFolder = workspace.root.peek() !== null;
        if (!scope) {
          const picked = await services.quickInput.pick(
            [
              ...(hasFolder
                ? [
                    {
                      id: "workspace",
                      label: "Project snippets",
                      description: ".vscode/project.code-snippets",
                    },
                  ]
                : []),
              { id: "user", label: "Your snippets (all projects)", description: "global" },
            ],
            { placeholder: "Configure snippets" },
          );
          if (!picked) return { path: null, created: false };
          scope = picked.id as "workspace" | "user";
        }
        const user = userDir();
        // Which folder's (D251): asked only with several and no active file in one of them.
        const root =
          scope === "user"
            ? null
            : ((await chooseFolder(services, input.folder, "Snippets for which folder?"))?.path ??
              null);
        if (scope !== "user" && hasFolder && !root) return { path: null, created: false };
        // The project's go in <workspace folder>/snippets (the IDE never makes .vscode, D189),
        // unless that file is already in .vscode.
        let dir = scope === "user" ? user : root ? workspaceFolderPaths(root, "snippets")[0] : null;
        if (!dir) throw new Error(scope === "user" ? "No user folder." : "Open a folder first.");
        if (name && /[\\/]|\.\./.test(name)) throw new Error("A snippets file name, not a path.");
        const fileName =
          scope === "user" && name && !name.endsWith(".code-snippets")
            ? `${name}.json`
            : `${name?.replace(/\.code-snippets$/, "") || (scope === "user" ? "global" : "project")}.code-snippets`;
        if (scope !== "user" && root) {
          const vscode = joinPath(joinPath(root, ".vscode"), fileName);
          if (
            await fsIpc.stat(vscode).then(
              () => true,
              () => false,
            )
          )
            dir = dirname(vscode);
        }
        const path = joinPath(dir, fileName);
        const exists = await fsIpc
          .stat(path)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          await fsIpc.createDir(dirname(dir), basename(dir)).catch(() => {});
          await fsIpc.write(path, new TextEncoder().encode(TEMPLATE));
        }
        await services.dispatcher.execute("editor.openFile", { path });
        return { path, created: !exists };
      },
    }),
  );

  sub.add(
    services.state.register("ide://snippets", {
      description: `Snippets from your user folder, this project (.vscode/*.code-snippets, <workspace folder>/snippets) and extensions: prefix, name, language, source.`,
      get: () =>
        contributions.snippets.peek().map((e) => ({
          prefix: e.prefix,
          name: e.name,
          language: e.language,
          source: e.source,
        })),
    }),
  );
}
