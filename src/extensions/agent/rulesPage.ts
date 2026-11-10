// The Rules page (D204, dock view `agent.rules`): every rules file the agent reads, with its
// source, scope (always, matching files, by description, a folder's, only when mentioned), the
// subagents it's for, and an on/off switch; a rule is edited in place (its scope written back
// into the file's own front matter, its text) or deleted, and new ones come from a template
// (a Cursor .mdc, a section of AGENTS.md, Copilot's .instructions.md, Claude Code's
// .claude/rules). Everything goes through commands: agent.showRules, agent.createRule,
// agent.updateRule, agent.deleteRule, agent.setRuleEnabled. The model is in
// core/agent/ruleEditing.ts; the files are read by rules.ts.
import {
  fieldsOf,
  frontMatterFor,
  newRule,
  parseSubagentField,
  type RuleFields,
  type RuleScope,
  type RuleTemplate,
  SCOPE_LABELS,
  SOURCE_LABELS,
  scopesFor,
  setFrontMatter,
  TEMPLATE_LABELS,
} from "../../core/agent/ruleEditing";
import { splitGlobs } from "../../core/agent/rules";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, resolveInRoot } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import { projectInstructionsBlocked } from "./riskyGuard";
import { type ActiveRule, disabledRules, type RulesService } from "./rules";
import {
  addButton,
  cardRow,
  emptyNote,
  field,
  pageButton,
  pageGroup,
  pageHeader,
  pickRowAction,
  runCommand,
  selectInput,
  textArea,
  textInput,
} from "./view/pageKit";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

const TEMPLATES: readonly RuleTemplate[] = ["cursor", "agents", "copilot", "claude"];
const SCOPES: readonly RuleScope[] = ["always", "globs", "description", "folder", "manual"];

/** Bumped when a rule is written or turned on / off: the page reads them again. */
const rulesVersion = signal(0);

class RulesView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  private rules: ActiveRule[] = [];
  /** The rule being edited (its path), or "new" for the new rule form. */
  private editing: string | null = null;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly service: RulesService,
  ) {
    this.body = h("div", { class: "ai-setup rules-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        rulesVersion.value;
        services.settings.version.value;
        services.workspace.root.value;
        services.workspace.folders.value;
        void this.reload();
        return undefined;
      }),
    );
  }

  private async reload(): Promise<void> {
    this.service.invalidate();
    this.rules = await this.service.all();
    // A field being typed in isn't taken away by a reload.
    if (this.editing && this.element.contains(this.element.ownerDocument.activeElement)) return;
    this.draw();
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const root = this.services.workspace.root.peek();
    const project = this.rules.filter((r) => !r.user);
    const blocked = projectInstructionsBlocked(this.services);
    const own = this.rules.filter((r) => r.user);
    // Always there, like every page's add button: with no folder, a rule needs one first.
    const add = root
      ? addButton(st, "New", () => this.open("new"), { "data-new": "rule", title: "New rule" })
      : addButton(st, "New", () => void this.run("workspace.openFolder"), {
          "data-new": "rule",
          title: "Open a folder to add a rule",
        });
    const sections: (HTMLElement | null)[] = [
      pageHeader("Rules", null),
      pageGroup(
        "In this project",
        root ? project.length : null,
        [add],
        [
          this.editing === "new" ? this.newForm(st) : null,
          blocked ? emptyNote(blocked) : null,
          project.length
            ? h("div", { class: "mcp-list" }, ...project.map((r) => this.row(st, r)))
            : !root
              ? emptyNote("Open a folder to see its rules.")
              : blocked || this.editing === "new"
                ? null
                : emptyNote(
                    "No rules files yet. New adds one; AGENTS.md at the folder's root is read by most agents.",
                  ),
        ],
        { "data-group": "project" },
      ),
      own.length
        ? pageGroup(
            "Yours, in every project",
            own.length,
            [],
            [h("div", { class: "mcp-list" }, ...own.map((r) => this.row(st, r)))],
            { "data-group": "user" },
          )
        : null,
    ];
    this.body.replaceChildren(...sections.filter((x): x is HTMLElement => !!x));
  }

  private open(what: string | null): void {
    this.editing = this.editing === what ? null : what;
    this.draw();
    this.body.querySelector<HTMLElement>(".ai-form input, .ai-form select")?.focus();
  }

  private row(st: DisposableStore, r: ActiveRule): HTMLElement {
    const scope = fieldsOf(r).scope;
    const scopeText =
      scope === "globs"
        ? `${SCOPE_LABELS.globs}: ${r.globs.join(", ")}`
        : scope === "folder"
          ? `${SCOPE_LABELS.folder} (${r.folder}/)`
          : SCOPE_LABELS[scope];
    const detail = [
      SOURCE_LABELS[r.source],
      r.description,
      r.subagents
        ? r.subagents.length
          ? `subagents: ${r.subagents.join(", ")}`
          : "not for subagents"
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const setEnabled = (enabled: boolean) =>
      this.run("agent.setRuleEnabled", { path: r.path, enabled });
    const row = cardRow(st, {
      attrs: { "data-rule": r.path },
      glyph: icon("book-open"),
      name: r.path,
      badges: [r.disabled ? "Off" : scopeText],
      details: [detail],
      off: r.disabled === true,
      // The file opens in the editor, as a skill's SKILL.md does (D401): its text is edited there,
      // and ⋯ keeps when it applies and who gets it.
      open: () => this.run("editor.openFile", { path: r.abs }),
      more: () =>
        pickRowAction(this.services, r.path, [
          {
            id: "open",
            label: "Open",
            run: () => this.run("editor.openFile", { path: r.abs }),
          },
          { id: "edit", label: "When it applies…", run: () => this.open(r.path) },
          {
            id: "toggle",
            label: r.disabled ? "Turn on" : "Turn off",
            run: () => setEnabled(r.disabled === true),
          },
          ...(r.user
            ? []
            : [
                {
                  id: "delete",
                  label: "Delete",
                  run: () => this.run("agent.deleteRule", { path: r.path }),
                },
              ]),
        ]),
    });
    if (this.editing !== r.path) return row;
    return h("div", { class: "page-row-open" }, row, this.editForm(st, r));
  }

  private scopeFields(
    st: DisposableStore,
    allowed: readonly RuleScope[],
    fields: Partial<RuleFields> & { folder?: string },
  ): { element: HTMLElement; read: () => RuleFields } {
    const scope = selectInput(
      "Scope",
      allowed.map((sc) => [sc, SCOPE_LABELS[sc]] as const),
      fields.scope && allowed.includes(fields.scope) ? fields.scope : (allowed[0] ?? "always"),
    );
    const globs = textInput("Files", (fields.globs ?? []).join(", "), "src/**/*.ts, *.tsx");
    const description = textInput(
      "Description",
      fields.description ?? "",
      "When it applies, e.g. When writing tests",
    );
    const subagents = textInput(
      "Subagents",
      fields.subagents ? (fields.subagents.length ? fields.subagents.join(", ") : "none") : "",
      "Default; or reviewer, test-runner; * for all; none",
    );
    const globsField = field("Files", globs, "Globs, comma-separated");
    const descField = field("Description", description);
    const sync = () => {
      globsField.hidden = scope.value !== "globs";
    };
    sync();
    st.add(on(scope, "change", sync));
    const element = h(
      "div",
      { class: "agent-page-grid" },
      allowed.length ? field("Scope", scope) : null,
      allowed.length ? globsField : null,
      allowed.length ? descField : null,
      field(
        "Subagents",
        subagents,
        "Which subagents also get it. Empty: the default (always-on rules go to subagents that load rules).",
      ),
    );
    return {
      element,
      read: () => ({
        scope: (scope.value as RuleScope) || "always",
        globs: splitGlobs(globs.value),
        description: description.value.trim(),
        ...(() => {
          const v = parseSubagentField(subagents.value);
          return v === undefined ? {} : { subagents: v };
        })(),
      }),
    };
  }

  private editForm(st: DisposableStore, r: ActiveRule): HTMLElement {
    const allowed = r.user ? [] : scopesFor(r.source, r.path);
    const parts = this.scopeFields(st, allowed, { ...fieldsOf(r) });
    const save = pageButton(
      st,
      "Save",
      "check",
      async () => {
        const f = parts.read();
        const done = await this.run("agent.updateRule", {
          path: r.path,
          ...(allowed.length && {
            scope: f.scope,
            globs: f.globs,
            description: f.description,
          }),
          subagents: f.subagents ? (f.subagents.length ? f.subagents.join(", ") : "none") : "",
        });
        if (done) {
          this.editing = null;
          rulesVersion.value++;
        }
      },
      "button button-primary button-sm",
    );
    return h(
      "div",
      { class: "ai-form" },
      allowed.length
        ? null
        : h(
            "p",
            { class: "ai-row-detail" },
            r.user
              ? "Your own rules file holds in every project."
              : "Where this file is decides when it applies.",
          ),
      parts.element,
      h(
        "div",
        { class: "ai-form-actions" },
        save,
        pageButton(st, "Cancel", null, () => this.open(null)),
      ),
    );
  }

  private newForm(st: DisposableStore): HTMLElement {
    const template = selectInput(
      "Template",
      TEMPLATES.map((t) => [t, TEMPLATE_LABELS[t]] as const),
      "cursor",
    );
    const name = textInput("Name", "", "e.g. Testing");
    const folder = textInput("Folder", "", "Empty: the whole project; or web, packages/api");
    const parts = this.scopeFields(st, ["always", "globs", "description", "manual"], {
      scope: "always",
    });
    const text = textArea("Rule text", "", 8);
    const create = pageButton(
      st,
      "Create",
      "plus",
      async () => {
        const f = parts.read();
        const done = (await this.run("agent.createRule", {
          template: template.value,
          name: name.value,
          scope: f.scope,
          globs: f.globs,
          description: f.description,
          ...(f.subagents && { subagents: f.subagents }),
          folder: folder.value,
          body: text.value,
        })) as { path?: string } | null;
        if (done?.path) {
          this.editing = null;
          rulesVersion.value++;
        }
      },
      "button button-primary button-sm",
    );
    return h(
      "div",
      { class: "ai-form" },
      h(
        "div",
        { class: "agent-page-grid" },
        field("Template", template),
        field("Name", name),
        field("Folder", folder, "A Cursor rule or AGENTS.md section for a subfolder only"),
      ),
      parts.element,
      field("Text", text),
      h(
        "div",
        { class: "ai-form-actions" },
        create,
        pageButton(st, "Cancel", null, () => this.open(null)),
      ),
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

async function readText(path: string): Promise<string | null> {
  return fsIpc
    .read(path)
    .then((b) => new TextDecoder().decode(b))
    .catch(() => null);
}

export function registerRulesPage(
  sub: DisposableStore,
  services: WorkbenchServices,
  rules: RulesService,
): void {
  const { dispatcher, workspace } = services;
  sub.add(
    addCustomizeSection({
      id: "rules",
      label: "Rules",
      icon: "book-open",
      detail: "Every rules file the agent follows: scope, subagents, on / off, new from a template",
      keywords: "agents.md cursor copilot claude instructions",
      order: 30,
      page: { create: () => new RulesView(services, rules) },
    }),
  );
  const find = async (path: string) => {
    rules.invalidate();
    const rule = (await rules.all()).find((r) => r.path === path || r.abs === path);
    if (!rule) throw new Error(`No rules file ${path} (agent.listRules lists them).`);
    return rule;
  };
  const changed = () => {
    rules.invalidate();
    rulesVersion.value++;
  };
  /** `rel` in workspace folder `root` (D251: the one picked; the only one with one folder). */
  const inFolder = (rel: string, root: string | null) => {
    if (!root) throw new Error("Open a folder first.");
    const abs = resolveInRoot(root, rel);
    if (!isWithin(root, abs)) throw new Error(`${rel} is outside the folder.`);
    return abs;
  };
  const scopeInput = s.enum(SCOPES).describe("When it applies").optional();

  sub.add(
    dispatcher.register({
      id: "agent.showRules",
      title: "Rules…",
      category: "Agent",
      description:
        "Opens the Rules page: every rules file the agent follows (AGENTS.md, CLAUDE.md, .cursor/rules, .github/instructions, .claude/rules, your own) with its source, scope and the subagents it's for, to turn one off, edit it, delete it or add one from a template.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => openCustomize(services, "rules"),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setRuleEnabled",
      title: "Turn an agent rule on or off",
      category: "Agent",
      description:
        "Turns a rules file off (no agent or subagent gets it) or on again, in this folder's settings (agent.rules.disabled). `path` as agent.listRules gives it.",
      input: s.object({ path: s.string(), enabled: s.boolean() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ path, enabled }, ctx) => {
        const rule = await find(path);
        const off = disabledRules(services);
        if (enabled) off.delete(rule.path);
        else off.add(rule.path);
        await ctx.execute("settings.set", {
          key: "agent.rules.disabled",
          value: [...off].sort(),
          scope: workspace.root.peek() && !rule.user ? "workspace" : "user",
        });
        changed();
        return { path: rule.path, enabled };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.createRule",
      title: "New agent rule…",
      category: "Agent",
      description:
        "Adds a rule from a template: `cursor` (.cursor/rules/<name>.mdc, or <folder>/.cursor/rules for a subfolder), `agents` (a section added to AGENTS.md, or <folder>/AGENTS.md), `copilot` (.github/instructions/<name>.instructions.md) or `claude` (.claude/rules/<name>.md). `scope`: always, globs (with `globs`), description (with `description`) or manual; `subagents` lists the subagents it's for ([\"*\"] all, [] none). Opens it afterwards when `open` is true. In a multi-root workspace `workspaceFolder` (a folder's path or name) says which folder it goes in; without it, the active editor's folder, else the user picks.",
      input: s.object({
        template: s.enum(TEMPLATES),
        name: s.string(),
        scope: scopeInput,
        globs: s.array(s.string()).optional(),
        description: s.string().optional(),
        subagents: s.array(s.string()).optional(),
        folder: s.string().optional(),
        body: s.string().optional(),
        open: s.boolean().optional(),
        workspaceFolder: s
          .string()
          .describe("Multi-root workspaces: the workspace folder (path or name) it goes in")
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async (input, ctx) => {
        if (!input.name.trim() && input.template !== "agents")
          throw new Error("Give the rule a name.");
        if (input.scope === "globs" && !input.globs?.length)
          throw new Error("A rule for matching files needs at least one glob.");
        if (input.scope === "description" && !input.description?.trim())
          throw new Error("A rule applied by description needs a description.");
        const preview = newRule(input.template, input.name, {
          scope: input.scope ?? "always",
          ...(input.globs && { globs: input.globs }),
          ...(input.description && { description: input.description }),
          ...(input.subagents && { subagents: input.subagents }),
          ...(input.folder && { folder: input.folder }),
          ...(input.body && { body: input.body }),
        });
        if (!workspace.root.peek()) throw new Error("Open a folder first.");
        const target = await pickWorkspaceFolder(
          services,
          input.workspaceFolder,
          "Add the rule to which folder?",
        );
        if (!target) return null;
        const abs = inFolder(preview.path, target);
        const existing = await readText(abs);
        const made = newRule(
          input.template,
          input.name,
          {
            scope: input.scope ?? "always",
            ...(input.globs && { globs: input.globs }),
            ...(input.description && { description: input.description }),
            ...(input.subagents && { subagents: input.subagents }),
            ...(input.folder && { folder: input.folder }),
            ...(input.body && { body: input.body }),
          },
          existing,
        );
        if (!made.append && existing !== null)
          throw new Error(`${made.path} exists already: edit it, or pick another name.`);
        // fs.write makes the folders (.cursor/rules, .claude/rules…).
        await fsIpc.write(
          abs,
          new TextEncoder().encode(made.append ? `${existing ?? ""}${made.text}` : made.text),
        );
        changed();
        if (input.open) await ctx.execute("editor.openFile", { path: abs }).catch(() => {});
        return { path: workspace.relative(abs), appended: made.append };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.updateRule",
      title: "Edit an agent rule",
      category: "Agent",
      description:
        'Changes a rules file in place: its `scope` (always, globs, description, folder, manual; written in the file\'s own front matter: Cursor\'s alwaysApply / globs / description, Copilot\'s applyTo, Claude Code\'s paths), `globs`, `description`, `subagents` ("reviewer, test-runner", "*" for all, "none", or "" for the default) and its text (`body`, without the front matter).',
      input: s.object({
        path: s.string(),
        scope: scopeInput,
        globs: s.array(s.string()).optional(),
        description: s.string().optional(),
        subagents: s.string().optional(),
        body: s.string().optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ path, scope, globs, description, subagents, body }) => {
        const rule = await find(path);
        const text = (await readText(rule.abs)) ?? "";
        const allowed = rule.user ? [] : scopesFor(rule.source, rule.path);
        if (scope && !allowed.includes(scope))
          throw new Error(
            allowed.length
              ? `${rule.path} can be: ${allowed.join(", ")}.`
              : `Where ${rule.path} is decides when it applies; only its text can change.`,
          );
        const current = fieldsOf(rule);
        const values: Record<string, string | null> =
          scope || globs || description !== undefined
            ? frontMatterFor(rule.source, {
                scope: scope ?? current.scope,
                globs: globs ?? current.globs ?? [],
                ...((description ?? current.description) && {
                  description: description ?? current.description ?? "",
                }),
              })
            : {};
        if (subagents !== undefined) {
          const list = parseSubagentField(subagents);
          values.subagents = list === undefined ? null : list.length ? list.join(", ") : "none";
        }
        let next = body === undefined ? text : replaceBody(text, body);
        if (Object.keys(values).length) next = setFrontMatter(next, values);
        if (next !== text) await fsIpc.write(rule.abs, new TextEncoder().encode(next));
        changed();
        return { path: rule.path, changed: next !== text };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.deleteRule",
      title: "Delete an agent rule",
      category: "Agent",
      description:
        "Deletes a project rules file (asks first when a person runs it). Your own rules file isn't deleted here.",
      input: s.object({ path: s.string() }),
      effects: ["destructive"],
      agent: "hidden",
      palette: false,
      run: async ({ path }, ctx) => {
        const rule = await find(path);
        if (rule.user) throw new Error("Your own rules file isn't deleted from here: open it.");
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            `Delete ${rule.path}?`,
            "The file is deleted from the folder. Turn it off instead to keep it.",
            "Delete",
            true,
          ))
        )
          return { deleted: false };
        await fsIpc.delete(rule.abs);
        // Off-list entries for it go too.
        const off = disabledRules(services);
        if (off.delete(rule.path))
          await ctx
            .execute("settings.set", {
              key: "agent.rules.disabled",
              value: [...off].sort(),
              scope: "workspace",
            })
            .catch(() => {});
        changed();
        return { deleted: rule.path };
      },
    }),
  );
}

/** The text with its body (what follows the front matter) replaced. */
export function replaceBody(text: string, body: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const tail = body.endsWith("\n") ? body : `${body}\n`;
  return m ? `${m[0]}${tail}` : tail;
}
