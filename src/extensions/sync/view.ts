// The Sync tab (D435), laid out like the Settings tab (settings.css: .settings-view,
// .settings-layout, .settings-nav, .settings-main, .settings-card): while sync is on, the pages
// on the left (an icon rail when the tab is narrow) and the open page on the right (pages.ts);
// before that, one focused pane without the navigation (sign in, turn on, join, the recovery
// key). Its own pieces are in sync.css. It draws from the controller's and the session's signals,
// and its buttons run commands (commands.ts). Three things go around the dispatcher on purpose:
// moving between the tab's own pages (as Settings does; `sync.show {page}` does it for others),
// copying and saving the recovery key (a command's input is written to the audit log), and what
// the person types back, which the session hands to the command.
import { relativeAge } from "../../core/agent/rooms";
import type { Json } from "../../core/dock/index";
import { type Child, h, on } from "../../core/dom/index";
import { attachIpc } from "../../core/ipc/agent";
import type { SyncStatus } from "../../core/ipc/sync";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu, showMenu } from "../../ui/Menu";
import { keepTimesCurrent, timeAttrs } from "../../ui/relativeTimes";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { SYNC_VIEW } from "./commands";
import type { SyncController } from "./controller";
import { isSyncPage, PRIVACY_NOTE, pageByKey, SYNC_PAGES, type SyncPageId } from "./model";
import { drawPage, type PageKit, RESET_NOTE } from "./pages";
import { DEFAULT_DEVICE_NAME, type SyncSession, type SyncStep } from "./session";

/** How often a computer waiting to be approved asks whether it has been. */
const PENDING_POLL_MS = 4_000;

const PAGE_ICONS: Record<SyncPageId, IconName> = {
  overview: "layout-dashboard",
  projects: "folder-git-2",
  content: "sliders-horizontal",
  computers: "monitor-smartphone",
  security: "shield",
  storage: "server",
  activity: "history",
};

/** What sync brings, said before it is on. */
const BENEFITS: readonly (readonly [IconName, string])[] = [
  [
    "sliders-horizontal",
    "Your settings, keyboard shortcuts, and your own rules, skills and agents.",
  ],
  ["message-square", "The chats of the projects you choose to sync."],
  ["history", "Snapshots of unfinished work in those projects, with a history."],
];

class SyncView implements DockView, PageKit {
  readonly element: HTMLElement;
  /** The listeners of what is drawn now. */
  readonly drawn: DisposableStore;
  private readonly store = new DisposableStore();
  private readonly menu = this.store.add(new MutableDisposable());
  /** While sync is on: the navigation and the open page. */
  private readonly layout: HTMLElement;
  private readonly navItems: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly page: HTMLElement;
  /** Before it is on: one focused pane. */
  private readonly setupScroller: HTMLElement;
  private readonly setup: HTMLElement;
  /** What is typed in the tab's fields, kept across redraws. */
  private readonly fields = new Map<string, string>();
  /** The parts left open (a kind's file names), kept across redraws. */
  private readonly opened = new Set<string>();
  private lastDrawn = "";
  /** What the scroller last showed: another page (or project) starts at its top. */
  private lastShown = "";
  /** Whether the name field took this computer's own name already (once; then it's the person's). */
  private prefilled = false;

  constructor(
    readonly services: WorkbenchServices,
    readonly controller: SyncController,
    readonly session: SyncSession,
    state: Json,
  ) {
    this.drawn = this.store.add(new DisposableStore());
    // The page it was left on (a restored tab).
    const saved =
      state && typeof state === "object" && !Array.isArray(state) ? state.page : undefined;
    // (unless something asked for a page meanwhile: `sync.show {page}` before the tab was made).
    if (isSyncPage(saved) && session.page.peek() === "overview") session.page.value = saved;

    this.navItems = h("div", { class: "settings-nav-items" });
    this.page = h("div", { class: "sync-page" });
    this.scroller = h("div", { class: "settings-scroll sync-scroll" }, this.page);
    this.layout = h(
      "div",
      { class: "settings-layout sync-layout" },
      h("nav", { class: "settings-nav sync-nav", "aria-label": "Sync pages" }, this.navItems),
      h("div", { class: "settings-main" }, this.scroller),
    );
    this.setup = h("div", { class: "sync-setup" });
    this.setupScroller = h("div", { class: "sync-setup-scroll" }, this.setup);
    this.element = h(
      "div",
      { class: "settings-view sync-view", tabindex: "-1" },
      this.layout,
      this.setupScroller,
    );
    this.fields.set("name", session.deviceName);
    this.store.add(keepTimesCurrent(this.element, relativeAge));
    // The arrows move along the navigation; Enter and Space open the page (a button's own).
    this.store.add(
      on(this.navItems, "keydown", (event) => {
        const from = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-page]");
        const current = from?.dataset.page;
        if (!isSyncPage(current)) return;
        const to = pageByKey(current, event.key);
        if (!to) return;
        event.preventDefault();
        this.navItems.querySelector<HTMLElement>(`[data-page="${to}"]`)?.focus();
      }),
    );
    this.store.add(
      effect(() => {
        const seen = JSON.stringify([
          controller.status.value,
          controller.activity.value,
          controller.project.value,
          controller.snapshots.value,
          controller.overview.value,
          controller.log.value,
          controller.reviewing.value,
          session.ownName.value,
          session.profile.value,
          session.step.value,
          session.working.value,
          session.page.value,
          session.projectId.value,
          services.workspace.root.value,
          // The switches follow the settings file.
          services.settings.version.value,
        ]);
        // A status read that says the same again (a waiting computer asks every few seconds)
        // redraws nothing.
        if (seen === this.lastDrawn) return undefined;
        this.lastDrawn = seen;
        // The name field starts with this computer's own name, unless one was typed already.
        const own = session.ownName.peek();
        const typed = this.fields.get("name") ?? "";
        if (own && !this.prefilled && (typed === "" || typed === DEFAULT_DEVICE_NAME)) {
          this.prefilled = true;
          this.fields.set("name", own);
        }
        this.draw();
        return undefined;
      }),
    );
    // Waiting to be approved: ask now and then whether it happened.
    this.store.add(
      effect(() => {
        if (controller.status.value?.state !== "pending") return undefined;
        const timer = setInterval(
          () => void controller.refreshStatus().catch(() => {}),
          PENDING_POLL_MS,
        );
        return () => clearInterval(timer);
      }),
    );
  }

  // ------------------------------------------------------------ the kit (pages.ts builds with it)

  run(id: string, input: unknown = {}): Promise<unknown> {
    const { session, services } = this;
    session.working.value = id;
    return services.dispatcher
      .execute(id, input)
      .catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err), {
          title: "Sync",
        });
        return null;
      })
      .finally(() => {
        if (session.working.peek() === id) session.working.value = null;
      });
  }

  go(page: SyncPageId, project?: string | null): void {
    if (project !== undefined) this.session.projectId.value = project;
    this.session.page.value = page;
  }

  button(
    label: string,
    click: () => unknown,
    kind: "primary" | "secondary" | "danger" | "ghost" = "secondary",
    glyph: IconName | null = null,
  ): HTMLButtonElement {
    const el = h(
      "button",
      { class: `button button-${kind} button-sm sync-button`, type: "button" },
      glyph ? icon(glyph) : null,
      h("span", { class: "sync-button-label" }, label),
    );
    el.disabled = this.session.working.peek() !== null;
    this.drawn.add(on(el, "click", () => void click()));
    return el;
  }

  link(
    label: string,
    click: () => unknown,
    glyph: IconName | null = null,
    danger = false,
  ): HTMLElement {
    const el = h(
      "button",
      { class: danger ? "ai-link is-danger" : "ai-link", type: "button" },
      label,
      glyph ? icon(glyph) : null,
    );
    this.drawn.add(on(el, "click", () => void click()));
    return el;
  }

  text(words: string, quiet = false): HTMLElement {
    return h("p", { class: quiet ? "sync-text is-quiet" : "sync-text" }, words);
  }

  when(time: number): HTMLElement {
    return h("span", { ...timeAttrs(time) }, relativeAge(time));
  }

  details(key: string, summary: Child[], ...children: Child[]): HTMLElement {
    const el = h(
      "details",
      { class: "sync-details", "data-details": key },
      h("summary", { class: "sync-details-summary" }, icon("chevron-right"), ...summary),
      ...children,
    );
    el.open = this.opened.has(key);
    this.drawn.add(
      on(el, "toggle", () => {
        if (el.open) this.opened.add(key);
        else this.opened.delete(key);
      }),
    );
    return el;
  }

  /** A menu at a point (a right-click). */
  contextMenu(x: number, y: number, items: MenuItem[]): void {
    this.menu.value = showContextMenu(x, y, items);
  }

  menuButton(label: string, items: MenuItem[], menuLabel: string): HTMLElement {
    const more = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": label, "aria-haspopup": "menu" },
      icon("ellipsis"),
    );
    this.drawn.add(
      on(more, "click", (event) => {
        // Inside a row that is itself a button, the menu is all the click does.
        event.stopPropagation();
        this.menu.value = showMenu(more, items, menuLabel);
      }),
    );
    return more;
  }

  // ------------------------------------------------------------ small builders of the setup pane

  /** A text field whose text survives redraws (`key` names it). */
  private input(
    key: string,
    label: string,
    options: { placeholder?: string; multiline?: boolean; submit?: () => unknown } = {},
  ): HTMLElement {
    const control = options.multiline
      ? h("textarea", { class: "input sync-key-input", rows: "3" })
      : h("input", { class: "input", type: "text" });
    control.setAttribute("data-field", key);
    control.setAttribute("spellcheck", "false");
    control.setAttribute("autocomplete", "off");
    if (options.placeholder) control.setAttribute("placeholder", options.placeholder);
    control.value = this.fields.get(key) ?? "";
    this.drawn.add(on(control, "input", () => this.fields.set(key, control.value)));
    const submit = options.submit;
    if (submit && !options.multiline)
      this.drawn.add(
        on(control, "keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void submit();
        }),
      );
    return h(
      "label",
      { class: "ai-field sync-field" },
      h("span", { class: "ai-field-label" }, label),
      control,
    );
  }

  /** One card of the setup pane, with a title when it is a step of its own. */
  private panel(title: string | null, ...children: Child[]): HTMLElement {
    return h(
      "section",
      { class: "settings-card sync-card sync-panel" },
      title ? h("h2", { class: "sync-panel-title" }, title) : null,
      ...children,
    );
  }

  private buttonRow(...children: Child[]): HTMLElement {
    return h("div", { class: "sync-actions" }, ...children);
  }

  private name(): string {
    const name = (this.fields.get("name") ?? "").trim();
    this.session.deviceName = name || this.session.deviceName;
    return this.session.deviceName;
  }

  // ------------------------------------------------------------ drawing

  /** Sync is on here and no key is on show: the pages. Otherwise the setup pane. */
  private onStatus(): SyncStatus | null {
    const { controller, session } = this;
    if (!controller.base()) return null;
    const profile = session.profile.peek();
    const status = controller.status.peek();
    if (profile?.sync !== true || status?.state !== "on") return null;
    return session.step.peek().step === "key" ? null : status;
  }

  private draw(): void {
    // The field being typed in keeps the caret through a redraw, and the navigation its focus.
    const active = document.activeElement;
    const field =
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      this.element.contains(active) &&
      active.dataset.field !== undefined
        ? { key: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
        : null;
    const navFocus =
      active instanceof HTMLElement && this.navItems.contains(active)
        ? active.dataset.page
        : undefined;
    this.drawn.clear();
    const { session } = this;
    if (session.step.peek().step === "none") {
      this.fields.delete("confirm");
      this.fields.delete("recovery");
    }
    const status = this.onStatus();
    this.layout.hidden = status === null;
    this.setupScroller.hidden = status !== null;
    if (status) {
      this.setup.replaceChildren();
      this.drawPages(status);
    } else {
      this.navItems.replaceChildren();
      this.page.replaceChildren();
      this.lastShown = "";
      this.drawSetup();
    }
    if (field) {
      const again = this.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-field="${field.key}"]`,
      );
      if (again) {
        again.focus();
        if (field.start !== null && field.end !== null)
          again.setSelectionRange(field.start, field.end);
      }
    } else if (navFocus) {
      this.navItems.querySelector<HTMLElement>(`[data-page="${navFocus}"]`)?.focus();
    }
  }

  private drawPages(status: SyncStatus): void {
    const { session } = this;
    const current = session.page.peek();
    const waiting = status.devices.filter((d) => d.status === "pending").length;
    this.navItems.replaceChildren(
      ...SYNC_PAGES.map((entry) => {
        const selected = entry.id === current;
        const count = entry.id === "computers" && waiting > 0 ? waiting : 0;
        const label = count > 0 ? `${entry.title} (${count} waiting)` : entry.title;
        const el = h(
          "button",
          {
            class: { "settings-nav-item": true, "is-selected": selected },
            type: "button",
            "data-page": entry.id,
            "aria-label": label,
            ...(selected && { "aria-current": "page" }),
            // One stop for Tab; the arrows move along the list.
            tabindex: selected ? "0" : "-1",
          },
          icon(PAGE_ICONS[entry.id]),
          h("span", { class: "settings-nav-label" }, entry.title),
          count > 0 ? h("span", { class: "sync-nav-count" }, String(count)) : null,
        );
        setTooltip(el, label, undefined, { placement: "right" });
        this.drawn.add(on(el, "click", () => this.go(entry.id)));
        return el;
      }),
    );
    const entry = SYNC_PAGES.find((p) => p.id === current) ?? SYNC_PAGES[0];
    this.page.setAttribute("data-page", entry.id);
    this.page.replaceChildren(
      h(
        "header",
        { class: "sync-page-head" },
        h("h1", { class: "settings-page-title" }, entry.title),
        h("p", { class: "sync-page-lead" }, entry.lead),
      ),
      ...drawPage(this, entry.id, status).filter((node): node is Node => node instanceof Node),
    );
    const shown = `${entry.id}/${entry.id === "projects" ? (session.projectId.peek() ?? "") : ""}`;
    if (shown !== this.lastShown) {
      this.lastShown = shown;
      this.scroller.scrollTop = 0;
    }
  }

  private drawSetup(): void {
    this.setup.replaceChildren(
      h(
        "header",
        { class: "sync-setup-head" },
        h("h1", { class: "sync-setup-title" }, "Sync"),
        h(
          "p",
          { class: "sync-setup-lead" },
          "Your settings, chats and unfinished work on every computer you use, encrypted before they leave this one.",
        ),
      ),
      ...this.setupContent().filter((node): node is Node => node !== null),
    );
  }

  private setupContent(): (Node | null)[] {
    const { controller, session } = this;
    if (!controller.base())
      return [
        this.panel(
          null,
          this.text("Sync needs an account, and this build has no accounts service."),
        ),
      ];
    const profile = session.profile.peek();
    const status = controller.status.peek();
    if (!profile || status?.state === "signedOut")
      return [
        this.panel(
          null,
          this.text("Sign in to your account to sync between your computers."),
          this.buttonRow(
            this.button(
              "Sign in",
              () => this.run("accounts.signIn", { provider: "ide" }),
              "primary",
              "log-in",
            ),
          ),
        ),
      ];
    if (profile.sync !== true || status?.state === "unavailable")
      return [this.panel(null, this.text("Sync isn't open to this account yet."))];
    if (!status) return [this.panel(null, this.text("Checking where sync stands…", true))];
    const step = session.step.peek();
    if (step.step === "key") return this.keyStep(step.purpose, step.error);
    if (status.state === "pending") return this.whenPending(status, step);
    return status.exists ? this.join(step) : this.turnOn();
  }

  private turnOn(): (Node | null)[] {
    const start = () => this.run("sync.turnOn", { name: this.name() });
    return [
      h(
        "ul",
        { class: "sync-benefits" },
        ...BENEFITS.map(([glyph, words]) =>
          h("li", { class: "sync-benefit" }, icon(glyph), h("span", null, words)),
        ),
      ),
      this.panel(
        "Turn on sync",
        this.text(
          "This computer becomes the first that syncs. Next you get a recovery key to keep; nothing is sent before you confirm it.",
          true,
        ),
        h(
          "div",
          { class: "sync-form" },
          this.input("name", "Computer name", { submit: start }),
          this.buttonRow(this.button("Turn on sync", start, "primary")),
        ),
      ),
      this.text(PRIVACY_NOTE, true),
    ];
  }

  private keyStep(purpose: "setup" | "new", error: string | null): (Node | null)[] {
    const key = this.session.recoveryKey() ?? "";
    const copy = async () => {
      await clipboardIpc.writeText(key);
      this.services.notifications.show("info", "Recovery key copied.", { title: "Sync" });
    };
    const save = async () => {
      const account = this.session.profile.peek();
      const text = [
        `Sync recovery key for ${product.nameLong}`,
        ...(account?.email ? [`Account: ${account.email}`] : []),
        "",
        key,
        "",
        "Keep this somewhere safe. With it, a new computer can join sync without another computer's approval.",
        "",
      ].join("\n");
      const saved = await attachIpc
        .saveAs(
          `${product.nameShort.toLowerCase()}-recovery-key.txt`,
          new TextEncoder().encode(text),
        )
        .catch((err: unknown) => {
          this.services.notifications.show(
            "error",
            err instanceof Error ? err.message : String(err),
            { title: "Sync" },
          );
          return null;
        });
      if (saved)
        this.services.notifications.show("success", "Recovery key saved.", { title: "Sync" });
    };
    const keyBlock = [
      h("pre", { class: "sync-key", "aria-label": "Recovery key" }, key),
      this.buttonRow(
        this.button("Copy", copy, "secondary", "copy"),
        this.button("Save to file…", save, "secondary", "download"),
      ),
    ];
    if (purpose === "new")
      return [
        this.panel(
          "Your new recovery key",
          this.text(
            "Keep it somewhere safe: it is shown only now. The old key no longer works. With this one, a new computer can join sync without another computer's approval.",
          ),
          ...keyBlock,
          this.text(RESET_NOTE, true),
          this.buttonRow(this.button("Done", () => this.run("sync.closeStep"), "primary")),
        ),
      ];
    const finish = () => {
      const typed = (this.fields.get("confirm") ?? "").trim();
      if (!typed) return;
      this.session.offer(typed);
      return this.run("sync.turnOn");
    };
    return [
      this.panel(
        "Keep your recovery key",
        this.text(
          "Copy it, save it or write it down before going on: it is shown only now, and nothing is sent until you confirm it. With it, a new computer can join sync without another computer's approval.",
        ),
        ...keyBlock,
        this.text(RESET_NOTE, true),
        h(
          "div",
          { class: "sync-form" },
          this.input("confirm", "Type the last four characters to confirm", { submit: finish }),
          error ? h("div", { class: "ai-error", role: "alert" }, error) : null,
          this.buttonRow(
            this.button("Finish", finish, "primary"),
            this.button("Cancel", () => this.run("sync.closeStep"), "ghost"),
          ),
        ),
      ),
    ];
  }

  /** The recovery key asked for, to join without another computer. */
  private recoveryForm(error: string | null): HTMLElement {
    const join = () => {
      const key = (this.fields.get("recovery") ?? "").trim();
      if (!key) return;
      this.name();
      this.session.offer(key);
      return this.run("sync.useRecoveryKey");
    };
    return h(
      "div",
      { class: "sync-form" },
      this.input("recovery", "Recovery key", {
        multiline: true,
        placeholder: "14 groups of four characters",
      }),
      error ? h("div", { class: "ai-error", role: "alert" }, error) : null,
      this.buttonRow(
        this.button("Join", join, "primary"),
        this.button("Back", () => this.run("sync.closeStep"), "ghost"),
      ),
    );
  }

  private join(step: SyncStep): (Node | null)[] {
    const join = () => this.run("sync.join", { name: this.name() });
    const asking = step.step === "recovery";
    return [
      this.panel(
        "Join sync from this computer",
        this.text(
          "This account already syncs. A computer that already syncs approves this one, or you enter the recovery key.",
          true,
        ),
        h(
          "div",
          { class: "sync-form" },
          this.input("name", "Computer name", asking ? {} : { submit: join }),
          asking ? null : this.buttonRow(this.button("Join", join, "primary")),
        ),
        asking
          ? this.recoveryForm(step.error)
          : this.link("Use the recovery key instead", () => this.run("sync.useRecoveryKey")),
      ),
      this.text(PRIVACY_NOTE, true),
    ];
  }

  private whenPending(status: SyncStatus, step: SyncStep): (Node | null)[] {
    const asking = step.step === "recovery";
    return [
      this.panel(
        "Waiting to be approved",
        status.code === null
          ? this.text(
              "On a computer that already syncs, open Sync and choose Check code for this computer.",
            )
          : h("div", { class: "sync-code", "aria-label": "Verification code" }, status.code),
        status.code === null
          ? null
          : this.text("Check that the other computer shows the same code, then approve it there."),
        asking ? this.recoveryForm(step.error) : null,
        this.buttonRow(
          asking
            ? null
            : this.button("Use the recovery key instead", () => this.run("sync.useRecoveryKey")),
          this.button("Cancel", () => this.run("sync.turnOff"), "ghost"),
        ),
      ),
      this.text(PRIVACY_NOTE, true),
    ];
  }

  // ------------------------------------------------------------ the dock's side

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return { page: this.session.page.peek() };
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function syncViewDescriptor(
  services: WorkbenchServices,
  controller: SyncController,
  session: SyncSession,
): DockViewDescriptor {
  return {
    type: SYNC_VIEW,
    title: () => "Sync",
    icon: () => "refresh-cw",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) => new SyncView(services, controller, session, state),
  };
}
