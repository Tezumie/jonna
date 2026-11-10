// The chat's details panel (D231, after Claude Code's desktop app): small cards beside the
// conversation — Environment (folder, branch, model, agent, mode), Context (how full the window
// is and with what), Changes, Background work, Plan — each folding from its header (remembered
// for every chat). A wide chat tab shows it on the right (agent.detailsPanel); a narrow one keeps
// it behind the header's button as a sheet over the right edge (Esc or a click outside closes).
// Every button runs a command; data comes from chatDetails.ts (also ide://agent/details).

import {
  type ContextKey,
  type DetailsCard,
  type DetailsLayout,
  detailsLayout,
  detailsSetting,
  formatElapsed,
  formatTokens,
} from "../../../core/agent/chatDetails";
import { agentFace as faceOf } from "../../../core/agent/faces";
import type { HelperState } from "../../../core/agent/isolatedHelpers";
import { describeNext } from "../../../core/agent/schedules";
import { h, morph, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect, type ReadonlySignal, untracked } from "../../../core/reactive/index";
import { agentFace } from "../../../ui/AgentFace";
import { type IconName, icon } from "../../../ui/Icon";
import { type MenuItem, showMenu } from "../../../ui/Menu";
import { setTooltip } from "../../../ui/Tooltip";
import { backgroundProcesses } from "../backgroundProcesses";
import { agentOwnModel } from "../chatAgentModel";
import type { ChatDetailsData, DetailsHost } from "../chatDetails";
import { customModes } from "../customModes";
import { prWatches } from "../prWatches";
import { scheduledMessages } from "../schedules";
import type { AgentSession } from "../session";
import { pullRequestRow } from "./detailsPullRequest";

export interface ChatDetailsDeps {
  session: AgentSession;
  host: DetailsHost;
  run(command: string, input?: unknown): void;
  /** A setting's value (reactive read). */
  setting(key: string): unknown;
  /** The folder open now (the branch is the open folder's). */
  openFolder: ReadonlySignal<string | null>;
  /** Whether a chat stored with `stored` is this window's (D251: first folder or workspace file). */
  isThisWorkspace(stored: string | null | undefined): boolean;
  showModelMenu(anchor: HTMLElement): void;
}

/** A helper's state in words (core/agent/isolatedHelpers.ts). */
const HELPER_STATES: Record<HelperState, string> = {
  starting: "setting up",
  working: "working",
  waiting: "waiting for you",
  stopping: "stopping",
  done: "done",
  error: "error",
  stopped: "stopped",
};
const HELPER_DONE: ReadonlySet<HelperState> = new Set(["done", "error", "stopped"]);

/** A card's content: its fold summary and body. */
interface CardContent {
  card: DetailsCard;
  /** Shown in the header while it's folded. */
  summary: string;
  body: HTMLElement[];
}

/** Re-render at most this often while the chat streams. */
const RENDER_MS = 250;
/** The branch is read again this often while the panel shows. */
const BRANCH_MS = 20_000;

const TITLES: Record<DetailsCard, string> = {
  environment: "Environment",
  context: "Context",
  changes: "Changes",
  background: "Background",
  plan: "Plan",
};

export class ChatDetails implements Disposable {
  /** The panel (beside the chat, or the sheet). */
  readonly element: HTMLElement;
  /** The header's button: shows or hides the panel. */
  readonly button: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly body: HTMLElement;
  private view: HTMLElement | null = null;
  private width = 0;
  private sheetOpen = false;
  private branch: string | null = null;
  private limit: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tick: ReturnType<typeof setTimeout> | undefined;
  private dirty = true;
  /** Folds inside cards (MCP servers, rules): this panel only. */
  private readonly open = new Set<string>();
  private menu: Disposable | null = null;

  constructor(private readonly deps: ChatDetailsDeps) {
    const { session, host } = deps;
    this.body = h("div", { class: "agent-details-cards" });
    this.element = h(
      "aside",
      {
        class: "agent-details",
        "aria-label": "Chat details",
        tabindex: "-1",
        hidden: true,
      },
      this.body,
    );
    this.button = h(
      "button",
      { class: "icon-button agent-details-toggle", type: "button", "aria-label": "Chat details" },
      icon("panel-right"),
    );
    setTooltip(this.button, "Chat details", "agent.toggleDetails");
    this.store.add(on(this.button, "click", () => this.toggle()));
    this.store.add(on(this.element, "click", (e) => this.onClick(e)));
    this.store.add(on(this.element, "pointerdown", (e) => this.startDrag(e)));
    this.store.add(
      on(this.element, "keydown", (e) => {
        if (e.key === "Escape" && this.layout() !== "side" && this.sheetOpen) {
          e.stopPropagation();
          this.toggle(false);
          this.button.focus();
        }
      }),
    );
    this.store.add(
      host.attach(session.id, {
        toggle: (show) => this.toggle(show),
        layout: () => this.layout(),
        shown: () => this.visible(),
        onScreen: () => !!this.view?.offsetParent,
      }),
    );
    // What the panel shows: re-rendered (throttled) when any of it changes.
    this.store.add(
      effect(() => {
        session.version.value;
        session.status.value;
        session.usage.value;
        session.chatMode.value;
        session.model.value;
        session.folder.value;
        session.changeset.files.value;
        session.plan.value;
        session.backgroundCount.value;
        session.pullRequest.value;
        backgroundProcesses.version.value;
        scheduledMessages.value;
        prWatches.value;
        customModes.value;
        host.watchHelpers();
        deps.openFolder.value;
        this.invalidate();
        return undefined;
      }),
    );
    // Folding a card redraws at once from what was worked out last (D233: it waited for the
    // throttle and worked out the context sizes again, which lagged in long chats).
    this.store.add(
      effect(() => {
        host.folded.value;
        host.order.value;
        untracked(() => {
          if (this.lastData && this.visible() && !this.dirty) this.render(false);
          else this.invalidate();
        });
        return undefined;
      }),
    );
    // Where it shows.
    this.store.add(
      effect(() => {
        deps.setting("agent.detailsPanel");
        host.hidden.value;
        this.place();
        return undefined;
      }),
    );
    // The window's size: the model's context (before a request says), then on each model change.
    this.store.add(
      effect(() => {
        session.model.value;
        const asked = session.model.peek();
        void host.contextLimit(session).then((limit) => {
          if (this.store.isDisposed || session.model.peek() !== asked) return;
          this.limit = limit;
          this.invalidate();
        });
        return undefined;
      }),
    );
    // The branch: when the turn ends (a commit, a checkout) and now and then while it shows.
    this.store.add(
      effect(() => {
        if (session.status.value === "idle") untracked(() => this.readBranch());
        deps.openFolder.value;
        return undefined;
      }),
    );
    const every = setInterval(() => {
      if (this.visible()) this.readBranch();
    }, BRANCH_MS);
    this.store.add({ dispose: () => clearInterval(every) });
    // A sheet closes on a click outside it (menus it opened don't count).
    this.store.add(
      on(document, "pointerdown", (e) => {
        if (!this.sheetOpen || this.layout() === "side") return;
        const t = e.target as Element | null;
        if (!t || this.element.contains(t) || this.button.contains(t)) return;
        if (t.closest(".menu, .model-picker, [role='menu']")) return;
        this.toggle(false);
      }),
    );
  }

  /** Puts the panel in `view` (the chat tab's element): its width decides where it shows. */
  attachTo(view: HTMLElement): void {
    this.view = view;
    const resize = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? view.clientWidth;
      if (Math.abs(w - this.width) < 1) return;
      this.width = w;
      this.place();
    });
    resize.observe(view);
    this.store.add({ dispose: () => resize.disconnect() });
    this.width = view.clientWidth;
    this.place();
  }

  layout(): DetailsLayout {
    return detailsLayout(
      this.width,
      detailsSetting(untracked(() => this.deps.setting("agent.detailsPanel"))),
    );
  }

  visible(): boolean {
    const layout = this.layout();
    return layout === "side" ? !this.deps.host.hidden.peek() : this.sheetOpen;
  }

  /** Shows or hides it (flips without `show`); returns whether it shows. */
  toggle(show?: boolean): boolean {
    const next = show ?? !this.visible();
    if (this.layout() === "side") {
      this.sheetOpen = false;
      this.deps.host.setHidden(!next);
    } else this.sheetOpen = next;
    this.place();
    if (next && this.layout() !== "side")
      requestAnimationFrame(() => this.element.focus({ preventScroll: true }));
    return this.visible();
  }

  /** Side, sheet or nothing, from the width, the setting and what the user chose. */
  private place(): void {
    if (!this.view) return;
    const layout = this.layout();
    if (layout === "side" && this.sheetOpen) this.sheetOpen = false;
    const shown = this.visible();
    this.element.hidden = !shown;
    this.element.dataset.layout = layout === "side" ? "side" : "sheet";
    this.view.classList.toggle("has-details", shown && layout === "side");
    // "never" hides the button too (the command still opens the sheet).
    this.button.hidden = layout === "off" && !this.sheetOpen;
    this.button.setAttribute("aria-pressed", String(shown));
    this.button.replaceChildren(icon(shown ? "panel-right-on" : "panel-right"));
    if (shown) {
      if (this.dirty) this.render();
      if (this.branch === null) this.readBranch();
    }
  }

  private readBranching = false;
  private readBranch(): void {
    if (this.readBranching) return;
    this.readBranching = true;
    void this.deps.host
      .branch()
      .then((b) => {
        if (this.store.isDisposed || b === this.branch) return;
        this.branch = b;
        this.invalidate();
      })
      .finally(() => {
        this.readBranching = false;
      });
  }

  private invalidate(): void {
    this.dirty = true;
    if (!this.visible() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.visible()) this.render();
    }, RENDER_MS);
  }

  /** What the cards showed last: folding redraws from it. */
  private lastData: ReturnType<DetailsHost["data"]> | null = null;

  private render(fresh = true): void {
    const { session, host } = this.deps;
    const data =
      !fresh && this.lastData
        ? this.lastData
        : untracked(() => host.data(session, { branch: this.branch, limit: this.limit }));
    if (fresh || !this.lastData) {
      this.dirty = false;
      clearTimeout(this.tick);
    }
    this.lastData = data;
    const folded = host.folded.peek();
    // Only cards with something real in them.
    const cards: CardContent[] = [];
    cards.push(this.environment(data));
    if (data.context) cards.push(this.context(data.context));
    if (data.changes.files) cards.push(this.changes(data));
    const bg = data.background;
    if (
      bg.running.length ||
      bg.finished ||
      bg.helpers.length ||
      bg.scheduled.length ||
      bg.pullRequest
    )
      cards.push(this.background(data));
    if (data.plan.total) cards.push(this.plan());
    // In the order the user dragged them to (D409).
    const order = host.order.peek();
    cards.sort((a, b) => order.indexOf(a.card) - order.indexOf(b.card));
    const next = h(
      "div",
      { class: "agent-details-cards" },
      ...cards.map((c) => {
        const isFolded = folded.has(c.card);
        return h(
          "section",
          {
            class: { "agent-details-card": true, "is-folded": isFolded },
            "data-key": c.card,
            "data-card": c.card,
          },
          h(
            "button",
            {
              class: "agent-details-card-head",
              type: "button",
              "data-action": "fold",
              "data-card": c.card,
              "aria-expanded": String(!isFolded),
            },
            h("span", { class: "agent-details-card-title" }, TITLES[c.card]),
            h("span", { class: "agent-details-card-summary" }, isFolded ? c.summary : ""),
            icon(isFolded ? "chevron-right" : "chevron-down"),
            // Drag to reorder the cards (D409), shown on the header's hover.
            h(
              "span",
              {
                class: "agent-details-grip",
                "data-grip": c.card,
                "aria-hidden": "true",
                title: "Drag to move",
              },
              icon("grip-vertical"),
            ),
          ),
          isFolded ? null : h("div", { class: "agent-details-card-body" }, ...c.body),
        );
      }),
    );
    morph(this.body, next);
    // Elapsed times move on while something runs.
    if (bg.running.length || bg.helpers.some((x) => !HELPER_DONE.has(x.state))) {
      clearTimeout(this.tick);
      this.tick = setTimeout(() => this.invalidate(), 1000);
    }
  }

  // ---- cards ---------------------------------------------------------------------------------

  private environment(d: ChatDetailsData) {
    const env = d.environment;
    const body: HTMLElement[] = [row("monitor-smartphone", env.where)];
    if (env.folder) {
      const r = row(
        "folder",
        h(
          "span",
          { class: "agent-details-text" },
          env.folder.name,
          h("span", { class: "agent-details-muted" }, ` · ${env.folder.path}`),
        ),
        null,
        { action: "folder" },
      );
      setTooltip(
        r,
        env.folder.open
          ? `${env.folder.path} · Reveal in explorer`
          : `${env.folder.path} · Reveal in file manager`,
      );
      body.push(r);
    }
    if (env.branch) {
      // Switches branch (D409), as the status bar's branch does: the open folder's only.
      const switchable = !!env.folder?.open && this.deps.host.has("git.checkout");
      const r = row("git-branch", env.branch, null, switchable ? { action: "branch" } : null);
      setTooltip(r, switchable ? `Branch ${env.branch} · Switch` : `Branch ${env.branch}`);
      body.push(r);
    }
    const model = row("cpu", env.model, null, { action: "model" });
    setTooltip(model, `Model: ${env.model} · Change`, "agent.selectModel");
    body.push(model);
    if (env.agent) {
      const a = env.agent;
      const r = row(
        agentFace(faceOf(a.icon, a.name, a.model), { size: 16 }),
        h(
          "span",
          { class: "agent-details-text" },
          a.label,
          a.role ? h("span", { class: "agent-details-muted" }, ` · ${a.role}`) : null,
        ),
        null,
        { action: "agent", name: a.name },
      );
      setTooltip(r, `${a.label}${a.role ? ` · ${a.role}` : ""} · Edit agent`, "agent.editAgent");
      body.push(r);
    } else {
      const r = row(modeIcon(env.mode.id), `${env.mode.label} mode`, null, { action: "mode" });
      setTooltip(r, "Mode · Change", "agent.setChatMode");
      body.push(r);
    }
    // A style other than Default (D356): which, and a way to change it.
    if (env.outputStyle) {
      const r = row("palette", `${env.outputStyle} style`, null, { action: "outputStyle" });
      setTooltip(r, "Output style · Change", "agent.setOutputStyle");
      body.push(r);
    }
    return { card: "environment" as const, summary: env.folder?.name ?? env.model, body };
  }

  private context(c: NonNullable<ChatDetailsData["context"]>) {
    const about = c.estimated ? "about " : "";
    const head = h(
      "div",
      { class: "agent-details-context-head" },
      h("span", null, `${c.percent}% used`),
      h(
        "span",
        { class: "agent-details-num" },
        `${c.estimated ? "~" : ""}${formatTokens(c.used)} / ${formatTokens(c.limit)}`,
      ),
    );
    setTooltip(
      head,
      `${c.estimated ? "About " : ""}${c.used.toLocaleString()} of ${c.limit.toLocaleString()} tokens${c.estimated ? " (estimated: no request has been counted yet)" : ", as the provider counted the last request"}. The split by part is estimated from each part's size.`,
    );
    const bar = h(
      "div",
      {
        class: "agent-details-bar",
        role: "img",
        "aria-label": `${c.percent}% of the context used`,
      },
      ...c.rows
        .filter((r) => r.percent > 0)
        .map((r) =>
          h("span", {
            class: `agent-details-seg is-${r.key}`,
            style: { width: `${Math.min(100, r.percent)}%` },
          }),
        ),
    );
    const rows: HTMLElement[] = [];
    for (const r of c.rows) {
      const fold =
        r.key === "mcp" && c.mcpServers.length
          ? { id: "mcp", count: c.mcpServers.length }
          : r.key === "rules" && c.rules.length
            ? { id: "rules", count: c.rules.length }
            : r.key === "tools" && c.builtIn.length
              ? { id: "tools", count: c.builtIn.length }
              : null;
      const line = tokenRow(
        r.key,
        fold ? `${r.label} (${fold.count})` : r.label,
        r.tokens,
        r.percent,
        fold ? { open: this.open.has(fold.id), id: fold.id } : null,
      );
      setTooltip(
        line,
        `${r.label}: ${about}${r.tokens.toLocaleString()} tokens (${r.percent}% of the window)`,
      );
      rows.push(line);
      if (fold && this.open.has(fold.id)) {
        const subs =
          fold.id === "mcp"
            ? c.mcpServers.map((s) => ({
                label: `${s.server} · ${s.tools} tool${s.tools === 1 ? "" : "s"}`,
                tokens: s.tokens,
              }))
            : fold.id === "tools"
              ? (() => {
                  // Scaled like the row (the provider's count when it gave one): they add up.
                  const sum = c.builtIn.reduce((n, x) => n + x.tokens, 0);
                  const k = sum > 0 ? r.tokens / sum : 1;
                  return c.builtIn.map((x) => ({
                    label: x.name,
                    tokens: Math.round(x.tokens * k),
                  }));
                })()
              : c.rules.map((x) => ({ label: x.name, tokens: x.tokens }));
        for (const s of subs)
          rows.push(
            h(
              "div",
              { class: "agent-details-row is-sub" },
              h("span", { class: "agent-details-label" }, s.label),
              h("span", { class: "agent-details-num" }, formatTokens(s.tokens)),
              h("span", { class: "agent-details-num agent-details-pct" }, ""),
            ),
          );
      }
    }
    const free = tokenRow(
      "free",
      "Free space",
      c.free,
      Math.round((c.free / c.limit) * 1000) / 10,
      null,
    );
    rows.push(free);
    // Tools the requests only name (D319): loaded when the agent asks, not in the window yet.
    const deferred = c.deferred;
    for (const [n, tokens, label] of [
      [deferred.mcp, deferred.mcpTokens, "MCP tools (deferred)"],
      [deferred.builtIn, deferred.builtInTokens, "Built-in tools (deferred)"],
    ] as const) {
      if (!n) continue;
      const line = h(
        "div",
        { class: "agent-details-row is-token is-deferred" },
        h("span", { class: "agent-details-swatch is-deferred" }),
        h("span", { class: "agent-details-label" }, `${label} (${n})`),
        h("span", { class: "agent-details-num" }, formatTokens(tokens)),
        h("span", { class: "agent-details-num agent-details-pct" }, "—"),
      );
      setTooltip(
        line,
        `${n} tool${n === 1 ? "" : "s"} the agent loads by name when it needs them (tool_search): about ${tokens.toLocaleString()} tokens, not in the window until then`,
      );
      rows.push(line);
    }
    // When the IDE's agent summarizes by itself, and a way to do it now (D409, as Claude Code's
    // Compact session); an external agent gets its own /compact.
    const extra: HTMLElement[] = [];
    if (this.deps.session.items.length) {
      const compact = h(
        "button",
        {
          class: "button button-secondary button-sm agent-details-compact",
          type: "button",
          "data-action": "compact",
          ...(c.external && { "data-external": "true" }),
          ...(this.deps.session.status.peek() !== "idle" && { disabled: "" }),
        },
        "Compact session",
      );
      setTooltip(
        compact,
        c.external
          ? "Ask the agent to compact its context (/compact)"
          : "Replace the conversation so far by a summary, to free up context",
        c.external ? undefined : "agent.compact",
      );
      const note =
        c.autoCompactIn === null
          ? null
          : h(
              "span",
              { class: "agent-details-muted" },
              `${formatTokens(c.autoCompactIn)} until auto-compact`,
            );
      extra.push(h("div", { class: "agent-details-compact-row" }, note, compact));
    }
    return {
      card: "context" as const,
      summary: `${c.percent}%`,
      body: [head, bar, h("div", { class: "agent-details-rows" }, ...rows), ...extra],
    };
  }

  private changes(d: ChatDetailsData) {
    const c = d.changes;
    const s = this.deps.session;
    const line = h(
      "div",
      { class: "agent-details-row is-plain" },
      h(
        "span",
        { class: "agent-details-label" },
        h("span", { class: "is-added" }, `+${c.added}`),
        " ",
        h("span", { class: "is-removed" }, `−${c.removed}`),
        h(
          "span",
          { class: "agent-details-muted" },
          ` · ${c.files} file${c.files === 1 ? "" : "s"}`,
        ),
      ),
      c.review
        ? h("span", { class: "agent-details-num agent-details-muted" }, `${c.review} to review`)
        : null,
    );
    const actions: HTMLElement[] = [];
    if (c.review) {
      actions.push(
        link("Review", "agent.review", "Review this chat's edits"),
        link("Keep all", "agent.acceptAll", "Keep every edit waiting for review"),
        link("Undo all", "agent.rejectAll", "Put back what the files were before these edits"),
      );
    }
    const pr = s.pullRequest.peek();
    if (pr?.url) {
      const b = h(
        "button",
        { class: "agent-details-link", type: "button", "data-action": "url", "data-url": pr.url },
        pr.number ? `Pull request #${pr.number}` : "Pull request",
      );
      setTooltip(b, pr.title || pr.url);
      actions.push(b);
    } else if (
      d.environment.branch &&
      this.deps.host.has("agent.createPullRequest") &&
      this.deps.host.has("github.createPullRequest")
    ) {
      // A button on the changes' line, as in Claude Code's panel (D409).
      const create = h(
        "button",
        {
          class: "button button-secondary button-sm agent-details-compact",
          type: "button",
          "data-action": "run",
          "data-command": "agent.createPullRequest",
          ...(s.status.peek() !== "idle" && { disabled: "" }),
        },
        "Create PR",
      );
      setTooltip(
        create,
        "Ask the agent to commit this work on a branch and open a pull request",
        "agent.createPullRequest",
      );
      line.append(create);
    }
    return {
      card: "changes" as const,
      summary: `+${c.added} −${c.removed}`,
      body: [
        line,
        ...(actions.length ? [h("div", { class: "agent-details-actions" }, ...actions)] : []),
      ],
    };
  }

  private background(d: ChatDetailsData) {
    const now = Date.now();
    const rows = d.background.running.map((b) => {
      const custom =
        b.kind === "subagent"
          ? customModes.peek().find((m) => m.name === b.label && m.agent)
          : undefined;
      const lead =
        b.kind === "subagent"
          ? agentFace(faceOf(custom?.agent?.icon, b.label, custom?.model), {
              size: 16,
              state: "working",
            })
          : b.monitor
            ? icon("radio-tower")
            : b.serving
              ? icon("server")
              : h("span", { class: "agent-spinner" });
      const stop = h(
        "button",
        {
          class: "icon-button agent-details-stop",
          type: "button",
          "data-action": "run",
          "data-command": b.kind === "subagent" ? "agent.stopSubagents" : "agent.killProcess",
          "data-id": b.id,
          "aria-label": `Stop ${b.label}`,
        },
        icon("square"),
      );
      setTooltip(stop, "Stop", b.kind === "subagent" ? "agent.stopSubagents" : "agent.killProcess");
      // A follow-up to a subagent while it works (D245).
      const message =
        b.kind === "subagent"
          ? h(
              "button",
              {
                class: "icon-button agent-details-stop",
                type: "button",
                "data-action": "run",
                "data-command": "agent.messageSubagent",
                "data-id": b.id,
                "aria-label": `Message ${b.label}`,
              },
              icon("messages-square"),
            )
          : null;
      if (message) setTooltip(message, "Send a follow-up", "agent.messageSubagent");
      const label = h(
        b.kind === "command" ? "button" : "span",
        {
          class: { "agent-details-label": true, "is-code": b.kind === "command" },
          ...(b.kind === "command" && {
            type: "button",
            "data-action": "run",
            "data-command": "agent.showProcessOutput",
            "data-id": b.id,
          }),
        },
        custom?.agent?.label ?? b.label,
      );
      if (b.kind === "command")
        setTooltip(
          label,
          `${b.monitor ? "Monitor: " : ""}${b.label}${b.detail ? `\n${b.detail}` : ""}\nShow what it printed`,
        );
      return h(
        "div",
        { class: "agent-details-row is-task", "data-key": `${b.kind}:${b.id}` },
        h("span", { class: "agent-details-lead" }, lead),
        label,
        h(
          "span",
          { class: "agent-details-num agent-details-muted" },
          formatElapsed(now - b.startedAt),
        ),
        message,
        stop,
      );
    });
    // Everything, finished ones too, in the Background tasks view (D326).
    const finished = h(
      "button",
      {
        class: "agent-details-row is-plain agent-details-muted agent-details-all",
        type: "button",
        "data-action": "run",
        "data-command": "agent.showBackgroundTasks",
      },
      d.background.finished
        ? `${d.background.finished} finished · show all`
        : "Show background tasks",
    );
    const helpers = d.background.helpers.map((x) => this.helperRow(x, now));
    const scheduled = d.background.scheduled.map((x) => this.scheduleRow(x, now));
    const running =
      d.background.running.length +
      d.background.helpers.filter((x) => !HELPER_DONE.has(x.state)).length;
    const pr = d.background.pullRequest ? pullRequestRow(d.background.pullRequest) : null;
    const summary = running
      ? `${running} running`
      : d.background.finished
        ? `${d.background.finished} finished`
        : d.background.scheduled.length || !d.background.pullRequest
          ? `${d.background.scheduled.length} scheduled`
          : `watching #${d.background.pullRequest.number}`;
    return {
      card: "background" as const,
      summary,
      body: [
        ...(pr ? [pr] : []),
        ...helpers,
        ...rows,
        ...scheduled,
        ...(finished ? [finished] : []),
      ],
    };
  }

  /** A scheduled message (D253): clock, label, when it runs next; Run now and Cancel. */
  private scheduleRow(x: ChatDetailsData["background"]["scheduled"][number], now: number) {
    const button = (command: string, glyph: "play" | "x", label: string) => {
      const b = h(
        "button",
        {
          class: "icon-button agent-details-stop",
          type: "button",
          "data-action": "run",
          "data-command": command,
          "data-id": x.id,
          "aria-label": `${label}: ${x.label}`,
        },
        icon(glyph),
      );
      setTooltip(b, label, command);
      return b;
    };
    const label = h("span", { class: "agent-details-label" }, x.label);
    setTooltip(
      label,
      `${x.label}
${x.repeat} · next ${describeNext(x.next, now)}`,
    );
    return h(
      "div",
      { class: "agent-details-row is-task", "data-key": `schedule:${x.id}` },
      h("span", { class: "agent-details-lead" }, icon("clock")),
      label,
      h("span", { class: "agent-details-num agent-details-muted" }, describeNext(x.next, now)),
      button("agent.runScheduleNow", "play", "Run now"),
      button("agent.cancelSchedule", "x", "Cancel"),
    );
  }

  /**
   * A helper in its own worktree (D231): face, label, state and time, its +/− when known; Stop
   * while it works, Review and Merge once it's done.
   */
  private helperRow(x: ChatDetailsData["background"]["helpers"][number], now: number): HTMLElement {
    const done = HELPER_DONE.has(x.state);
    const lead = agentFace(faceOf(x.icon, x.agent, agentOwnModel(x.agent)), {
      size: 16,
      label: x.label,
      state:
        x.state === "error"
          ? "failed"
          : x.state === "waiting"
            ? "waiting"
            : done
              ? "idle"
              : "working",
    });
    const stat =
      x.added !== undefined || x.removed !== undefined
        ? h(
            "span",
            { class: "agent-details-num" },
            h("span", { class: "is-added" }, `+${x.added ?? 0}`),
            " ",
            h("span", { class: "is-removed" }, `−${x.removed ?? 0}`),
          )
        : null;
    const head = h(
      "div",
      { class: "agent-details-row is-task" },
      h("span", { class: "agent-details-lead" }, lead),
      h(
        "span",
        { class: "agent-details-label" },
        x.label,
        h("span", { class: "agent-details-muted" }, ` · ${HELPER_STATES[x.state]}`),
      ),
      stat,
      h(
        "span",
        { class: "agent-details-num agent-details-muted" },
        formatElapsed((x.finishedAt ?? now) - x.startedAt),
      ),
      done
        ? null
        : (() => {
            const stop = h(
              "button",
              {
                class: "icon-button agent-details-stop",
                type: "button",
                "data-action": "helper",
                "data-command": "agent.stopHelper",
                "data-id": x.id,
                "aria-label": `Stop ${x.label}`,
              },
              icon("square"),
            );
            setTooltip(stop, "Stop (its worktree and changes stay)", "agent.stopHelper");
            return stop;
          })(),
    );
    setTooltip(head, `${x.label}${x.role ? ` · ${x.role}` : ""} in its own worktree`);
    if (!done || (x.state === "stopped" && !x.files))
      return h("div", { "data-key": `helper:${x.id}` }, head);
    const action = (label: string, act: string, tip: string) => {
      const b = h(
        "button",
        {
          class: "agent-details-link",
          type: "button",
          "data-action": "helper",
          "data-command": "agent.helpers",
          "data-id": x.id,
          "data-act": act,
        },
        label,
      );
      setTooltip(b, tip, "agent.helpers");
      return b;
    };
    return h(
      "div",
      { "data-key": `helper:${x.id}` },
      head,
      h(
        "div",
        { class: "agent-details-actions is-row" },
        action("Review", "review", "Compare its changes with this folder"),
        action("Merge", "merge", "Merge its changes into this folder (asks first)"),
      ),
    );
  }

  private plan() {
    const steps = this.deps.session.plan.peek();
    const done = steps.filter((s) => s.status === "done").length;
    return {
      card: "plan" as const,
      summary: `${done}/${steps.length}`,
      body: [
        h(
          "ol",
          { class: "agent-details-steps" },
          ...steps.map((s) =>
            h(
              "li",
              { class: `is-${s.status}` },
              s.status === "done"
                ? icon("check")
                : s.status === "in_progress"
                  ? h("span", { class: "agent-spinner" })
                  : h("span", { class: "agent-details-dot" }),
              h("span", null, s.text),
            ),
          ),
        ),
      ],
    };
  }

  // ---- actions -------------------------------------------------------------------------------

  /** A grip was pressed: the click that follows it mustn't fold the card. */
  private suppressClick = false;
  private suppressUntil = 0;
  /** Ends a drag in progress (the panel closed or was disposed meanwhile). */
  private endDrag: (() => void) | null = null;

  /**
   * Drags a card by its header's grip (D409): the card goes before the one under the pointer, or
   * to the end below the last; agent.moveDetailsCard keeps the order for every chat.
   */
  private startDrag(e: PointerEvent): void {
    const grip = (e.target as Element).closest<HTMLElement>("[data-grip]");
    if (!grip || e.button !== 0 || !this.element.contains(grip)) return;
    e.preventDefault();
    e.stopPropagation();
    this.suppressClick = true;
    this.endDrag?.();
    const card = grip.dataset.grip as DetailsCard;
    const sections = () => [...this.body.querySelectorAll<HTMLElement>("section[data-card]")];
    const clear = () => {
      for (const s of sections()) s.classList.remove("is-drop-before", "is-dragging");
      this.body.classList.remove("is-drop-end");
    };
    sections()
      .find((s) => s.dataset.card === card)
      ?.classList.add("is-dragging");
    let before: DetailsCard | null | undefined;
    const move = (ev: PointerEvent) => {
      clear();
      sections()
        .find((s) => s.dataset.card === card)
        ?.classList.add("is-dragging");
      const over = sections().find((s) => {
        const r = s.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      before = (over?.dataset.card as DetailsCard | undefined) ?? null;
      if (over) over.classList.add("is-drop-before");
      else this.body.classList.add("is-drop-end");
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      clear();
      this.endDrag = null;
      // The click that ends the press comes right after: ignored, then clicks count again.
      this.suppressClick = false;
      this.suppressUntil = performance.now() + 100;
      if (commit && before !== undefined && before !== card)
        this.deps.run("agent.moveDetailsCard", { card, ...(before && { before }) });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    this.endDrag = () => finish(false);
  }

  private onClick(e: MouseEvent): void {
    if (this.suppressClick || performance.now() < this.suppressUntil) {
      e.preventDefault();
      return;
    }
    const el = (e.target as Element).closest<HTMLElement>("[data-action]");
    if (!el || !this.element.contains(el) || el.hasAttribute("disabled")) return;
    const { session, host, run } = this.deps;
    const a = el.dataset.action;
    if (a === "fold") {
      const card = el.dataset.card as DetailsCard;
      host.setFolded(card, !host.folded.peek().has(card));
    } else if (a === "sub") {
      const id = el.dataset.fold ?? "";
      if (this.open.has(id)) this.open.delete(id);
      else this.open.add(id);
      this.render(false);
    } else if (a === "run") {
      const command = el.dataset.command ?? "";
      run(command, {
        // Process and schedule commands take only their id; the rest act on this chat.
        ...(!/Process|Schedule/.test(command) && { session: session.id }),
        ...(el.dataset.id && { id: el.dataset.id }),
        ...(el.dataset.off && { off: true }),
      });
    } else if (a === "helper") {
      const id = el.dataset.id ?? "";
      if (el.dataset.command === "agent.stopHelper") run("agent.stopHelper", { helper: id });
      else run("agent.helpers", { helper: id, action: el.dataset.act });
    } else if (a === "url") run("agent.openLink", { url: el.dataset.url });
    else if (a === "folder") {
      const folder = session.folder.peek();
      if (!folder) return;
      // The open folder shows in the explorer; another one (the chat moved on) in the system's.
      const open = this.deps.openFolder.peek();
      // This window's chat may be stored with its workspace file (D251), which the explorer
      // doesn't list: its first folder is revealed instead.
      if (open && this.deps.isThisWorkspace(folder)) run("explorer.reveal", { path: open });
      else run("explorer.revealInOs", { path: folder });
    } else if (a === "model") this.deps.showModelMenu(el);
    else if (a === "agent") run("agent.editAgent", { name: el.dataset.name });
    else if (a === "mode") this.showModes(el);
    else if (a === "outputStyle") run("agent.setOutputStyle", {});
    else if (a === "branch") run("git.checkout", {});
    else if (a === "compact") {
      // An external agent compacts its own context: its /compact (D409).
      if (el.dataset.external) run("agent.send", { session: session.id, message: "/compact" });
      else run("agent.compact", { session: session.id });
    }
  }

  private showModes(anchor: HTMLElement): void {
    const { session, run } = this.deps;
    // How the chat works, whichever agent it's with (D249); agents are picked in the composer.
    const current = session.work();
    const item = (mode: string, label: string, glyph: IconName): MenuItem => ({
      label,
      icon: glyph,
      checked: current === mode,
      run: () => run("agent.setChatMode", { session: session.id, mode }),
    });
    this.menu?.dispose();
    this.menu = showMenu(
      anchor,
      [
        item("agent", "Agent", "agent"),
        item("plan", "Plan", "list-tree"),
        item("ask", "Ask", "message-circle-question"),
      ],
      "Mode",
    );
  }

  dispose(): void {
    this.endDrag?.();
    clearTimeout(this.timer);
    clearTimeout(this.tick);
    this.menu?.dispose();
    this.store.dispose();
  }
}

function modeIcon(mode: string): IconName {
  return mode === "plan"
    ? "list-tree"
    : mode === "ask"
      ? "message-circle-question"
      : mode === "agent"
        ? "agent"
        : "sparkles";
}

/** A row: a leading icon (or element), the text, an optional value on the right. */
function row(
  lead: IconName | HTMLElement,
  text: string | HTMLElement,
  value: string | null = null,
  action: { action: string; name?: string } | null = null,
): HTMLElement {
  return h(
    action ? "button" : "div",
    {
      class: { "agent-details-row": true, "is-action": !!action },
      ...(action && { type: "button", "data-action": action.action }),
      ...(action?.name && { "data-name": action.name }),
    },
    h("span", { class: "agent-details-lead" }, typeof lead === "string" ? icon(lead) : lead),
    typeof text === "string" ? h("span", { class: "agent-details-label" }, text) : text,
    value === null ? null : h("span", { class: "agent-details-num" }, value),
  );
}

/** A context row: color square, label (a fold when it has parts), tokens, percent. */
function tokenRow(
  key: ContextKey | "free",
  label: string,
  tokens: number,
  percent: number,
  fold: { id: string; open: boolean } | null,
): HTMLElement {
  return h(
    fold ? "button" : "div",
    {
      class: { "agent-details-row": true, "is-token": true, "is-action": !!fold },
      ...(fold && {
        type: "button",
        "data-action": "sub",
        "data-fold": fold.id,
        "aria-expanded": String(fold.open),
      }),
    },
    h("span", { class: `agent-details-swatch is-${key}` }),
    h(
      "span",
      { class: "agent-details-label" },
      label,
      fold ? icon(fold.open ? "chevron-down" : "chevron-right") : null,
    ),
    h("span", { class: "agent-details-num" }, formatTokens(tokens)),
    h("span", { class: "agent-details-num agent-details-pct" }, `${percent}%`),
  );
}

/** A quiet text button that runs `command` for the chat. */
function link(label: string, command: string, tooltip: string): HTMLElement {
  const b = h(
    "button",
    { class: "agent-details-link", type: "button", "data-action": "run", "data-command": command },
    label,
  );
  setTooltip(b, tooltip, command);
  return b;
}
