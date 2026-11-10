// Per-category auto-approve (D204): one setting, `agent.autoApprove`, for reads and edits (path
// globs), commands (prefixes or /regex/), the browser and web pages (domains) and MCP tools
// (server or server/tool), each pattern true (no question) or false (always ask, even with full
// access). The model is core/agent/autoApprove.ts. Here: the tool gate for reads and edits, the
// browser / web decision the permission handler (index.ts) uses, MCP's decision (mcp.ts), the
// Auto-approve page (dock view `agent.autoApprove`), `agent.showAutoApprove`,
// `agent.setAutoApprove` and `ide://agent/autoApprove`. Commands use it in run_command (tools.ts).
import {
  APPROVE_CATEGORIES,
  type ApproveCategory,
  type ApproveRules,
  alwaysPattern,
  approveDecision,
  CATEGORY_INFO,
  readApproveRules,
  withAllowed,
} from "../../core/agent/autoApprove";
import { pathReadings, resolveInFolders } from "../../core/agent/workspaceFolders";
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { type IconName, icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import { agentFolders } from "./ignore";
import type { McpClients } from "./mcp";
import { cleanPathArg } from "./pathArg";
import { addToolGate } from "./toolGate";
import {
  addButton,
  cardRow,
  emptyNote,
  pageButton,
  pageGroup,
  pageHeader,
  pickRowAction,
  runCommand,
  selectInput,
  textInput,
} from "./view/pageKit";

/** Each category's icon on its rows. */
const CATEGORY_ICONS: Record<ApproveCategory, IconName> = {
  reads: "file-text",
  edits: "pencil",
  commands: "square-terminal",
  browser: "globe",
  web: "search",
  mcp: "server",
};

export function approveRules(services: WorkbenchServices): ApproveRules {
  return readApproveRules(services.settings.peek<unknown>("agent.autoApprove"));
}

/** The tools whose `path` is read or written, by category. */
const READ_TOOLS = new Set(["read_file", "list_dir"]);
const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/**
 * "Always" on a read, edit, browser or web question (D207): the exact file or the domain saved
 * to agent.autoApprove as Allow (as Always on a command adds to agent.allowedCommands), with a
 * note in the chat saying so. Returns the pattern, or null when there was nothing to save.
 */
export async function saveAlways(
  services: WorkbenchServices,
  category: ApproveCategory,
  subject: string,
  note?: (text: string) => void,
): Promise<string | null> {
  const pattern = alwaysPattern(category, subject);
  if (!pattern) return null;
  try {
    await services.settings.update(
      "agent.autoApprove",
      withAllowed(approveRules(services), category, pattern),
      "user",
    );
  } catch {
    return null;
  }
  note?.(
    `Saved to auto-approve: ${CATEGORY_INFO[category].title.toLowerCase()} ${pattern} is allowed from now on (Customize → Auto-approve to change it).`,
  );
  return pattern;
}

/** The page a browser.* command acts on (its `url`, else its tab's), or null. */
export async function browserUrl(
  services: WorkbenchServices,
  input: unknown,
): Promise<string | null> {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (typeof fields.url === "string") return fields.url;
  const tabs = (await services.state
    .get("ide://browser")
    .then((snap) => snap.value)
    .catch(() => null)) as { tab?: string; url?: string }[] | null;
  // The tab the command acts on, as the browser picks it: `tab`, the active one, else the
  // most recent browser tab — not the first one, whose domain may have another answer.
  const { dock } = services;
  const active = dock.activeTab();
  const wanted =
    typeof fields.tab === "string"
      ? fields.tab
      : services.context.get("browserExternalCurrent") === true
        ? "external"
        : active?.viewType === "browser"
          ? active.id
          : (dock.recentTab((t) => t.viewType === "browser")?.id ?? null);
  return wanted ? ((tabs ?? []).find((t) => t.tab === wanted)?.url ?? null) : null;
}

/** The browser decision for an IDE command an agent called (browser.*). */
export async function browserDecision(
  services: WorkbenchServices,
  input: unknown,
): Promise<"allow" | "ask" | null> {
  const rules = approveRules(services);
  if (!rules.browser) return null;
  const url = await browserUrl(services, input);
  return url ? approveDecision(rules, "browser", url) : null;
}

export function webDecision(services: WorkbenchServices, input: unknown): "allow" | "ask" | null {
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === "string" ? approveDecision(approveRules(services), "web", url) : null;
}

/** Bumped by agent.setAutoApprove, so an open page redraws even before settings say so. */
class AutoApproveView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  /** The category whose Add form is open. */
  private adding: ApproveCategory | null = null;

  constructor(private readonly services: WorkbenchServices) {
    this.body = h("div", { class: "ai-setup auto-approve-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        services.settings.version.value;
        // A pattern being typed isn't wiped by a redraw. Only a field counts: the page itself
        // (focused when its tab opens) or a clicked button kept every change from showing.
        const active = this.element.ownerDocument.activeElement;
        if (!(this.element.contains(active) && active?.matches("input, textarea, select")))
          this.draw();
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const rules = approveRules(this.services);
    const settings = this.services.settings;
    const sections = APPROVE_CATEGORIES.map((category) => {
      const info = CATEGORY_INFO[category];
      const glyph = CATEGORY_ICONS[category];
      const entries = Object.entries(rules[category] ?? {});
      const rows = entries.map(([pattern, allow]) => {
        const menu = () =>
          pickRowAction(this.services, pattern, [
            {
              id: "flip",
              label: allow ? "Ask instead" : "Allow instead",
              run: () => this.run("agent.setAutoApprove", { category, pattern, allow: !allow }),
            },
            {
              id: "remove",
              label: "Remove",
              run: () => this.run("agent.setAutoApprove", { category, pattern, allow: "remove" }),
            },
          ]);
        return cardRow(st, {
          attrs: { "data-pattern": pattern, "data-category": category },
          glyph: icon(glyph),
          name: h("code", null, pattern),
          label: pattern,
          badges: [allow ? "Allow" : "Ask"],
          open: menu,
          more: menu,
        });
      });
      // What the older lists say still counts: shown, not edited here.
      const legacy =
        category === "commands"
          ? [
              ...(settings.peek<string[]>("agent.allowedCommands") ?? []).map((p) => [p, "Allow"]),
              ...(settings.peek<string[]>("agent.deniedCommands") ?? []).map((p) => [p, "Ask"]),
            ]
          : [];
      const legacyRows = legacy.map(([p, what]) =>
        cardRow(st, {
          attrs: { "data-legacy": p ?? "" },
          glyph: icon(glyph),
          name: h("code", null, p ?? ""),
          label: p ?? "",
          badges: [what ?? ""],
          details: [what === "Allow" ? "agent.allowedCommands" : "agent.deniedCommands"],
        }),
      );
      const open = this.adding === category;
      const pattern = textInput(`${info.title} pattern`, "", info.example);
      const mode = selectInput(
        `${info.title} answer`,
        [
          ["allow", "Allow"],
          ["ask", "Ask"],
        ],
        category === "reads" || category === "edits" ? "ask" : "allow",
      );
      const save = pageButton(
        st,
        "Add",
        "plus",
        () => {
          const p = pattern.value.trim();
          if (!p) return;
          this.adding = null;
          void this.run("agent.setAutoApprove", {
            category,
            pattern: p,
            allow: mode.value === "allow",
          });
        },
        "button button-primary button-sm",
      );
      const cancel = pageButton(st, "Cancel", null, () => {
        this.adding = null;
        this.draw();
      });
      const form = open
        ? h(
            "div",
            { class: "ai-form" },
            h("div", { class: "auto-approve-add", "data-category": category }, pattern, mode),
            h("div", { class: "ai-form-actions" }, save, cancel),
          )
        : null;
      const add = addButton(
        st,
        "Add",
        () => {
          this.adding = open ? null : category;
          this.draw();
          if (!open) this.body.querySelector<HTMLInputElement>(".auto-approve-add input")?.focus();
        },
        { "data-new": category, title: `Add a pattern for ${info.title.toLowerCase()}` },
      );
      return pageGroup(
        info.title,
        rows.length + legacyRows.length,
        [add],
        [
          form,
          rows.length || legacyRows.length
            ? h("div", { class: "mcp-list" }, ...rows, ...legacyRows)
            : form
              ? null
              : emptyNote(info.lead),
        ],
        { "data-group": category },
      );
    });
    this.body.replaceChildren(
      pageHeader(
        "Auto-approve",
        null,
        // Agent settings is Customize's breadcrumb (D270).
      ),
      ...sections,
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

export function registerAutoApprove(
  sub: DisposableStore,
  services: WorkbenchServices,
  clients: McpClients,
): void {
  const { dispatcher, state } = services;
  clients.autoApprove = (subject) => approveDecision(approveRules(services), "mcp", subject);
  sub.add({ dispose: () => (clients.autoApprove = () => null) });

  // Reads and edits of protected paths ask first.
  const gate = addToolGate(async ({ name, args, ask, note }) => {
    const category: ApproveCategory | null = READ_TOOLS.has(name)
      ? "reads"
      : WRITE_TOOLS.has(name)
        ? "edits"
        : null;
    if (!category || typeof args.path !== "string") return null;
    const folders = agentFolders(services);
    if (!folders.length) return null;
    // Each folder's files by their workspace path and (multi-root) their path in the folder.
    const readings = pathReadings(folders, resolveInFolders(folders, cleanPathArg(args.path)));
    const rules = approveRules(services);
    const rel = readings.find((p) => approveDecision(rules, category, p) === "ask");
    if (rel === undefined) return null;
    const verb = category === "reads" ? "Read" : "Change";
    // "Always" saves this one file as Allow (D207): the glob that asked stays for the others.
    const always = alwaysPattern(category, rel);
    const answer = await ask({
      title: `${verb} ${rel}`,
      heading: `${verb} a protected file`,
      code: rel,
      kind: "tool",
      detail: `agent.autoApprove says to ask before ${category === "reads" ? "reading" : "changing"} this file.`,
      ...(always && { always }),
      evenWithFullAccess: true,
    });
    if (answer === "always") await saveAlways(services, category, rel, note);
    return answer === "deny"
      ? {
          result: `The user denied ${category === "reads" ? "reading" : "changing"} ${rel}.`,
          denied: true,
          summary: "denied",
        }
      : null;
  });
  sub.add(gate);

  sub.add(
    addCustomizeSection({
      id: "autoApprove",
      label: "Auto",
      icon: "shield",
      detail: "What the agent may do without asking: reads, edits, commands, browser, web, MCP",
      keywords: "auto-approve permissions allow ask patterns",
      order: 40,
      page: { create: () => new AutoApproveView(services) },
    }),
  );

  sub.add(
    state.register("ide://agent/autoApprove", {
      description:
        "Per-category auto-approve (agent.autoApprove, D204): for reads, edits, commands, browser, web and mcp, each pattern and whether it's allowed (true) or always asks (false); plus the older agent.allowedCommands / agent.deniedCommands that still count.",
      get: () => ({
        rules: approveRules(services),
        allowedCommands: services.settings.peek<string[]>("agent.allowedCommands") ?? [],
        deniedCommands: services.settings.peek<string[]>("agent.deniedCommands") ?? [],
        runCommands: services.settings.peek<string>("agent.runCommands") ?? "ask",
      }),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.showAutoApprove",
      title: "Auto-approve…",
      category: "Agent",
      description:
        "Opens the Auto-approve page: what the agent may do without asking, by category (reads, edits, commands, browser, web, MCP), with patterns set to Allow or Ask.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => openCustomize(services, "autoApprove"),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setAutoApprove",
      title: "Set an auto-approve pattern",
      category: "Agent",
      description:
        "Adds or changes one pattern of agent.autoApprove in the user settings: `category` reads / edits (path globs), commands (prefix, prefix*, /regex/), browser / web (domains, *.example.com), mcp (server or server/tool); `allow` true goes ahead without asking, false always asks; null removes the pattern. Only the user can change it (an agent can't widen its own permissions).",
      input: s.object({
        category: s.enum(APPROVE_CATEGORIES),
        pattern: s.string({ minLength: 1 }),
        allow: s.union(s.boolean(), s.enum(["remove"] as const)).optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ category, pattern, allow }, ctx) => {
        if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test")
          throw new Error("Only you can change what the agent may do without asking.");
        const current = approveRules(services);
        const map = { ...(current[category] ?? {}) };
        const p = pattern.trim();
        if (allow === undefined || allow === "remove") delete map[p];
        else map[p] = allow;
        const next: ApproveRules = { ...current, [category]: map };
        if (!Object.keys(map).length) delete next[category];
        await services.settings.update("agent.autoApprove", next, "user");
        return { category, pattern: p, allow: allow === "remove" ? null : (allow ?? null) };
      },
    }),
  );
}
