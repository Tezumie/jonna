// The Sync tab (D435): one calm column, on the AI pages' layout (ai-setup.css) with its own
// pieces in sync.css. It draws from the controller's and the session's signals, and its buttons
// run commands (commands.ts). Two things go around the dispatcher on purpose: copying and saving
// the recovery key (a command's input is written to the audit log), and what the person types
// back, which the session hands to the command.
import { relativeAge } from "../../core/agent/rooms";
import type { Json } from "../../core/dock/index";
import { type Child, h, on } from "../../core/dom/index";
import { attachIpc } from "../../core/ipc/agent";
import type { SyncDevice, SyncStatus } from "../../core/ipc/sync";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showMenu } from "../../ui/Menu";
import { keepTimesCurrent, timeAttrs } from "../../ui/relativeTimes";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { SYNC_VIEW } from "./commands";
import type { SnapshotRow, SyncController } from "./controller";
import {
  activityLine,
  countOf,
  folderName,
  formatSize,
  groupFiles,
  type OverviewProject,
  PRIVACY_NOTE,
  platformLabel,
  projectCounts,
  retentionText,
  type SyncEvent,
  serviceTime,
  storageNotice,
  storageShare,
} from "./model";
import { DEFAULT_DEVICE_NAME, type SyncSession, type SyncStep } from "./session";

/** How often a computer waiting to be approved asks whether it has been. */
const PENDING_POLL_MS = 4_000;

/** The switches under "What syncs": setting key and its words. */
export const SYNCED_KINDS: readonly (readonly [key: string, label: string])[] = [
  ["sync.settings", "Settings"],
  ["sync.keybindings", "Keyboard shortcuts"],
  ["sync.snippets", "Snippets"],
  ["sync.rules", "Your rules file"],
  ["sync.agents", "Your agents"],
  ["sync.commands", "Your commands"],
  ["sync.outputStyles", "Your output styles"],
  ["sync.skills", "Your skills"],
  ["sync.chats", "Chats"],
  ["sync.snapshots", "Snapshots of synced projects"],
];

const RESET_NOTE =
  "If you lose every computer that syncs and this key, the synced copy can't be read by anyone, the service included. You would then reset sync on the account page and upload again from a computer that still has your data; the snapshot history is lost by a reset.";

class SyncView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly drawn = this.store.add(new DisposableStore());
  private readonly menu = this.store.add(new MutableDisposable());
  private readonly body: HTMLElement;
  /** What is typed in the tab's fields, kept across redraws. */
  private readonly fields = new Map<string, string>();
  /** The parts left open (your files, recent activity), kept across redraws. */
  private readonly opened = new Set<string>();
  private lastDrawn = "";
  /** Whether the name field took this computer's own name already (once; then it's the person's). */
  private prefilled = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly controller: SyncController,
    private readonly session: SyncSession,
  ) {
    this.body = h("div", { class: "ai-setup sync-page" });
    this.element = h("div", { class: "ai-page sync-view", tabindex: "-1" }, this.body);
    this.fields.set("name", session.deviceName);
    this.store.add(keepTimesCurrent(this.element, relativeAge));
    this.store.add(
      effect(() => {
        const seen = JSON.stringify([
          controller.status.value,
          controller.activity.value,
          controller.project.value,
          controller.snapshots.value,
          controller.overview.value,
          controller.log.value,
          session.ownName.value,
          session.profile.value,
          session.step.value,
          session.working.value,
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

  // ------------------------------------------------------------ small builders

  private run(id: string, input: unknown = {}): Promise<unknown> {
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

  private button(
    label: string,
    click: () => unknown,
    kind: "primary" | "secondary" | "danger" | "ghost" = "secondary",
    glyph: IconName | null = null,
    attrs: Record<string, string> = {},
  ): HTMLButtonElement {
    const el = h(
      "button",
      { class: `button button-${kind} button-sm sync-button`, type: "button", ...attrs },
      glyph ? icon(glyph) : null,
      label,
    );
    el.disabled = this.session.working.peek() !== null;
    this.drawn.add(on(el, "click", () => void click()));
    return el;
  }

  private link(label: string, click: () => unknown, glyph: IconName | null = null): HTMLElement {
    const el = h("button", { class: "ai-link", type: "button" }, label, glyph ? icon(glyph) : null);
    this.drawn.add(on(el, "click", () => void click()));
    return el;
  }

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

  private section(title: string, ...children: (Node | null)[]): HTMLElement {
    return h(
      "section",
      { class: "ai-section sync-section" },
      h("h2", { class: "ai-section-title" }, title),
      ...children,
    );
  }

  private text(words: string, quiet = false): HTMLElement {
    return h("p", { class: quiet ? "sync-text is-quiet" : "sync-text" }, words);
  }

  private when(time: number): HTMLElement {
    return h("span", { ...timeAttrs(time) }, relativeAge(time));
  }

  private name(): string {
    const name = (this.fields.get("name") ?? "").trim();
    this.session.deviceName = name || this.session.deviceName;
    return this.session.deviceName;
  }

  // ------------------------------------------------------------ drawing

  private draw(): void {
    // The field being typed in keeps the caret through a redraw.
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? { key: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
        : null;
    const hadFocus = focused?.key !== undefined && this.body.contains(active);
    this.drawn.clear();
    const { session } = this;
    if (session.step.peek().step === "none") {
      this.fields.delete("confirm");
      this.fields.delete("recovery");
    }
    this.body.replaceChildren(
      h(
        "header",
        { class: "ai-header" },
        h(
          "div",
          null,
          h("h1", { class: "ai-title" }, "Sync"),
          h(
            "p",
            { class: "ai-lead" },
            "Your settings, chats and unfinished work on every computer you use, encrypted before they leave this one.",
          ),
        ),
      ),
      ...this.content().filter((node): node is Node => node !== null),
    );
    if (hadFocus && focused?.key) {
      const again = this.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-field="${focused.key}"]`,
      );
      if (again) {
        again.focus();
        if (focused.start !== null && focused.end !== null)
          again.setSelectionRange(focused.start, focused.end);
      }
    }
  }

  private content(): (Node | null)[] {
    const { controller, session } = this;
    if (!controller.base())
      return [this.text("Sync needs an account, and this build has no accounts service.")];
    const profile = session.profile.peek();
    const status = controller.status.peek();
    if (!profile || status?.state === "signedOut")
      return [
        this.text("Sign in to your account to sync between your computers."),
        h(
          "div",
          { class: "sync-actions" },
          this.button(
            "Sign in",
            () => this.run("accounts.signIn", { provider: "ide" }),
            "primary",
            "log-in",
          ),
        ),
      ];
    if (profile.sync !== true || status?.state === "unavailable")
      return [this.text("Sync isn't open to this account yet.")];
    if (!status) return [this.text("Checking where sync stands…", true)];
    const step = session.step.peek();
    if (step.step === "key") return this.keyStep(step.purpose, step.error);
    if (status.state === "on") return this.whenOn(status);
    if (status.state === "pending") return this.whenPending(status, step);
    return status.exists ? this.join(step) : this.turnOn();
  }

  private turnOn(): (Node | null)[] {
    const start = () => this.run("sync.turnOn", { name: this.name() });
    return [
      h(
        "ul",
        { class: "sync-points" },
        h("li", null, "Your settings, keyboard shortcuts, and your own rules, skills and agents."),
        h("li", null, "The chats of the projects you choose to sync."),
        h("li", null, "Snapshots of unfinished work in those projects, with a history."),
      ),
      this.text(PRIVACY_NOTE, true),
      h(
        "div",
        { class: "sync-form" },
        this.input("name", "Computer name", { submit: start }),
        h("div", { class: "sync-actions" }, this.button("Turn on sync", start, "primary")),
      ),
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
      h(
        "div",
        { class: "sync-actions" },
        this.button("Copy", copy, "secondary", "copy"),
        this.button("Save to file…", save, "secondary", "download"),
      ),
    ];
    if (purpose === "new")
      return [
        this.section(
          "Your new recovery key",
          this.text(
            "Keep it somewhere safe: it is shown only now. The old key no longer works. With this one, a new computer can join sync without another computer's approval.",
          ),
          ...keyBlock,
          this.text(RESET_NOTE, true),
          h(
            "div",
            { class: "sync-actions" },
            this.button("Done", () => this.run("sync.closeStep"), "primary"),
          ),
        ),
      ];
    const finish = () => {
      const typed = (this.fields.get("confirm") ?? "").trim();
      if (!typed) return;
      this.session.offer(typed);
      return this.run("sync.turnOn");
    };
    return [
      this.section(
        "Keep your recovery key",
        this.text(
          "Copy it, save it or write it down before going on: it is shown only now, and nothing is sent until you confirm it. With it, a new computer can join sync without another computer's approval.",
        ),
        ...keyBlock,
        this.text(RESET_NOTE),
        h(
          "div",
          { class: "sync-form" },
          this.input("confirm", "Type the last four characters to confirm", { submit: finish }),
          error ? h("div", { class: "ai-error", role: "alert" }, error) : null,
          h(
            "div",
            { class: "sync-actions" },
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
      h(
        "div",
        { class: "sync-actions" },
        this.button("Join", join, "primary"),
        this.button("Back", () => this.run("sync.closeStep"), "ghost"),
      ),
    );
  }

  private join(step: SyncStep): (Node | null)[] {
    const join = () => this.run("sync.join", { name: this.name() });
    const asking = step.step === "recovery";
    return [
      this.text(
        "This account already syncs. Join from this computer: a computer that already syncs approves it, or you enter the recovery key.",
      ),
      this.text(PRIVACY_NOTE, true),
      h(
        "div",
        { class: "sync-form" },
        this.input("name", "Computer name", asking ? {} : { submit: join }),
        asking ? null : h("div", { class: "sync-actions" }, this.button("Join", join, "primary")),
      ),
      asking
        ? this.recoveryForm(step.error)
        : this.link("Use the recovery key instead", () => this.run("sync.useRecoveryKey")),
    ];
  }

  private whenPending(status: SyncStatus, step: SyncStep): (Node | null)[] {
    const asking = step.step === "recovery";
    return [
      this.section(
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
        h(
          "div",
          { class: "sync-actions" },
          asking
            ? null
            : this.button("Use the recovery key instead", () => this.run("sync.useRecoveryKey")),
          this.button("Cancel", () => this.run("sync.turnOff"), "ghost"),
        ),
      ),
      this.text(PRIVACY_NOTE, true),
    ];
  }

  private whenOn(status: SyncStatus): (Node | null)[] {
    const { controller, services, session } = this;
    const made = serviceTime(status.recoveryCreatedAt);
    const boxes = SYNCED_KINDS.map(([key, label]) => {
      const box = h("input", { class: "checkbox", type: "checkbox" });
      box.checked = services.settings.peek<boolean | undefined>(key) !== false;
      this.drawn.add(
        on(box, "change", () => void this.run("settings.set", { key, value: box.checked })),
      );
      return h("label", { class: "sync-check" }, box, h("span", null, label));
    });
    const limit = status.storageLimit || session.profile.peek()?.storageLimit || 0;
    return [
      this.statusHeader(),
      this.accountSection(),
      this.projectSection(),
      this.storageSection(status.usageBytes, limit),
      this.section(
        "Computers",
        h("div", { class: "sync-list" }, ...status.devices.map((d) => this.deviceRow(d))),
      ),
      this.section(
        "Recovery key",
        h(
          "p",
          { class: "sync-text is-quiet" },
          made === null
            ? "Lets a new computer join without another computer's approval."
            : [
                "Made ",
                this.when(made),
                ". Lets a new computer join without another computer's approval.",
              ],
        ),
        h(
          "div",
          { class: "sync-actions" },
          this.button("Make a new recovery key", () => this.run("sync.newRecoveryKey")),
        ),
      ),
      this.section(
        "What syncs",
        this.text("What this computer sends and takes. Each computer has its own choice.", true),
        h("div", { class: "sync-checks" }, ...boxes),
      ),
      this.activitySection(controller.log.peek()),
      h(
        "footer",
        { class: "sync-footer" },
        this.text(PRIVACY_NOTE, true),
        this.link(
          "Manage devices and storage, or reset sync, on the account page",
          () => this.run("sync.openAccountPage"),
          "external-link",
        ),
        this.link("Turn off sync on this computer", () => this.run("sync.turnOff")),
      ),
    ];
  }

  /** Is it working: the state, when it last synced, and Sync now (Retry after an error). */
  private statusHeader(): HTMLElement {
    const activity = this.controller.activity.peek();
    const failed = activity.state === "error";
    const line = activityLine(activity);
    const glyph: IconName = failed
      ? "circle-alert"
      : activity.state === "syncing"
        ? "refresh-cw"
        : activity.state === "idle" && activity.at !== null
          ? "circle-check"
          : "cloud";
    // The time of the last good pass stays in sight while something else is said.
    const earlier = line.time === null && activity.at !== null ? activity.at : null;
    return h(
      "div",
      { class: `sync-status${failed ? " is-error" : ""}`, "data-state": activity.state },
      h(
        "div",
        { class: "sync-status-main", role: "status" },
        h(
          "div",
          { class: "sync-status-state" },
          icon(glyph),
          h(
            "span",
            { class: "sync-status-text" },
            failed ? "Sync ran into a problem" : line.text,
            line.time === null ? null : " ",
            line.time === null ? null : this.when(line.time),
          ),
        ),
        failed ? h("div", { class: "sync-status-reason" }, line.text) : null,
        earlier === null
          ? null
          : h("div", { class: "sync-status-earlier" }, "Last synced ", this.when(earlier)),
      ),
      failed
        ? this.button("Retry", () => this.run("sync.syncNow"), "secondary", "refresh-cw")
        : this.button("Sync now", () => this.run("sync.syncNow"), "secondary", "refresh-cw"),
    );
  }

  /** A part that opens and closes, and stays as it was left through redraws. */
  private details(key: string, summary: Child[], ...children: Child[]): HTMLElement {
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

  /** One line of what the account holds: what it is, and how much of it. */
  private holdingRow(kind: string, title: string, ...detail: Child[]): HTMLElement {
    return h(
      "div",
      { class: "sync-row is-line", "data-holding": kind },
      h("span", { class: "sync-row-name" }, title),
      h("span", { class: "sync-row-detail" }, ...detail),
    );
  }

  /** What is synced, by name: settings, the user's files, chats, and each project. */
  private accountSection(): HTMLElement {
    const { settings } = this.services;
    const overview = this.controller.overview.peek();
    const off = (key: string) => settings.peek<boolean | undefined>(key) === false;
    const none = (key: string) => (off(key) ? "Off on this computer" : "Nothing synced yet");

    const settingsRow = this.holdingRow(
      "settings",
      "Settings",
      ...(overview.settings
        ? [
            countOf(overview.settings.count, "setting"),
            ...(overview.settings.updatedAt === null
              ? []
              : [" · changed ", this.when(overview.settings.updatedAt)]),
          ]
        : [none("sync.settings")]),
    );

    const files =
      overview.files.length === 0
        ? this.holdingRow("files", "Your files", "Nothing synced yet")
        : this.details(
            "files",
            [
              h("span", { class: "sync-row-name" }, "Your files"),
              h("span", { class: "sync-row-detail" }, countOf(overview.files.length, "file")),
            ],
            ...groupFiles(overview.files).map((group) =>
              h(
                "div",
                { class: "sync-files", "data-kind": group.kind },
                h("div", { class: "sync-files-kind" }, group.label),
                ...group.files.map((file) =>
                  h(
                    "div",
                    { class: "sync-file" },
                    h("span", { class: "sync-file-path", title: file.path }, file.path),
                    h("span", { class: "sync-file-size" }, formatSize(file.bytes)),
                  ),
                ),
              ),
            ),
          );
    files.classList.add("sync-holding");
    files.setAttribute("data-holding", "files");

    const chats = this.holdingRow(
      "chats",
      "Chats without a folder",
      overview.accountChats > 0 ? countOf(overview.accountChats, "chat") : none("sync.chats"),
    );

    return this.section(
      "In your account",
      h("div", { class: "sync-list" }, settingsRow, files, chats),
      h("h3", { class: "sync-subtitle" }, "Projects"),
      overview.projects.length === 0
        ? this.text(
            "No projects yet. A project syncs once you choose Sync this project with it open.",
            true,
          )
        : h("div", { class: "sync-list" }, ...overview.projects.map((p) => this.projectRow(p))),
    );
  }

  private projectRow(project: OverviewProject): HTMLElement {
    const open = this.controller.project.peek();
    const isOpen = !!open?.on && open.id === project.id;
    const more = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": `More for ${project.name}` },
      icon("ellipsis"),
    );
    const items: MenuItem[] = [
      ...(isOpen
        ? [
            {
              label: "Snapshot now",
              icon: "camera" as const,
              run: () => void this.run("sync.snapshot.create"),
            },
            {
              label: "Stop syncing this project",
              run: () => void this.run("sync.project.disable"),
            },
          ]
        : []),
      {
        label: "Delete from the account…",
        icon: "trash-2",
        destructive: true,
        separatorBefore: isOpen,
        run: () => void this.run("sync.project.deleteFromAccount", { id: project.id }),
      },
    ];
    this.drawn.add(
      on(more, "click", () => {
        this.menu.value = showMenu(more, items, "Project");
      }),
    );
    return h(
      "div",
      { class: "sync-row is-compact", "data-project": project.id },
      h(
        "div",
        { class: "sync-row-main" },
        h(
          "div",
          { class: "sync-row-title" },
          h("span", { class: "sync-row-name", title: project.name }, project.name),
          h("span", { class: "ai-tag" }, project.here ? "This computer" : "Not on this computer"),
        ),
        h("div", { class: "sync-row-detail" }, projectCounts(project)),
        project.lastChange === null
          ? null
          : h(
              "div",
              { class: "sync-row-detail" },
              "Changed ",
              this.when(project.lastChange),
              project.lastComputer ? ` on ${project.lastComputer}` : null,
            ),
        project.folder
          ? h("div", { class: "sync-row-detail sync-path", title: project.folder }, project.folder)
          : null,
      ),
      h("div", { class: "sync-row-actions" }, more),
    );
  }

  private storageSection(used: number, limit: number): HTMLElement {
    const share = storageShare(used, limit);
    const notice = storageNotice(used, limit);
    const meter = h("div", {
      class: `sync-meter${notice ? " is-full" : ""}`,
      role: "meter",
      "aria-label": "Storage used",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(share * 100)),
    });
    meter.append(h("div", { class: "sync-meter-fill", style: { width: `${share * 100}%` } }));
    return this.section(
      "Storage",
      limit > 0 ? meter : null,
      this.text(
        limit > 0 ? `${formatSize(used)} used of ${formatSize(limit)}` : `${formatSize(used)} used`,
        true,
      ),
      notice ? h("p", { class: "sync-text sync-storage-notice" }, notice.text) : null,
    );
  }

  /** What sync did lately; closed until asked for. */
  private activitySection(log: readonly SyncEvent[]): HTMLElement {
    return h(
      "section",
      { class: "ai-section sync-section" },
      this.details(
        "activity",
        [h("h2", { class: "ai-section-title" }, "Recent activity")],
        log.length === 0
          ? this.text("Nothing yet.", true)
          : h(
              "div",
              { class: "sync-log" },
              ...log.map((event) =>
                h(
                  "div",
                  { class: `sync-log-row${event.error ? " is-error" : ""}` },
                  h("span", { class: "sync-log-time" }, this.when(event.at)),
                  h("span", { class: "sync-log-text" }, event.text),
                ),
              ),
            ),
      ),
    );
  }

  private deviceRow(device: SyncDevice): HTMLElement {
    const seen = serviceTime(device.lastSeenAt);
    const waiting = device.status === "pending";
    const checking = waiting && device.code !== null;
    const detail: (Node | string | null)[] = [platformLabel(device.platform)];
    if (waiting) detail.push(" · wants to join");
    else if (seen !== null) detail.push(" · last seen ", this.when(seen));
    return h(
      "div",
      { class: "sync-row", "data-device": device.id },
      h(
        "div",
        { class: "sync-row-main" },
        h(
          "div",
          { class: "sync-row-title" },
          h("span", { class: "sync-row-name", title: device.name }, device.name),
          device.current ? h("span", { class: "ai-tag" }, "This computer") : null,
        ),
        h("div", { class: "sync-row-detail" }, ...detail),
        checking
          ? h("div", { class: "sync-code is-row", "aria-label": "Verification code" }, device.code)
          : null,
        checking
          ? h(
              "div",
              { class: "sync-row-detail" },
              "Approve only if that computer shows the same code.",
            )
          : null,
      ),
      h(
        "div",
        { class: "sync-row-actions" },
        waiting && !checking
          ? this.button(
              "Check code",
              () => this.run("sync.reviewDevice", { device: device.id }),
              "primary",
            )
          : null,
        checking
          ? this.button(
              "Approve",
              () => this.run("sync.approveDevice", { device: device.id }),
              "primary",
            )
          : null,
        device.current
          ? null
          : this.button("Remove", () => this.run("sync.removeDevice", { device: device.id })),
      ),
    );
  }

  private projectSection(): HTMLElement | null {
    const { controller, services } = this;
    const project = controller.project.peek();
    if (!project) return null;
    const name = folderName(project.root);
    if (!project.on) {
      // A folder the account doesn't know, while the account has projects that aren't here:
      // it may be one of them (a copy made by hand, a clone without its remote).
      const linkable = !project.known && controller.overview.peek().projects.some((p) => !p.here);
      return this.section(
        "This project",
        this.text(
          `${name ? `${name} doesn't sync yet. ` : ""}When it does, its chats travel with you, and snapshots of unfinished work are taken automatically, with a history.${project.known ? " Another of your computers already syncs it." : ""}`,
          true,
        ),
        h(
          "div",
          { class: "sync-actions" },
          this.button("Sync this project", () => this.run("sync.project.enable"), "primary"),
        ),
        linkable
          ? this.link("This folder is one of my synced projects…", () =>
              this.run("sync.project.link"),
            )
          : null,
      );
    }
    const rows = controller.snapshots.peek();
    const other = controller.continueFrom();
    const continueButton = other
      ? h(
          "button",
          { class: "button button-primary button-sm sync-button", type: "button" },
          `Continue from ${other.summary.deviceName}, `,
          this.when(other.summary.time),
        )
      : null;
    if (continueButton) {
      continueButton.disabled = this.session.working.peek() !== null;
      this.drawn.add(on(continueButton, "click", () => void this.run("sync.snapshot.continue")));
    }
    const days = services.settings.peek<number | undefined>("sync.historyDays") ?? 30;
    return this.section(
      "This project",
      this.text(
        `${name || "This folder"} syncs from this computer: its chats, and snapshots of its unfinished work.`,
        true,
      ),
      h(
        "div",
        { class: "sync-actions" },
        continueButton,
        this.button("Snapshot now", () => this.run("sync.snapshot.create"), "secondary", "camera"),
      ),
      h(
        "div",
        { class: "sync-subhead" },
        h("h3", { class: "sync-subtitle" }, "Snapshot history"),
        h("span", { class: "sync-subhead-note" }, `${retentionText(days)}.`),
        this.link("Change", () => this.run("settings.open", { query: "@id:sync.historyDays" })),
      ),
      rows.length === 0
        ? this.text("No snapshots yet. One is taken when there is unfinished work.", true)
        : h("div", { class: "sync-list" }, ...rows.map((row) => this.snapshotRow(row))),
      h(
        "div",
        { class: "sync-actions" },
        this.link("Stop syncing this project", () => this.run("sync.project.disable")),
      ),
    );
  }

  private snapshotRow(row: SnapshotRow): HTMLElement {
    const { summary } = row;
    const pinned = summary.pinned;
    const pin = h(
      "button",
      {
        class: `icon-button sync-pin${pinned ? " is-on" : ""}`,
        type: "button",
        "aria-pressed": pinned ? "true" : "false",
        "aria-label": pinned ? `Unpin ${pinned}` : "Pin this snapshot",
        title: pinned ? "Unpin" : "Pin: keep it whatever its age",
      },
      icon(pinned ? "pin-off" : "pin"),
    );
    const togglePin = () =>
      this.run("sync.snapshot.pin", pinned ? { id: row.id, name: null } : { id: row.id });
    this.drawn.add(on(pin, "click", () => void togglePin()));
    const more = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "More for this snapshot" },
      icon("ellipsis"),
    );
    const items: MenuItem[] = [
      {
        label: "Restore…",
        icon: "archive-restore",
        run: () => void this.run("sync.snapshot.restore", { id: row.id }),
      },
      {
        label: "Show files…",
        icon: "files",
        run: () => void this.run("sync.snapshot.restoreFile", { id: row.id }),
      },
      {
        label: pinned ? "Unpin" : "Pin…",
        icon: pinned ? "pin-off" : "pin",
        run: () => void togglePin(),
      },
      {
        label: "Delete…",
        icon: "trash-2",
        destructive: true,
        separatorBefore: true,
        run: () => void this.run("sync.snapshot.delete", { id: row.id }),
      },
    ];
    this.drawn.add(
      on(more, "click", () => {
        this.menu.value = showMenu(more, items, "Snapshot");
      }),
    );
    const detail = [
      summary.branch,
      countOf(summary.files, "file"),
      formatSize(summary.bytes),
    ].filter((part): part is string => !!part);
    return h(
      "div",
      { class: "sync-row", "data-snapshot": row.id },
      h(
        "div",
        { class: "sync-row-main" },
        h(
          "div",
          { class: "sync-row-title" },
          h("span", { class: "sync-row-name" }, this.when(summary.time)),
          h("span", { class: "sync-row-from" }, summary.deviceName),
          pinned ? h("span", { class: "ai-tag sync-pin-name" }, pinned) : null,
        ),
        h("div", { class: "sync-row-detail" }, detail.join(" · ")),
      ),
      h("div", { class: "sync-row-actions" }, pin, more),
    );
  }

  // ------------------------------------------------------------ the dock's side

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
    create: () => new SyncView(services, controller, session),
  };
}
