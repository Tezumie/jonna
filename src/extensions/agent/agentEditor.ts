// The agent editor (D230): one dock tab per agent, a form over its Markdown file. A new agent is a
// draft until "Create agent" (`agent.createAgent`) writes the file; after that every field writes
// the file as you edit (debounced, through setHeaderFields / setBody, so keys it doesn't know stay)
// and a change on disk reloads the form. The face, name, role, what it does, instructions, model,
// access and where it lives; templates fill a draft. Buttons run commands (agent.chatWith,
// agent.duplicateAgent, agent.deleteSubagent, agent.chooseModel, editor.openFile…).

import { type AgentDraft, draftFaceCode } from "../../core/agent/agentDraft";
import { agentIdFromLabel, setBody, setHeaderFields } from "../../core/agent/agentFile";
import {
  ACCESS_LEVELS,
  AGENT_TEMPLATES,
  type AgentAccess,
  type AgentTemplate,
  accessFields,
  accessOf,
  parseToolList,
} from "../../core/agent/agentTemplates";
import { TEAM_START_MODES } from "../../core/agent/builtInAgents";
import { BUILT_IN_MODES } from "../../core/agent/chatModes";
import {
  encodeFace,
  type FaceSpec,
  faceFromSeed,
  isModelIcon,
  MODEL_ICON,
  parseFace,
  randomFace,
} from "../../core/agent/faces";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import type { StartMode } from "../../core/agent/subagents";
import {
  agentLabel,
  isBundledAgent,
  parseSubagentFile,
  type SubagentDef,
  subagentsField,
  validSubagentName,
} from "../../core/agent/subagents";
import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { fsIpc } from "../../core/ipc/fs";
import { DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { displayPath, isWindowsPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderName } from "../../workbench/workspaceFolder";
import { externalAgents } from "./acpAgents";
import { FacePicker, markRadios, rovingRadios } from "./facePicker";
import { mainAgent } from "./mainAgent";
import { drawMainAgentEditor } from "./mainAgentEditor";
import { chooseModelAt, modelChipLabel } from "./modelChooser";
import type { ProviderRegistry } from "./providers";
import { projectInstructionsBlocked } from "./riskyGuard";
import {
  agentExternalModel,
  type SubagentRegistry,
  subagentEnabled,
  subagentModel,
} from "./subagents";
import { subagentsSection } from "./subagentsSection";

export const AGENT_EDITOR_VIEW = "agent.agentEditor";

/** Built-in names a new agent can't take (explore has its own tool) or would replace. */
const RESERVED = new Set(["explore"]);

type Scope = "project" | "user";

export interface AgentEditorDeps {
  services: WorkbenchServices;
  providers: ProviderRegistry;
  registry: SubagentRegistry;
}

/** A tab's state: an agent by name, or a draft (from a template, or a copy of an agent). */
export type AgentEditorState =
  | { name: string }
  | { draft: true; template?: string; scope?: Scope; from?: string; generated?: AgentDraft };

interface Form {
  label: string;
  role: string;
  description: string;
  instructions: string;
  /** Its character face (kept while it shows its model's logo, for going back). */
  face: FaceSpec;
  /** It shows its model's logo instead (D270): an agent's default. */
  modelIcon: boolean;
  /** null: a tools list of its own (Advanced shows it). */
  access: AgentAccess | null;
  tools: string;
  maxSteps: string;
  scope: Scope;
  /** A draft's model (an agent's own lives in agent.subagents); null: the chat's. */
  model: string | null;
  /** The mode its chats start in (D249). */
  startMode: StartMode;
  /** The subagents it may run (D288: its file's `subagents:`); null: all. */
  subagents: string[] | null;
  template: string | null;
}

/** The modes a chat with an agent can start in (D249), as the editor offers them. */
const START_MODE_CHOICES: readonly { id: StartMode; label: string; detail: string }[] = [
  { id: "agent", label: "Agent", detail: "Does the work its access allows" },
  { id: "plan", label: "Plan", detail: "Researches and writes a plan; Build carries it out" },
  { id: "ask", label: "Ask", detail: "Answers and explains, read-only" },
];

const SAVE_DELAY_MS = 400;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function formFromDef(def: SubagentDef): Form {
  return {
    label: agentLabel(def),
    role: def.role ?? "",
    description: def.description,
    instructions: def.prompt,
    face: parseFace(def.icon) ?? faceFromSeed(def.name),
    modelIcon: isModelIcon(def.icon),
    access: accessOf(def),
    tools: def.tools?.join(", ") ?? "",
    maxSteps: def.maxSteps ? String(def.maxSteps) : "",
    scope: def.source === "user" ? "user" : "project",
    model: null,
    // A team agent's file from before `mode:` starts as the team's does (D249).
    startMode:
      def.startMode ?? (def.source === "user" ? TEAM_START_MODES[def.name] : undefined) ?? "agent",
    subagents: def.subagents ? [...def.subagents] : null,
    template: null,
  };
}

function formFromTemplate(t: AgentTemplate, face: FaceSpec, scope: Scope): Form {
  return {
    label: t.label,
    role: t.role,
    description: t.description,
    instructions: t.instructions,
    face: parseFace(t.icon) ?? face,
    // A new agent shows its model's logo (D270); the template's face is there for Character.
    modelIcon: true,
    access: t.access,
    tools: "",
    maxSteps: "",
    scope,
    model: null,
    startMode: t.startMode ?? "agent",
    subagents: null,
    template: t.id,
  };
}

/** A drafted agent (D245) as the form: a template that isn't one of the chips. */
function formFromDraft(draft: AgentDraft, scope: Scope): Form {
  const icon = draftFaceCode(draft.label);
  return {
    ...formFromTemplate({ id: "", ...draft, icon }, randomFace(), scope),
    template: null,
  };
}

/** Where an agent's file came from, as the page and the editor say it. */
export function agentSourceLabel(def: Pick<SubagentDef, "source" | "path">): string {
  if (isBundledAgent(def)) return "Built in";
  if (def.path?.replaceAll("\\", "/").includes("/.claude/agents/")) return "Claude Code";
  return def.source === "user" ? "You" : "Project";
}

export class AgentEditorView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Listeners of the form as drawn now (redrawn when a draft becomes an agent). */
  private readonly ui = this.store.add(new DisposableStore());
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly body: HTMLElement;
  private name: string | null;
  /** The main agent (D286): its own, shorter page (mainAgentEditor.ts), no file. */
  private readonly main: boolean;
  private form: Form;
  private picker: FacePicker | undefined;
  /** The registry has been read once (until then a missing agent may just not be loaded yet). */
  private loaded = false;
  /** The file as last read or written: a different text on disk means someone else changed it. */
  private lastText = "";
  private pending: ((text: string) => string)[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private creating = false;
  /** The agent's file as last seen (to tell a deleted agent from one not loaded). */
  private path: string | null = null;
  /** Live parts of the drawn form, updated in place. */
  private parts: {
    fields: Partial<Record<keyof Form, HTMLInputElement | HTMLTextAreaElement>>;
    id?: HTMLElement;
    descriptionHint?: HTMLElement;
    count?: HTMLElement;
    model?: HTMLElement;
    access?: HTMLElement;
    startMode?: HTMLElement;
    accessNote?: HTMLElement;
    scope?: HTMLElement;
    templates?: HTMLElement;
    create?: HTMLButtonElement;
    footerNote?: HTMLElement;
    note?: HTMLElement;
    enabled?: HTMLInputElement;
    chat?: HTMLButtonElement;
    /** Redraws the Subagents section (D288) from the form. */
    subagents?: () => void;
  } = { fields: {} };

  constructor(
    state: AgentEditorState,
    private readonly ctx: DockViewContext,
    private readonly deps: AgentEditorDeps,
  ) {
    this.body = h("div", { class: "ae-page" });
    this.element = h("div", { class: "ai-page ae-scroll", tabindex: "-1" }, this.body);
    const services = deps.services;
    this.name = "name" in state ? state.name : null;
    this.main = this.name === MAIN_MEMBER;
    if ("name" in state) {
      const def = deps.registry.get(state.name);
      this.form = def ? formFromDef(def) : formFromTemplate(blank(), randomFace(), "project");
    } else {
      // Your own agents folder by default: an agent is there in every project (D233); sharing
      // one through the project's git is the choice to make.
      const scope: Scope = state.scope ?? "user";
      const from = state.from ? deps.registry.get(state.from) : undefined;
      if (from) {
        this.form = {
          ...formFromDef(from),
          label: `${agentLabel(from)} copy`,
          scope,
          template: null,
        };
        this.form.model = subagentModel(services, from);
      } else if (state.generated) {
        this.form = formFromDraft(state.generated, scope);
      } else {
        const t = AGENT_TEMPLATES.find((x) => x.id === state.template) ?? blank();
        this.form = formFromTemplate(t, randomFace(), scope);
      }
    }
    this.store.add(
      on(this.element, "keydown", (e) => {
        if (e.key !== "Escape") return;
        const target = e.target as HTMLElement;
        // The keyboard service sees Escape first (capture) and may mark it handled; a field's own
        // Esc (an open suggestion) is left alone then, but with focus on the page itself nothing
        // else wants it.
        if (e.defaultPrevented && target.matches("input, textarea")) return;
        if (target.matches("input, textarea")) {
          // Out of the field (the page's keys work again); a second Esc closes an empty draft.
          e.preventDefault();
          this.element.focus();
        } else if (!this.name && !this.form.label.trim() && !this.form.description.trim()) {
          // An empty draft: Esc puts it away (one with something typed stays).
          e.preventDefault();
          this.ctx.close();
        }
      }),
    );
    this.store.add(
      toDisposable(() => {
        clearTimeout(this.noteTimer);
        // Unsaved edits are written as the tab closes.
        if (this.pending.length) void this.flush();
      }),
    );
    this.draw();
    // The agent's file read again, the model or switch changed elsewhere: the form follows.
    this.store.add(
      effect(() => {
        const list = deps.registry.list.value;
        services.settings.version.value;
        if (this.name && this.loaded && !this.main) {
          const def = list.find((d) => d.name === this.name);
          void this.sync(def);
        }
        this.updateLive();
        return undefined;
      }),
    );
    void deps.registry.refresh().then(() => {
      this.loaded = true;
      if (this.name && !this.main) void this.sync(deps.registry.get(this.name), true);
    });
  }

  // ---- Commands --------------------------------------------------------------------------

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return this.deps.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.deps.services.notifications.show(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });
  }

  private def(): SubagentDef | undefined {
    return this.name ? this.deps.registry.get(this.name) : undefined;
  }

  // ---- Drawing ---------------------------------------------------------------------------

  private draw(): void {
    this.ui.clear();
    this.picker = undefined;
    this.parts = { fields: {} };
    if (this.main) {
      drawMainAgentEditor(
        this.body,
        this.ui,
        this.deps.services,
        this.deps.providers,
        this.deps.registry,
      );
      return;
    }
    const def = this.def();
    if (this.name && this.loaded && !def) {
      replaceChildren(this.body, this.goneState());
      return;
    }
    if (this.name && !def) {
      replaceChildren(this.body);
      return;
    }
    replaceChildren(
      this.body,
      this.crumbs(def),
      this.name ? null : this.templatesRow(),
      this.faceSection(),
      h(
        "div",
        { class: "ae-fields" },
        this.identityFields(),
        this.descriptionField(),
        this.instructionsField(),
        this.modelField(),
        this.accessField(),
        this.startModeField(),
        this.advancedField(),
        this.whereField(),
      ),
      this.name ? this.subagentsField() : null,
      this.footer(),
    );
    this.fill(true);
  }

  /** Back to Customize › Agents, and where this page is (D241). */
  private crumbs(def: SubagentDef | undefined): HTMLElement {
    const back = h(
      "button",
      { class: "ae-crumb-link", type: "button", "data-command": "agent.showAgentConfig" },
      "Agents",
    );
    setTooltip(back, "Back to your agents");
    this.ui.add(on(back, "click", () => void this.run("agent.showAgentConfig")));
    return h(
      "nav",
      { class: "ae-crumbs", "aria-label": "Breadcrumb" },
      back,
      h("span", { class: "ae-crumb-sep", "aria-hidden": "true" }, icon("chevron-right")),
      h(
        "span",
        { class: "ae-crumb-here", "aria-current": "page" },
        def ? agentLabel(def) : "New agent",
      ),
    );
  }

  private goneState(): HTMLElement {
    const close = h("button", { class: "button button-secondary", type: "button" }, "Close");
    this.ui.add(on(close, "click", () => this.ctx.close()));
    return h(
      "div",
      { class: "empty-state ae-gone" },
      icon("bot"),
      h("div", { class: "empty-state-title" }, `${this.name} isn't loaded`),
      h(
        "div",
        { class: "empty-state-text" },
        "Its file was deleted or renamed, or the folder is in restricted mode.",
      ),
      h("div", { class: "empty-state-actions" }, close),
    );
  }

  private templatesRow(): HTMLElement {
    const row = h("div", {
      class: "ae-templates",
      role: "group",
      "aria-label": "Start from a template",
    });
    // Describe it (D245): a model drafts the agent; the form fills in for checking.
    const describe = h(
      "button",
      { class: "ae-template ae-describe", type: "button", "data-command": "agent.generateAgent" },
      icon("sparkles"),
      "Describe it…",
    );
    setTooltip(describe, "Say what the agent should do; a model drafts it for you to check");
    this.ui.add(
      on(describe, "click", async () => {
        describe.toggleAttribute("disabled", true);
        try {
          const out = (await this.deps.services.dispatcher.execute("agent.generateAgent", {
            open: false,
          })) as { draft?: AgentDraft } | null;
          if (out?.draft) this.applyDraft(out.draft);
        } catch (err) {
          this.deps.services.notifications.show(
            "error",
            err instanceof Error ? err.message : String(err),
          );
        } finally {
          describe.toggleAttribute("disabled", false);
        }
      }),
    );
    row.append(describe);
    for (const t of AGENT_TEMPLATES) {
      const chip = h(
        "button",
        { class: "ae-template", type: "button", "data-template": t.id, "aria-pressed": "false" },
        t.label || "Blank",
      );
      setTooltip(chip, t.description || "Start from an empty agent");
      this.ui.add(on(chip, "click", () => this.applyTemplate(t)));
      row.append(chip);
    }
    this.parts.templates = row;
    return h(
      "div",
      { class: "ae-templates-wrap" },
      h("div", { class: "ae-kicker" }, "Start from"),
      row,
    );
  }

  private applyDraft(draft: AgentDraft): void {
    const model = this.form.model;
    this.form = { ...formFromDraft(draft, this.form.scope), model };
    this.fill(true);
    this.changed.fire();
    this.parts.fields.label?.focus();
  }

  private applyTemplate(t: AgentTemplate): void {
    const scope = this.form.scope;
    const model = this.form.model;
    this.form = { ...formFromTemplate(t, this.form.face, scope), model };
    if (t.id === "blank") this.form.face = randomFace(this.form.face);
    this.fill(true);
    this.changed.fire();
    this.parts.fields.label?.focus();
  }

  private faceSection(): HTMLElement {
    const host = h("div");
    this.picker = this.ui.add(
      new FacePicker(host, {
        face: this.form.face,
        model: this.form.modelIcon,
        modelKey: () => this.modelKey(),
        onPick: (face) => {
          this.form.face = face;
          this.form.modelIcon = false;
          if (this.name) this.queue({ icon: encodeFace(face) });
        },
        onModel: () => {
          this.form.modelIcon = true;
          if (this.name) this.queue({ icon: MODEL_ICON });
        },
      }),
    );
    return host;
  }

  private field(
    key: keyof Form,
    label: string,
    control: HTMLInputElement | HTMLTextAreaElement,
    ...extra: (HTMLElement | null)[]
  ): HTMLElement {
    const id = `ae-${key}-${this.ctx.tabId}`;
    control.id = id;
    control.dataset.field = key;
    this.parts.fields[key] = control;
    return h(
      "div",
      { class: "ae-field", "data-for": key },
      h("label", { class: "ae-label", for: id }, label),
      control,
      ...extra,
    );
  }

  private input(placeholder: string, max?: number): HTMLInputElement {
    return h("input", {
      class: "input ae-input",
      type: "text",
      placeholder,
      spellcheck: "false",
      autocomplete: "off",
      ...(max && { maxlength: String(max) }),
    }) as HTMLInputElement;
  }

  /** A textarea that grows with its text (no inner scrollbar until the page scrolls). */
  private textarea(placeholder: string, rows: number): HTMLTextAreaElement {
    const area = h("textarea", {
      class: "input ae-textarea",
      placeholder,
      rows: String(rows),
    }) as HTMLTextAreaElement;
    this.ui.add(on(area, "input", () => this.grow(area)));
    return area;
  }

  private grow(area: HTMLTextAreaElement): void {
    area.style.height = "auto";
    // Not on screen yet (a tab not shown): its rows hold until onShow measures it.
    if (!area.isConnected || area.scrollHeight === 0) return;
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  private growAll(): void {
    for (const el of Object.values(this.parts.fields))
      if (el instanceof HTMLTextAreaElement) this.grow(el);
  }

  /** Enter in a one-line field: a draft is created, an agent saved at once. */
  private enterSubmits(el: HTMLElement): void {
    this.ui.add(
      on(el, "keydown", (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        if (this.name) void this.flush();
        else void this.create();
      }),
    );
  }

  private identityFields(): HTMLElement {
    const label = this.input("e.g. Test runner", 60);
    const role = this.input("e.g. Reviewer", 40);
    this.enterSubmits(label);
    this.enterSubmits(role);
    const id = h("div", { class: "ae-hint ae-id" });
    this.parts.id = id;
    this.ui.add(
      on(label, "input", () => {
        this.form.label = label.value;
        this.updateLive();
        this.changed.fire();
        if (!this.name) return;
        const v = label.value.trim();
        if (v) this.queue({ label: v === this.name ? null : v });
      }),
    );
    this.ui.add(
      on(role, "input", () => {
        this.form.role = role.value;
        if (this.name) this.queue({ role: role.value.trim() || null });
      }),
    );
    return h(
      "div",
      { class: "ae-row" },
      this.field("label", "Name", label, id),
      this.field(
        "role",
        "Role",
        role,
        h("div", { class: "ae-hint" }, "Optional, a short tag beside its name"),
      ),
    );
  }

  private descriptionField(): HTMLElement {
    const area = this.textarea(
      "e.g. Reviews a change for bugs and missing tests. Use after editing code.",
      2,
    );
    area.classList.add("ae-oneline");
    this.enterSubmits(area);
    const hint = h(
      "div",
      { class: "ae-hint" },
      "The main agent reads this to decide when to hand it work",
    );
    this.parts.descriptionHint = hint;
    this.ui.add(
      on(area, "input", () => {
        // One line in the file: a pasted newline becomes a space.
        if (/\r?\n/.test(area.value)) area.value = area.value.replace(/\r?\n/g, " ");
        this.form.description = area.value;
        this.updateLive();
        const v = area.value.trim();
        if (this.name && v) this.queue({ description: v });
      }),
    );
    return this.field("description", "What does it do?", area, hint);
  }

  private instructionsField(): HTMLElement {
    const area = this.textarea(
      "How it should work: what to look at, what to do, what its report should say.",
      8,
    );
    area.classList.add("ae-instructions");
    const count = h("span", { class: "ae-count", "aria-live": "off" });
    this.parts.count = count;
    this.ui.add(
      on(area, "input", () => {
        this.form.instructions = area.value;
        this.updateLive();
        if (this.name) {
          const body = area.value;
          this.queue((text) => setBody(text, body));
        }
      }),
    );
    const el = this.field("instructions", "Instructions", area);
    el.querySelector(".ae-label")?.append(count);
    return el;
  }

  private modelField(): HTMLElement {
    const chip = h("button", {
      class: "ac-model ae-model",
      type: "button",
      "aria-haspopup": "menu",
    });
    this.parts.model = chip;
    this.ui.add(
      on(chip, "click", () => {
        if (this.name) {
          chooseModelAt(chip, this.deps.services, this.deps.registry, `subagent:${this.name}`);
          return;
        }
        // A draft's model is part of the form until it's created.
        const models = this.deps.providers.models.peek().filter((m) => !m.key.startsWith("acp/"));
        // An external agent answers for this one in chats (D249).
        const agents = externalAgents(this.deps.services);
        showMenu(
          chip,
          [
            {
              label: "Same as the chat",
              checked: !this.form.model,
              run: () => this.setDraftModel(null),
            },
            ...models.map((m, i) => ({
              label: m.model,
              keybinding: m.provider.name,
              checked: this.form.model === m.key,
              separatorBefore: i === 0,
              run: () => this.setDraftModel(m.key),
            })),
            ...agents.map((a, i) => ({
              label: a.name,
              keybinding: "External agent",
              checked: this.form.model === `acp/${a.name}`,
              separatorBefore: i === 0,
              run: () => this.setDraftModel(`acp/${a.name}`),
            })),
          ],
          { label: "Model", search: models.length + agents.length > 8, focusFirst: true },
        );
      }),
    );
    return h(
      "div",
      { class: "ae-field ae-inline", "data-for": "model" },
      h("span", { class: "ae-label" }, "Model"),
      chip,
    );
  }

  /** The model it runs on (null: the chat's, so the default), for its model icon. */
  private modelKey(): string | null {
    const def = this.name ? this.deps.registry.get(this.name) : undefined;
    return this.name && def ? subagentModel(this.deps.services, def) : this.form.model;
  }

  private setDraftModel(model: string | null): void {
    this.form.model = model;
    this.updateLive();
  }

  private accessField(): HTMLElement {
    const group = h("div", { class: "ae-access", role: "radiogroup", "aria-label": "Access" });
    for (const level of ACCESS_LEVELS)
      group.append(
        h(
          "button",
          { class: "ae-option", type: "button", role: "radio", "data-access": level.id },
          h("span", { class: "ae-option-label" }, level.label),
          h("span", { class: "ae-option-detail" }, level.detail),
        ),
      );
    this.parts.access = group;
    rovingRadios(this.ui, group, (el) => this.setAccess(el.dataset.access as AgentAccess));
    const note = h("div", { class: "ae-hint" });
    this.parts.accessNote = note;
    return h(
      "div",
      { class: "ae-field", "data-for": "access" },
      h("span", { class: "ae-label" }, "Access"),
      group,
      note,
    );
  }

  /**
   * The subagents it may run (D288), saved as `subagents:` in its file like the other fields;
   * their models and instructions are shared, set here or on the main agent's page.
   */
  private subagentsField(): HTMLElement {
    const host = h("div", { class: "ae-subagents-host" });
    const sectionUi = this.ui.add(new DisposableStore());
    const draw = () => {
      sectionUi.clear();
      replaceChildren(
        host,
        subagentsSection(sectionUi, this.deps.services, this.deps.registry, {
          name: this.name ?? "",
          label: this.form.label.trim() || "This agent",
          allowed: this.form.subagents,
          mainLabel: mainAgent.peek().label,
          change: (name, allowed) => {
            const all = this.deps.registry.subagents().map((d) => d.name);
            const now = this.form.subagents ?? all;
            const next = allowed
              ? [...now.filter((n) => n.toLowerCase() !== name.toLowerCase()), name]
              : now.filter((n) => n.toLowerCase() !== name.toLowerCase());
            const field = subagentsField(next, all);
            this.form.subagents = field === null ? null : next;
            this.queue({ subagents: field });
            draw();
          },
        }),
      );
    };
    this.parts.subagents = draw;
    // Models picked and files added in .claude/agents show at once.
    this.ui.add(
      effect(() => {
        this.deps.services.settings.version.value;
        this.deps.registry.list.value;
        draw();
        return undefined;
      }),
    );
    return host;
  }

  /** The mode its chats start in (D249): written as `mode:` in its file. */
  private startModeField(): HTMLElement {
    const group = h("div", {
      class: "ae-access",
      role: "radiogroup",
      "aria-label": "Mode",
    });
    for (const choice of START_MODE_CHOICES)
      group.append(
        h(
          "button",
          { class: "ae-option", type: "button", role: "radio", "data-start": choice.id },
          h("span", { class: "ae-option-label" }, choice.label),
          h("span", { class: "ae-option-detail" }, choice.detail),
        ),
      );
    this.parts.startMode = group;
    rovingRadios(this.ui, group, (el) => {
      const mode = el.dataset.start as StartMode;
      if (this.form.startMode === mode) return;
      this.form.startMode = mode;
      this.updateLive();
      if (this.name) this.queue({ mode });
    });
    return h(
      "div",
      { class: "ae-field", "data-for": "startMode" },
      h("span", { class: "ae-label" }, "Mode"),
      group,
      h(
        "div",
        { class: "ae-hint" },
        "The mode its chats start in, as in the chat's mode menu: Agent does the work, Plan plans first (Build hands the plan to the main agent), Ask only answers",
      ),
    );
  }

  private setAccess(level: AgentAccess): void {
    if (this.form.access === level) return;
    this.form.access = level;
    this.form.tools = "";
    const tools = this.parts.fields.tools;
    if (tools) tools.value = "";
    this.updateLive();
    if (this.name) this.queue((text) => setHeaderFields(text, accessFields(level, text)));
  }

  private advancedField(): HTMLElement {
    const tools = this.input("Every tool its access allows");
    const steps = this.input("30", 3);
    steps.inputMode = "numeric";
    this.ui.add(
      on(tools, "input", () => {
        this.form.tools = tools.value;
        const list = parseToolList(tools.value);
        // A list of its own: no level is picked until one is again.
        this.form.access = list.length
          ? accessOf({ readOnly: this.form.access === "read", tools: list })
          : this.form.access === "read"
            ? "read"
            : "full";
        this.updateLive();
        if (this.name) this.queue({ tools: list.length ? list.join(", ") : null });
      }),
    );
    this.ui.add(
      on(steps, "input", () => {
        steps.value = steps.value.replace(/\D/g, "");
        this.form.maxSteps = steps.value;
        const n = Number(steps.value);
        if (this.name)
          this.queue({ maxTurns: n > 0 ? String(Math.min(200, n)) : null, maxSteps: null });
      }),
    );
    const open = this.form.access === null || !!this.form.maxSteps;
    return h(
      "details",
      { class: "ae-advanced", ...(open && { open: true }) },
      h("summary", { class: "ae-summary" }, icon("chevron-right"), "Advanced"),
      h(
        "div",
        { class: "ae-row" },
        this.field(
          "tools",
          "Tools",
          tools,
          h("div", { class: "ae-hint" }, "Tool names, comma separated"),
        ),
        this.field("maxSteps", "Max steps", steps),
      ),
    );
  }

  private whereField(): HTMLElement {
    const def = this.def();
    const services = this.deps.services;
    if (this.name && def?.path) {
      const path = def.path;
      // As the workspace names it (D251: "api/…" in another folder of a multi-root workspace).
      const owner = services.workspace.folderOf(path);
      const shown = owner
        ? services.workspace.folders.peek().length > 1
          ? `${owner.name}${isWindowsPath(path) ? "\\" : "/"}${displayPath(owner.path, path)}`
          : displayPath(owner.path, path)
        : path;
      const open = h(
        "button",
        { class: "button button-secondary button-sm", type: "button" },
        "Open file",
      );
      const reveal = h(
        "button",
        { class: "button button-secondary button-sm", type: "button" },
        "Reveal",
      );
      setTooltip(reveal, "Show it in the file manager");
      this.ui.add(on(open, "click", () => void this.run("editor.openFile", { path })));
      this.ui.add(on(reveal, "click", () => void this.run("explorer.revealInOs", { path })));
      const path_ = h("span", { class: "ae-path" }, shown);
      setTooltip(path_, path);
      return h(
        "div",
        { class: "ae-field", "data-for": "where" },
        h("span", { class: "ae-label" }, "Where it lives"),
        h(
          "div",
          { class: "ae-where" },
          h("span", { class: "ae-source" }, agentSourceLabel(def)),
          path_,
          h("span", { class: "ae-where-actions" }, open, reveal),
        ),
      );
    }
    const projectOk = !!services.workspace.root.peek() && !projectInstructionsBlocked(services);
    const group = h("div", {
      class: "ae-access ae-scope",
      role: "radiogroup",
      "aria-label": "Where it lives",
    });
    for (const [scope, label, detail] of [
      ["user", "Every project", "Your agents folder, just for you"],
      ["project", "This project", `${workspaceFolderName()}/agents, shared through git`],
    ] as const)
      group.append(
        h(
          "button",
          {
            class: "ae-option",
            type: "button",
            role: "radio",
            "data-scope": scope,
            ...(scope === "project" && !projectOk && { disabled: true }),
          },
          h("span", { class: "ae-option-label" }, label),
          h(
            "span",
            { class: "ae-option-detail" },
            scope === "project" && !projectOk ? "Open a trusted folder first" : detail,
          ),
        ),
      );
    if (!projectOk && this.form.scope === "project") this.form.scope = "user";
    this.parts.scope = group;
    rovingRadios(this.ui, group, (el) => {
      this.form.scope = el.dataset.scope === "user" ? "user" : "project";
      this.updateLive();
    });
    return h(
      "div",
      { class: "ae-field", "data-for": "where" },
      h("span", { class: "ae-label" }, "Where it lives"),
      group,
    );
  }

  private footer(): HTMLElement {
    const note = h("span", { class: "ae-note", role: "status" });
    this.parts.note = note;
    if (!this.name) {
      const create = h(
        "button",
        { class: "button button-primary ae-create", type: "button" },
        "Create agent",
      ) as HTMLButtonElement;
      this.parts.create = create;
      this.parts.footerNote = note;
      this.ui.add(on(create, "click", () => void this.create()));
      return h(
        "div",
        { class: "ae-footer" },
        note,
        h("div", { class: "ae-footer-actions" }, create),
      );
    }
    const name = this.name;
    const enabled = h("input", {
      type: "checkbox",
      class: "switch",
      role: "switch",
      "aria-label": "Available to the agent and in chats",
    }) as HTMLInputElement;
    this.parts.enabled = enabled;
    this.ui.add(
      on(
        enabled,
        "change",
        () => void this.run("agent.setSubagent", { name, enabled: enabled.checked }),
      ),
    );
    setTooltip(enabled, "On: the main agent can hand it work, and you can chat with it");
    const chat = h(
      "button",
      { class: "button button-primary ae-chat", type: "button" },
      icon("message-square-code"),
      "Chat with it",
    ) as HTMLButtonElement;
    this.parts.chat = chat;
    this.ui.add(on(chat, "click", () => void this.chat()));
    const duplicate = h(
      "button",
      { class: "button button-secondary", type: "button" },
      "Duplicate",
    );
    this.ui.add(on(duplicate, "click", () => void this.run("agent.duplicateAgent", { name })));
    const remove = h(
      "button",
      { class: "button button-danger ae-delete", type: "button" },
      "Delete",
    );
    this.ui.add(
      on(remove, "click", async () => {
        await this.flush();
        const result = (await this.run("agent.deleteSubagent", { name })) as {
          deleted?: boolean;
        } | null;
        if (result?.deleted) this.ctx.close();
      }),
    );
    return h(
      "div",
      { class: "ae-footer" },
      h("label", { class: "ae-enabled" }, enabled, h("span", null, "On")),
      note,
      h("div", { class: "ae-footer-actions" }, remove, duplicate, chat),
    );
  }

  private async chat(): Promise<void> {
    if (!this.name) return;
    await this.flush();
    // agent.chatWith starts a chat in the agent's mode; without it, the same by hand.
    if (this.deps.services.dispatcher.has("agent.chatWith"))
      await this.run("agent.chatWith", { agent: this.name });
    else {
      await this.run("agent.newSession");
      await this.run("agent.setChatMode", { mode: `custom:${this.name}` });
    }
  }

  // ---- Values in place -------------------------------------------------------------------

  /** Puts the form's values into the fields (all of them, or all but the one being typed in). */
  private fill(all = false): void {
    this.parts.subagents?.();
    const active = document.activeElement;
    for (const [key, el] of Object.entries(this.parts.fields) as [
      keyof Form,
      HTMLInputElement | HTMLTextAreaElement,
    ][]) {
      if (!all && el === active) continue;
      const value = String(this.form[key] ?? "");
      if (el.value !== value) el.value = value;
      if (el instanceof HTMLTextAreaElement) this.grow(el);
    }
    this.picker?.set(this.form.face, this.form.modelIcon);
    this.updateLive();
  }

  /** Everything derived from the form: the id line, the count, the picked options, buttons. */
  private updateLive(): void {
    const { form, parts } = this;
    const def = this.def();
    const services = this.deps.services;
    if (parts.id) {
      if (this.name) parts.id.textContent = `Id: ${this.name} (the file's name; it stays)`;
      else {
        const problem = this.nameProblem();
        const id = agentIdFromLabel(form.label);
        const known = id ? this.deps.registry.get(id) : undefined;
        const replaces = !!known && isBundledAgent(known);
        parts.id.textContent =
          problem ??
          (id
            ? `Saved as ${id}.md${replaces ? `, in place of the built-in ${id}` : ""}`
            : "What you call it; the file name comes from it");
        parts.id.classList.toggle("is-error", !!problem && !!form.label.trim());
      }
    }
    if (parts.count) {
      const n = form.instructions.length;
      parts.count.textContent = `${n.toLocaleString()} character${n === 1 ? "" : "s"}`;
    }
    if (parts.descriptionHint)
      parts.descriptionHint.classList.toggle("is-error", !!this.name && !form.description.trim());
    if (parts.model) {
      const model = this.name && def ? subagentModel(services, def) : form.model;
      const fromFile = this.name && def?.model && def.model !== "inherit" ? def.model : null;
      const own = this.name ? agentExternalModel(this.deps.services, this.name) : undefined;
      const text = model ? modelChipLabel(this.deps.services, model, own) : "Same as the chat";
      replaceChildren(
        parts.model,
        icon("box"),
        h("span", { class: "ac-model-name" }, fromFile && model === fromFile ? fromFile : text),
        icon("chevron-down"),
      );
      parts.model.classList.toggle("is-inherit", !model);
      this.picker?.refreshModel();
      setTooltip(parts.model, model ? `${model}, click to change` : "Uses the chat's model");
    }
    markRadios(parts.access, (el) => el.dataset.access === form.access);
    markRadios(parts.startMode, (el) => el.dataset.start === form.startMode);
    if (parts.accessNote)
      parts.accessNote.textContent = form.access === null ? "Its own tool list (see Advanced)" : "";
    markRadios(parts.scope, (el) => el.dataset.scope === form.scope);
    if (parts.templates)
      for (const chip of parts.templates.querySelectorAll<HTMLElement>("[data-template]"))
        chip.setAttribute("aria-pressed", String(chip.dataset.template === form.template));
    if (parts.create) {
      const problem = this.createProblem();
      parts.create.disabled = !!problem || this.creating;
      if (parts.footerNote) parts.footerNote.textContent = problem ?? "";
    }
    if (parts.enabled && this.name) {
      const on_ = subagentEnabled(services, this.name);
      parts.enabled.checked = on_;
      parts.enabled.setAttribute("aria-checked", String(on_));
      if (parts.chat) {
        parts.chat.disabled = !on_;
        setTooltip(
          parts.chat,
          on_ ? "A new chat with this agent's instructions, tools and model" : "Turn it on first",
        );
      }
    }
  }

  /** Why the name can't be used (a draft), or null. */
  private nameProblem(): string | null {
    const label = this.form.label.trim();
    if (!label) return "Give it a name";
    const id = agentIdFromLabel(label);
    if (!id || !validSubagentName(id)) return "Use some letters or digits in the name";
    if (RESERVED.has(id)) return `${id} is the built-in explore helper's name`;
    if (BUILT_IN_MODES.has(id)) return `${id} is the name of a built-in chat mode`;
    const existing = this.deps.registry.get(id);
    if (existing && !isBundledAgent(existing)) return `An agent named ${id} already exists`;
    return null;
  }

  private createProblem(): string | null {
    return this.nameProblem() ?? (this.form.description.trim() ? null : "Say what it does");
  }

  // ---- Create, save, reload --------------------------------------------------------------

  private async create(): Promise<void> {
    if (this.name || this.creating || this.createProblem()) return;
    this.creating = true;
    this.updateLive();
    const f = this.form;
    const tools = parseToolList(f.tools);
    const result = (await this.run("agent.createAgent", {
      label: f.label.trim(),
      description: f.description.trim(),
      ...(f.role.trim() && { role: f.role.trim() }),
      instructions: f.instructions,
      icon: f.modelIcon ? MODEL_ICON : encodeFace(f.face),
      ...(f.access && { access: f.access }),
      ...(tools.length && { tools }),
      ...(Number(f.maxSteps) > 0 && { maxSteps: Number(f.maxSteps) }),
      ...(f.model && { model: f.model }),
      ...(f.startMode !== "agent" && { mode: f.startMode }),
      scope: f.scope,
    })) as { name?: string; path?: string } | null;
    this.creating = false;
    if (!result?.name) {
      this.updateLive();
      return;
    }
    this.name = result.name;
    this.ctx.updateState({ name: result.name });
    const def = this.deps.registry.get(result.name);
    this.path = def?.path ?? null;
    if (def?.path) this.lastText = await fsIpc.read(def.path).then(decode, () => "");
    if (def) this.form = formFromDef(def);
    this.draw();
    this.changed.fire();
    this.note("Created");
    this.parts.fields.instructions?.focus();
  }

  /** A change to write: header fields, or a change to the whole text. */
  private queue(change: Record<string, string | null> | ((text: string) => string)): void {
    if (!this.name) return;
    this.pending.push(
      typeof change === "function" ? change : (text) => setHeaderFields(text, change),
    );
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
    this.note("Saving…", false);
  }

  /** Writes what's waiting (one write at a time, each on the file as it is now). */
  private flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saving = this.saving.then(async () => {
      const changes = this.pending.splice(0);
      const path = this.def()?.path;
      if (!changes.length || !path) return;
      try {
        const before = decode(await fsIpc.read(path));
        const text = changes.reduce((t, change) => change(t), before);
        this.lastText = text;
        if (text !== before) await fsIpc.write(path, new TextEncoder().encode(text));
        await this.deps.registry.refresh();
        if (!this.pending.length) this.note("Saved");
      } catch (err) {
        this.note(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`, false);
      }
    });
    return this.saving;
  }

  /** The agent's file read again: the form follows when it changed on disk (not our own write). */
  private async sync(def: SubagentDef | undefined, first = false): Promise<void> {
    if (!def) {
      // Deleted (here or anywhere): the tab goes. Still on disk (restricted mode…): it says so.
      const path = this.path;
      if (
        path &&
        !(await fsIpc.stat(path).then(
          () => true,
          () => false,
        ))
      ) {
        this.ctx.close();
        return;
      }
      if (this.parts.fields.label || first) this.draw();
      return;
    }
    this.path = def.path ?? null;
    if (!this.parts.fields.label) this.draw();
    if (!def.path || this.pending.length) return;
    await this.saving;
    const text = await fsIpc.read(def.path).then(decode, () => null);
    if (text === null || this.pending.length) return;
    if (!first && text === this.lastText) return;
    const changedOnDisk = !first && this.lastText !== "" && text !== this.lastText;
    this.lastText = text;
    const fresh = parseSubagentFile(text, def.source, def.path) ?? def;
    const keepModel = this.form.model;
    this.form = { ...formFromDef(fresh), model: keepModel };
    this.fill();
    this.changed.fire();
    if (changedOnDisk) this.note("Reloaded from disk");
  }

  private note(text: string, fade = true): void {
    const el = this.parts.note;
    if (!el || this.parts.create) return;
    el.textContent = text;
    clearTimeout(this.noteTimer);
    if (fade)
      this.noteTimer = setTimeout(() => {
        if (el.textContent === text) el.textContent = "";
      }, 2000);
  }

  // ---- DockView --------------------------------------------------------------------------

  onShow(): void {
    this.growAll();
  }

  onResize(): void {
    this.growAll();
  }

  title(): string {
    if (this.main) return mainAgent.peek().label;
    return this.form.label.trim() || this.name || "New agent";
  }

  focus(): void {
    const label = this.parts.fields.label;
    if (!this.name && label) label.focus();
    else this.element.focus();
  }

  serialize(): Json {
    return this.name ? { name: this.name } : { draft: true, scope: this.form.scope };
  }

  /** A draft isn't brought back after a restart; an agent's tab is. */
  persist(): boolean {
    return this.name !== null;
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    this.store.dispose();
    this.changed.dispose();
    // A closed tab's page goes with it (the dock leaves a view's element to the view).
    this.element.remove();
  }
}

function blank(): AgentTemplate {
  return AGENT_TEMPLATES.find((t) => t.id === "blank") as AgentTemplate;
}
