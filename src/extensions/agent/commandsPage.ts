// Customize → Commands (D205, like Cursor's): the slash commands from prompt files, in two groups —
// User (<config>/commands, ~/.claude/commands) and Workspace (<workspace folder>/commands,
// .claude/commands, .cursor/commands) — each with "+ New", which writes a starter file and opens
// it; a row opens its file, its ⋯ opens or deletes it. The built-ins (/compact, /clear…) aren't
// files and aren't listed. Commands: agent.showSlashCommands, agent.newSlashCommand,
// agent.deleteSlashCommand (agent.slash lists them all, built-ins too).
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import { settingsIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath, samePath } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import {
  BUILTIN_COMMANDS,
  commandFolders,
  type SlashCommand,
  slashCommands,
} from "./slashCommands";
import { addButton, emptyNote, pageGroup, pageHeader, runCommand } from "./view/pageKit";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

/** Bumped when a command file is made or deleted here: the section redraws. */
const version = signal(0);

const NAME = /^[\w-]+(?::[\w-]+)?$/;

class CommandsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;

  constructor(private readonly services: WorkbenchServices) {
    this.body = h("div", { class: "ai-setup commands-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        version.value;
        services.workspace.root.value;
        services.workspace.folders.value;
        services.settings.version.value;
        void this.reload();
        return undefined;
      }),
    );
  }

  onShow(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    const list = (await slashCommands(this.services)).filter((c) => c.path);
    if (this.store.isDisposed) return;
    this.draw(list);
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private draw(list: SlashCommand[]): void {
    this.render.clear();
    const st = this.render;
    const group = (
      title: string,
      scope: "user" | "workspace",
      items: SlashCommand[],
      extra: HTMLElement | null = null,
    ) => {
      const add = addButton(st, "New", () => this.run("agent.newSlashCommand", { scope }), {
        "data-new": scope,
        title: `New ${scope} command`,
      });
      const rows = items.map((c) => {
        const more = h(
          "button",
          {
            class: "icon-button mcp-row-more",
            type: "button",
            "aria-label": `More for /${c.name}`,
          },
          icon("ellipsis"),
        );
        const el = h(
          "div",
          { class: "mcp-row", "data-command": c.name, tabindex: "0", role: "button" },
          h("span", { class: "mcp-row-icon" }, icon("square-terminal")),
          h(
            "span",
            { class: "mcp-row-main" },
            h("span", { class: "mcp-row-title" }, h("span", { class: "mcp-row-name" }, c.name)),
            h("span", { class: "mcp-row-detail" }, c.description || c.source),
          ),
          more,
        );
        const open = () => void this.run("editor.openFile", { path: c.path });
        st.add(on(el, "click", open));
        st.add(
          on(el, "keydown", (e) => {
            if (e.key === "Enter") open();
          }),
        );
        st.add(
          on(more, "click", (e) => {
            e.stopPropagation();
            void this.services.quickInput
              .pick(
                [
                  { id: "open", label: "Open", icon: "file-text" as const },
                  { id: "delete", label: "Delete", icon: "trash-2" as const },
                ],
                { placeholder: `/${c.name}` },
              )
              .then((picked) => {
                if (picked?.id === "open") open();
                if (picked?.id === "delete")
                  void this.run("agent.deleteSlashCommand", { name: c.name });
              });
          }),
        );
        return el;
      });
      return pageGroup(
        title,
        items.length,
        [extra, add],
        [
          items.length
            ? h("div", { class: "mcp-list" }, ...rows)
            : emptyNote(
                scope === "user"
                  ? "No user commands. New adds one for every project."
                  : "No commands in this folder. New adds one to share with the project.",
              ),
        ],
        { "data-scope": scope },
      );
    };
    const root = this.services.workspace.root.peek();
    this.body.replaceChildren(
      pageHeader("Commands", null),
      group(
        "User",
        "user",
        list.filter((c) => c.user),
        // Every command the chat knows (built-in, skills, MCP prompts), not only these files.
        addButton(st, "All commands", () => this.run("agent.slash"), {}, "list"),
      ),
      root
        ? group(
            "Workspace",
            "workspace",
            list.filter((c) => !c.user),
          )
        : emptyNote("Open a folder for its own commands."),
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerCommandsPage(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput } = services;
  sub.add(
    addCustomizeSection({
      id: "commands",
      label: "Commands",
      icon: "square-terminal",
      detail: "Slash commands: prompt files you run in chat with /name",
      keywords: "slash prompts /",
      order: 37,
      page: { create: () => new CommandsView(services) },
    }),
  );
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  register({
    id: "agent.showSlashCommands",
    title: "Slash commands…",
    description: "Opens Customize at Commands: your and the project's slash command files.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => openCustomize(services, "commands"),
  });

  register({
    id: "agent.newSlashCommand",
    title: "New slash command…",
    description:
      "Writes a starter prompt file for a slash command and opens it: `scope` user (<config>/commands, every folder) or workspace (<workspace folder>/commands). Asks for the name when none is given. In a multi-root workspace `folder` (a folder's path or name) says which folder a workspace command goes in; without it, the active editor's folder, else the user picks.",
    input: s.object({
      scope: s.enum(["user", "workspace"] as const).optional(),
      name: s
        .string()
        .describe("Letters, digits, - and _ (folder:name for a subfolder)")
        .optional(),
      folder: s
        .string()
        .describe("Multi-root workspaces: the folder (path or name) for a workspace command")
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ scope, name, folder: wanted }, ctx) => {
      const folders = await commandFolders(services);
      const where = scope ?? (services.workspace.root.peek() ? "workspace" : "user");
      // D251: a workspace command goes in the folder given, the active editor's, or the one picked.
      const target =
        where === "workspace" && services.workspace.root.peek()
          ? await pickWorkspaceFolder(services, wanted, "New command in which folder?")
          : null;
      if (where === "workspace" && services.workspace.root.peek() && !target)
        return { created: false };
      const folder = folders.find((f) =>
        where === "user" ? f.user : !f.user && !!target && !!f.root && samePath(f.root, target),
      );
      if (!folder)
        throw new Error(
          where === "workspace" ? "Open a folder first." : "The user's folder isn't known yet.",
        );
      const chosen =
        name ??
        (await quickInput.prompt({
          prompt: `New ${where === "user" ? "user" : "workspace"} command: its name (you type /name)`,
          placeholder: "review-pr",
          validate: (v) =>
            NAME.test(v.trim()) ? undefined : "Letters, digits, - and _ (folder:name for a folder)",
        }));
      if (!chosen) return { created: false };
      const clean = chosen.trim();
      if (!NAME.test(clean)) throw new Error(`"${clean}" isn't a command name.`);
      // A file under a name that's taken would never run nor show here (the first one wins).
      if (BUILTIN_COMMANDS.some((c) => c.name === clean))
        throw new Error(`/${clean} is built in; pick another name.`);
      // One in a folder that comes later (the user's, for a workspace command) is overridden.
      const taken = (await slashCommands(services)).find((c) => c.name === clean);
      const takenAt = taken?.path
        ? folders.findIndex((f) => isWithin(f.dir, taken.path ?? ""))
        : -1;
      if (taken && takenAt <= folders.indexOf(folder))
        throw new Error(`/${clean} exists already (${taken.path ?? taken.source}).`);
      const path = joinPath(folder.dir, `${clean.replace(":", "/")}.md`);
      if (
        await fsIpc.stat(path).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`/${clean} exists already (${path}).`);
      const text = `# ${clean}\n\nWrite your command's prompt here.\n\nThis command is available in chat with /${clean}\n`;
      await fsIpc.write(path, new TextEncoder().encode(text));
      version.value++;
      if (ctx.caller.kind === "user" || ctx.caller.kind === "test")
        await dispatcher.execute("editor.openFile", { path }).catch(() => {});
      return { created: true, name: clean, path };
    },
  });

  register({
    id: "agent.deleteSlashCommand",
    title: "Delete a slash command",
    description: "Deletes a slash command's prompt file (asks first when a person runs it).",
    input: s.object({ name: s.string() }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ name }, ctx) => {
      const command = (await slashCommands(services)).find((c) => c.name === name && c.path);
      if (!command?.path) throw new Error(`No slash command file for /${name}.`);
      if (
        ctx.caller.kind === "user" &&
        !(await confirmAction(`Delete /${name}?`, `${command.path} is deleted.`, "Delete", true))
      )
        return { deleted: false };
      await settingsIpc.deleteUserFile(command.path);
      version.value++;
      return { deleted: true, path: command.path };
    },
  });
}
