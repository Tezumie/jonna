// Custom chat modes (D227, core/agent/chatModes.ts): the user's `agent.customModes` and a trusted
// folder's `.github/chatmodes/*.chatmode.md` and `.github/agents/*.agent.md` (Copilot's), read
// when the folder opens, when those files change and when the setting changes. The composer's
// mode menu and Shift+Tab list them after Agent, Plan and Ask; `agent.createChatMode` writes a
// new mode file and opens it. D251: every folder of a multi-root workspace has its own (the
// source names the folder when there are several).
import {
  type CustomMode,
  customModeId,
  mergeModes,
  modeTemplate,
  parseModeFile,
  parseModeSetting,
} from "../../core/agent/chatModes";
import { slugSkillName } from "../../core/agent/skills";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

/** The custom modes in this window (one list: modes don't differ between chats). */
export const customModes = signal<readonly CustomMode[]>([]);

/** The user's agents as chat modes (D230), set by the subagent registry; merged in after modes. */
export const agentModes = signal<readonly CustomMode[]>([]);

const FOLDERS: readonly [string, RegExp][] = [
  [".github/chatmodes", /\.chatmode\.md$/i],
  [".github/agents", /\.agent\.md$/i],
];

/** The workspace's folders, the first first (none with nothing open). */
function workspaceFolders(services: WorkbenchServices): readonly { path: string; name: string }[] {
  const root = services.workspace.root.peek();
  if (!root) return [];
  const list = services.workspace.folders.peek();
  return list.length ? list : [{ path: root, name: root }];
}

async function folderModes(services: WorkbenchServices): Promise<CustomMode[]> {
  const folders = workspaceFolders(services);
  // A folder's modes are instructions from the repository: only a trusted folder's are used.
  if (!folders.length || !services.trust.trusted) return [];
  const several = folders.length > 1;
  const out: CustomMode[] = [];
  for (const f of folders)
    for (const [rel, pattern] of FOLDERS) {
      const entries = await fsIpc.listDir(joinPath(f.path, rel)).catch(() => []);
      for (const e of entries
        .filter((x) => x.kind === "file" && pattern.test(x.name))
        .slice(0, 50)) {
        try {
          const text = new TextDecoder().decode(await fsIpc.read(e.path));
          const source = `${several ? `${f.name}/` : ""}${rel}/${e.name}`;
          const mode = parseModeFile(e.name, text.slice(0, 50_000), source);
          if (mode) out.push(mode);
        } catch {
          // Unreadable: skipped.
        }
      }
    }
  return out;
}

export function registerCustomModes(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, workspace, state } = services;
  let generation = 0;
  const reload = async () => {
    const mine = ++generation;
    const user = parseModeSetting(settings.peek("agent.customModes"));
    const folder = await folderModes(services);
    if (mine === generation) customModes.value = mergeModes([...agentModes.peek()], user, folder);
  };
  void reload();
  sub.add(
    effect(() => {
      agentModes.value;
      void reload();
      return undefined;
    }),
  );
  sub.add(workspace.onDidOpen(() => void reload()));
  sub.add(workspace.onDidClose(() => void reload()));
  sub.add(workspace.onDidChangeFolders(() => void reload()));
  // Trusting the folder (or putting it in restricted mode) changes whether its modes count.
  let lastTrust = services.trust.state.peek();
  sub.add(
    effect(() => {
      const now = services.trust.state.value;
      if (now !== lastTrust) {
        lastTrust = now;
        void reload();
      }
      return undefined;
    }),
  );
  sub.add(
    settings.model.onDidChange((keys) => {
      if (keys.includes("agent.customModes")) void reload();
    }),
  );
  const isModeFile = (path: string) =>
    workspaceFolders(services).some((f) =>
      FOLDERS.some(([rel, pattern]) => pattern.test(path) && isWithin(joinPath(f.path, rel), path)),
    );
  for (const event of ["files.didSave", "files.didCreate", "files.didDelete"] as const)
    sub.add(
      services.events.on(event, ({ path }) => {
        if (isModeFile(path)) void reload();
      }),
    );

  sub.add(
    state.register("ide://agent/chatModes", {
      description:
        "The user's own chat modes (agent.customModes, a trusted folder's .github/chatmodes/*.chatmode.md and .github/agents/*.agent.md): name, id for agent.setChatMode, description, tools, model, source.",
      get: () =>
        customModes.peek().map((m) => ({
          id: customModeId(m.name),
          name: m.name,
          description: m.description,
          tools: m.tools ?? "all",
          model: m.model,
          source: m.source,
        })),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.createChatMode",
      title: "Create chat mode…",
      category: "Agent",
      description:
        "Creates a custom chat mode as .github/chatmodes/<name>.chatmode.md in the open folder (front matter: description, tools, model; the body is its instructions), opens it, and lists it in the mode menu. Asks for the name when omitted. In a multi-root workspace `folder` (a folder's path or name) says which folder; without it, the active editor's folder, else the user picks.",
      input: s.object({
        name: s.string().describe("The mode's name").optional(),
        folder: s
          .string()
          .describe("Multi-root workspaces: the folder (path or name) it goes in")
          .optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ name, folder }, ctx) => {
        if (!workspace.root.peek()) throw new Error("Open a folder first: a mode file goes in it.");
        const root = await pickWorkspaceFolder(services, folder, "New chat mode in which folder?");
        if (!root) return null;
        const typed =
          name?.trim() ||
          (await services.quickInput.prompt({ prompt: "Name of the new chat mode" }))?.trim();
        if (!typed) return null;
        const slug = slugSkillName(typed) || "mode";
        const path = joinPath(root, `.github/chatmodes/${slug}.chatmode.md`);
        const exists = await fsIpc.stat(path).then(
          () => true,
          () => false,
        );
        if (exists) throw new Error(`.github/chatmodes/${slug}.chatmode.md already exists.`);
        await fsIpc.write(path, new TextEncoder().encode(modeTemplate(typed)));
        await ctx.execute("editor.openFile", { path }).catch(() => {});
        await reload();
        return { path, id: customModeId(slug) };
      },
    }),
  );
}
