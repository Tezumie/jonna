// The Skills section of Customize (D206, like Cursor's): the user's skills and this folder's in
// two groups, each with + New; a row (lightning icon, name, description) opens its SKILL.md, its
// ⋯ (agent.skillActions) opens, turns off or on, reveals or deletes it. Every action is a command:
// agent.showSkills, agent.newSkill, agent.deleteSkill, agent.setSkillEnabled, agent.skillActions.
// The skills themselves are found by skills.ts.
import { isValidSkillName, skillTemplate, slugSkillName } from "../../core/agent/skills";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { skillsIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { ensureWorkspaceFolder } from "../../workbench/workspaceFolder";
import { addCustomizeSection, openCustomize } from "./customize";
import { builtinSkillText, disabledSkills, type LoadedSkills, type SkillsService } from "./skills";
import { addButton, emptyNote, pageGroup, pageHeader, runCommand, tag } from "./view/pageKit";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

/**
 * Where a skill comes from, said plainly: nothing for the IDE's own folders, else the tool whose
 * folder it is in (a skill made in Cursor shows "From Cursor"; it is found, not shipped).
 */
function sourceBadge(source: string): string | null {
  const s = source.replaceAll("\\", "/");
  if (s.includes(".cursor/")) return "From Cursor";
  if (s.includes(".claude/")) return "From Claude Code";
  if (s.includes(".agents/")) return "From .agents";
  return null;
}

class SkillsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  private loaded: LoadedSkills = { skills: [], shadowed: [], problems: [] };
  private userDir: string | null = null;
  private ticket = 0;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly skills: SkillsService,
  ) {
    this.body = h("div", { class: "ai-setup skills-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    // Opening the page reads the folders again (the user's aren't watched), as does coming back
    // to the window (a skill added in a file manager or another tool).
    skills.invalidate();
    const win = this.element.ownerDocument.defaultView;
    if (win) this.store.add(on(win, "focus", () => skills.invalidate()));
    this.store.add(
      effect(() => {
        skills.version.value;
        services.settings.version.value;
        services.workspace.root.value;
        services.workspace.folders.value;
        void this.reload();
        return undefined;
      }),
    );
  }

  private async reload(): Promise<void> {
    const ticket = ++this.ticket;
    const [loaded, userDir] = await Promise.all([this.skills.all(), this.skills.userDir()]);
    if (ticket !== this.ticket) return;
    this.loaded = loaded;
    this.userDir = userDir;
    this.draw();
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private row(
    st: DisposableStore,
    key: Record<string, string>,
    glyph: Element,
    name: string,
    badges: (string | null)[],
    detail: string,
    open: () => unknown,
    more: (() => unknown) | null,
    off = false,
  ): HTMLElement {
    const moreButton = more
      ? h(
          "button",
          { class: "icon-button mcp-row-more", type: "button", "aria-label": `More for ${name}` },
          icon("ellipsis"),
        )
      : null;
    if (moreButton && more)
      st.add(
        on(moreButton, "click", (ev) => {
          ev.stopPropagation();
          void more();
        }),
      );
    const el = h(
      "div",
      {
        class: `mcp-row skills-row${off ? " is-off" : ""}`,
        ...key,
        tabindex: "0",
        role: "button",
      },
      h("span", { class: "mcp-row-icon" }, glyph),
      h(
        "span",
        { class: "mcp-row-main" },
        h(
          "span",
          { class: "mcp-row-title" },
          h("span", { class: "mcp-row-name" }, name),
          ...badges.filter((b): b is string => !!b).map((b) => tag(b)),
        ),
        h("span", { class: "mcp-row-detail", title: detail }, detail),
      ),
      moreButton,
    );
    st.add(on(el, "click", () => void open()));
    st.add(
      on(el, "keydown", (ev) => {
        if (ev.target !== el) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void open();
        }
      }),
    );
    return el;
  }

  private group(
    st: DisposableStore,
    scope: "user" | "workspace",
    title: string,
    rows: HTMLElement[],
    empty: string,
  ): HTMLElement {
    const add = addButton(st, "New", () => this.run("agent.newSkill", { scope }), {
      class: "skills-new",
      "data-new": scope,
      title: `New ${scope === "user" ? "user" : "workspace"} skill`,
    });
    return pageGroup(
      title,
      rows.length,
      [add],
      [rows.length ? h("div", { class: "mcp-list" }, ...rows) : emptyNote(empty)],
      { "data-group": scope },
    );
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const off = disabledSkills(this.services);
    const rowFor = (x: LoadedSkills["skills"][number]) =>
      this.row(
        st,
        { "data-skill": x.name, "data-scope": x.scope },
        icon("zap"),
        x.name,
        [
          off.has(x.name) ? "Off" : null,
          x.disableModelInvocation ? `Only /${x.name}` : null,
          sourceBadge(x.source),
        ],
        x.description,
        () => this.run("agent.openSkill", { name: x.name }),
        () => this.run("agent.skillActions", { name: x.name }),
        off.has(x.name),
      );
    const user = this.loaded.skills.filter((x) => x.scope === "user").map(rowFor);
    const workspace = this.loaded.skills.filter((x) => x.scope === "workspace").map(rowFor);
    const root = this.services.workspace.root.peek();
    const problems = this.loaded.problems.map((p) =>
      this.row(
        st,
        { "data-problem": p.file },
        icon("triangle-alert"),
        p.file
          .replace(/[\\/]SKILL\.md$/i, "")
          .split(/[\\/]/)
          .pop() ?? p.file,
        [p.source],
        p.error,
        () => this.run("editor.openFile", { path: p.file }),
        null,
      ),
    );
    const parts: (HTMLElement | null)[] = [
      pageHeader("Skills", null),
      this.group(
        st,
        "user",
        "User",
        user,
        `No user skills. New adds one to ${this.userDir ?? "your skills folder"}, for every project.`,
      ),
      root
        ? this.group(
            st,
            "workspace",
            "Workspace",
            workspace,
            "No skills in this folder. New adds one to the workspace folder's skills, to share with the project.",
          )
        : null,
      problems.length
        ? pageGroup(
            "Not loaded",
            problems.length,
            [],
            [h("div", { class: "mcp-list" }, ...problems)],
            {
              "data-group": "problems",
            },
          )
        : null,
    ];
    this.body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
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

export function registerSkillsPage(
  sub: DisposableStore,
  services: WorkbenchServices,
  skills: SkillsService,
): void {
  const { dispatcher, quickInput, workspace } = services;
  sub.add(
    addCustomizeSection({
      id: "skills",
      label: "Skills",
      icon: "zap",
      detail: "Instructions and files the agent loads when a task matches (SKILL.md folders)",
      keywords: "skills SKILL.md claude cursor workflow",
      order: 35,
      page: { create: () => new SkillsView(services, skills) },
    }),
  );

  const require = async (name: string) => {
    const skill = await skills.find(name);
    if (!skill) throw new Error(`No skill named ${name} (agent.listSkills lists them).`);
    return skill;
  };
  const setOff = async (
    name: string,
    enabled: boolean,
    execute: (id: string, input: unknown) => Promise<unknown>,
  ) => {
    const off = disabledSkills(services);
    if (enabled) off.delete(name);
    else off.add(name);
    await execute("settings.set", {
      key: "agent.skills.disabled",
      value: [...off].sort(),
      scope: "user",
    });
    skills.invalidate();
  };

  sub.add(
    dispatcher.register({
      id: "agent.showSkills",
      title: "Agent skills",
      category: "Agent",
      description:
        "Opens Customize at Skills: the user's skills and this folder's (SKILL.md folders), to add, open, turn off or delete one.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => openCustomize(services, "skills"),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.newSkill",
      title: "New agent skill…",
      category: "Agent",
      description:
        "Creates a skill: <name>/SKILL.md from a template (front matter name and description, a heading, a line to replace) in the user's skills folder (`scope` user, every project) or this folder's <workspace folder>/skills (`scope` workspace), then opens it. `name`: lowercase letters, digits and hyphens (other text is turned into that); asked for when a person runs it without one.",
      input: s.object({
        name: s.string().optional(),
        scope: s.enum(["user", "workspace"] as const).optional(),
        description: s.string().describe("Default: a line to replace").optional(),
        open: s.boolean().describe("Open the new SKILL.md (default true)").optional(),
        folder: s
          .string()
          .describe("Multi-root workspaces: the folder (path or name) for a workspace skill")
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ name, scope, description, open, folder }, ctx) => {
        const root = workspace.root.peek();
        let where = scope ?? (root ? "workspace" : "user");
        if (!scope && root && ctx.caller.kind === "user") {
          const picked = await quickInput.pick(
            [
              { id: "workspace", label: "This folder", description: "shared with the project" },
              { id: "user", label: "Every project", description: "your own skills" },
            ],
            { placeholder: "New skill for…" },
          );
          if (!picked) return { created: false };
          where = picked.id as "user" | "workspace";
        }
        let typed = name;
        if (typed === undefined) {
          if (ctx.caller.kind !== "user") throw new Error("Give the skill a `name`.");
          typed = await quickInput.prompt({
            prompt: `New ${where === "user" ? "user" : "workspace"} skill`,
            placeholder: "Skill name, e.g. release-notes",
            validate: (v) =>
              !v.trim() || slugSkillName(v)
                ? undefined
                : "Use letters or digits (lowercase, hyphens between words).",
          });
          if (!typed?.trim()) return { created: false };
        }
        const slug = slugSkillName(typed);
        if (!isValidSkillName(slug)) throw new Error(`"${typed}" can't be a skill's name.`);
        if (where === "workspace" && !root) throw new Error("Open a folder for a workspace skill.");
        // D251: a multi-root workspace's skill goes in the folder given, the active editor's, or
        // the one picked.
        const target =
          where === "workspace"
            ? await pickWorkspaceFolder(services, folder, "New skill in which folder?")
            : null;
        if (where === "workspace" && !target) return { created: false };
        if (where === "workspace" && target) await ensureWorkspaceFolder(target);
        const base = where === "user" ? await skills.userDir() : skills.workspaceDir(target);
        if (!base) throw new Error("There's no folder to put the skill in.");
        const dir = joinPath(base, slug);
        const file = joinPath(dir, "SKILL.md");
        if (await fsIpc.stat(file).catch(() => null))
          throw new Error(`There's a skill called ${slug} already (${file}).`);
        let text = skillTemplate(slug);
        if (description?.trim())
          text = text.replace(
            "description: Describe when Agent should use this skill.",
            `description: ${description.replace(/\s+/g, " ").trim()}`,
          );
        await fsIpc.write(file, new TextEncoder().encode(text));
        skills.invalidate();
        if (open !== false) await ctx.execute("editor.openFile", { path: file });
        return { created: true, name: slug, scope: where, path: file };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setSkillEnabled",
      title: "Turn an agent skill on or off",
      category: "Agent",
      description:
        "Turns a skill off (the agent isn't told of it and /name doesn't run it) or on again, in the user's settings (agent.skills.disabled, by name). New chats follow; a chat already open can't load it any more.",
      input: s.object({ name: s.string(), enabled: s.boolean() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ name, enabled }, ctx) => {
        await require(name);
        await setOff(name, enabled, (id, input) => ctx.execute(id, input));
        return { name, enabled };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.deleteSkill",
      title: "Delete an agent skill",
      category: "Agent",
      description:
        "Deletes a skill's folder (its SKILL.md and the files with it): one of this folder's, or one of the user's own (~/<data folder>/skills). Other tools' user skills (~/.claude/skills, ~/.cursor/skills, ~/.agents/skills) are left alone: turn those off instead. Asks first when a person runs it.",
      input: s.object({ name: s.string() }),
      effects: ["destructive"],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        const skill = await require(name);
        const own = await skills.userDir();
        const userOwn = skill.scope === "user" && !!own && isWithin(own, skill.dir);
        if (skill.scope === "user" && !userOwn)
          throw new Error(
            `${name} is in ${skill.source}, another tool's folder: turn it off here, or delete it there.`,
          );
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            `Delete the skill ${name}?`,
            `Its folder ${skill.dir} and the files in it are deleted. Turn it off instead to keep it.`,
            "Delete",
            true,
          ))
        )
          return { deleted: false };
        if (userOwn) await skillsIpc.deleteUserSkill(skill.dir);
        else await fsIpc.delete(skill.dir);
        if (disabledSkills(services).has(name))
          await setOff(name, true, (id, input) => ctx.execute(id, input)).catch(() => {});
        skills.invalidate();
        return { deleted: name, path: skill.dir };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.openSkill",
      title: "Open agent skill",
      category: "Agent",
      description:
        "Opens a skill's SKILL.md in the editor; one that comes with the IDE has no file, so its text opens read-only (Customize in its actions makes an editable copy).",
      input: s.object({ name: s.string() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        const skill = await require(name);
        // A built-in skill's path is `builtin:<name>/SKILL.md`, not a file (D277: opening it
        // failed with Windows' "filename syntax is incorrect").
        if (skill.builtin) {
          const text = builtinSkillText(name);
          if (text === null || text === undefined)
            throw new Error(`No text for the skill ${name}.`);
          await ctx.execute("editor.openReadOnly", {
            title: `${name} (built in) SKILL.md`,
            content: text,
          });
          return { opened: name, builtin: true };
        }
        await ctx.execute("editor.openFile", { path: skill.file });
        return { opened: name, path: skill.file };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.skillActions",
      title: "Agent skill actions…",
      category: "Agent",
      description:
        "What to do with one skill: open its SKILL.md, turn it off or on, reveal its folder in the file manager, delete it.",
      input: s.object({ name: s.string() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        const skill = await require(name);
        const off = disabledSkills(services).has(name);
        // One that comes with the IDE (D255): no file to open or delete; Customize copies it to
        // the user's skills folder, where the copy takes its place.
        if (skill.builtin) {
          const picked = await quickInput.pick(
            [
              {
                id: "customize",
                label: "Customize",
                description: "copy it to your skills folder",
                icon: "pencil" as const,
              },
              off
                ? { id: "on", label: "Turn on", icon: "eye" as const }
                : { id: "off", label: "Turn off", icon: "eye-off" as const },
            ],
            { placeholder: `${name} · built in` },
          );
          if (picked?.id === "on" || picked?.id === "off")
            return ctx.execute("agent.setSkillEnabled", { name, enabled: picked.id === "on" });
          if (picked?.id !== "customize") return { done: false };
          const base = await skills.userDir();
          const text = builtinSkillText(name);
          if (!base || !text) throw new Error("There's no folder to put the skill in.");
          const file = joinPath(joinPath(base, name), "SKILL.md");
          if (!(await fsIpc.stat(file).catch(() => null)))
            await fsIpc.write(file, new TextEncoder().encode(text));
          skills.invalidate();
          await ctx.execute("editor.openFile", { path: file });
          return { customized: true, path: file };
        }
        const own = await skills.userDir();
        const deletable = skill.scope === "workspace" || (!!own && isWithin(own, skill.dir));
        const picked = await quickInput.pick(
          [
            { id: "open", label: "Open", description: "SKILL.md", icon: "file-text" as const },
            off
              ? { id: "on", label: "Turn on", icon: "eye" as const }
              : { id: "off", label: "Turn off", icon: "eye-off" as const },
            { id: "reveal", label: "Reveal in file manager", icon: "folder-open" as const },
            ...(deletable ? [{ id: "delete", label: "Delete", icon: "trash-2" as const }] : []),
          ],
          { placeholder: `${name} · ${skill.source}` },
        );
        switch (picked?.id) {
          case "open":
            return ctx.execute("agent.openSkill", { name });
          case "on":
          case "off":
            return ctx.execute("agent.setSkillEnabled", { name, enabled: picked.id === "on" });
          case "reveal":
            return ctx.execute("explorer.revealInOs", { path: skill.file });
          case "delete":
            return ctx.execute("agent.deleteSkill", { name });
          default:
            return { done: false };
        }
      },
    }),
  );
}
