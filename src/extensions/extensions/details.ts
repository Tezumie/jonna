// An extension's page (dock tab "extension", like VS Code's extension editor): header with its
// avatar, name, author, badges and actions, then tabs — Details (its README, drawn like the
// Markdown preview, beside a side panel of facts and links), Features (what it adds), Settings
// (live controls), Files (browse and preview its files), Changelog, Permissions and Log (D176).

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import type { StoreDetails } from "../../core/extensions/openVsx";
import { extIpc } from "../../core/ipc/extensions";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showMenu } from "../../ui/Menu";
import { markdownNodes } from "../../ui/markdown/render";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { fromStore } from "./actions";
import { authorsLine } from "./authorsView";
import {
  FilesPane,
  features,
  ImageUrls,
  markdownOptions,
  permissions,
  settingsTab,
  sidePanel,
} from "./detailsTabs";
import { ExtensionPack } from "./extensionPack";
import type { ExtensionManager, ExtensionRecord } from "./manager";
import { screenshotGallery } from "./media";
import { actionsMenu, avatar, badges, publisherLink, storeStats, verifiedMark } from "./parts";
import { isVerified, pendingUpdate, storeDetailsOf } from "./store";

type Tab = "details" | "features" | "settings" | "files" | "changelog" | "permissions" | "log";
const TABS: [Tab, string][] = [
  ["details", "Details"],
  ["features", "Features"],
  ["settings", "Settings"],
  ["files", "Files"],
  ["changelog", "Changelog"],
  ["permissions", "Permissions"],
  ["log", "Log"],
];
const CHANGELOG = "CHANGELOG.md";

export function extensionPageDescriptor(
  services: WorkbenchServices,
  manager: ExtensionManager,
): DockViewDescriptor {
  const idOf = (state: Json) => String(stateField(state, "id") ?? "");
  return {
    type: "extension",
    title: (state) => {
      const r = manager.get(idOf(state));
      return r?.manifest?.displayName ?? idOf(state);
    },
    icon: () => "blocks",
    tooltip: (state) => `Extension: ${idOf(state)}`,
    defaultPlacement: "main",
    create: (state) => new ExtensionPage(idOf(state), services, manager),
  };
}

class ExtensionPage implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tab = signal<Tab>("details");
  private readonly header: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  /** README and changelog texts, per folder and change time. */
  private readonly texts = new Map<string, string | null>();
  private readonly images = new ImageUrls();
  /** What the current tab rendered (settings rows, the files pane). */
  private readonly tabStore = new DisposableStore();
  private files: FilesPane | null = null;
  private hasChangelog: { key: string; yes: boolean } | null = null;
  /** What the page last drew (see the effect). */
  private shownKey = "";
  /**
   * Its page on Open VSX, for one installed from there (D284: the publisher's mark, downloads and
   * rating in the header, as VS Code's); undefined until fetched, null when it isn't there.
   */
  private readonly storeInfo = signal<StoreDetails | null | undefined>(undefined);

  constructor(
    private readonly id: string,
    private readonly services: WorkbenchServices,
    private readonly manager: ExtensionManager,
  ) {
    this.header = h("div", { class: "ext-page-header" });
    this.tabs = h("div", { class: "ext-page-tabs", role: "tablist" });
    this.body = h("div", { class: "ext-page-body" });
    this.store.add(this.tabStore);
    this.store.add(this.images);
    this.element = h(
      "div",
      { class: "ext-page", tabindex: "-1" },
      h("div", { class: "ext-page-inner" }, this.header, this.tabs, this.body),
    );
    this.store.add(
      on(this.element, "click", (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const tab = target?.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
        if (tab) {
          this.tab.value = tab;
          return;
        }
        const more = target?.closest<HTMLElement>(".ext-page-more");
        const record = this.manager.get(this.id);
        if (more && record) {
          showMenu(
            more,
            actionsMenu(this.services, record, { details: false, manager: this.manager }),
            "Extension actions",
          );
          return;
        }
        // A split button's ▾ (D258: Disable ▾, Uninstall ▾ as in VS Code).
        const split = target?.closest<HTMLElement>("[data-ext-split]");
        if (split && record) {
          showMenu(split, this.splitMenu(split.dataset.extSplit ?? "", record), "More");
          return;
        }
        const opener = target?.closest<HTMLElement>(".ext-open");
        if (opener) {
          this.openTool(opener);
          return;
        }
        const command = target?.closest<HTMLElement>("[data-ext-command]")?.dataset.extCommand;
        if (command)
          void this.services.dispatcher.execute(command, { id: this.id }).catch(() => {});
      }),
    );
    this.store.add(
      effect(() => {
        const r = this.manager.records.value.find((x) => x.id === this.id);
        const tab = this.tab.value;
        // The list is replaced on every poll (development extensions, every 1.5 s): redraw only
        // when something shown changed, or typing in the Settings tab loses focus.
        const key = JSON.stringify([
          tab,
          r?.root,
          r?.mtimeMs,
          r?.status,
          r?.error,
          r?.warnings,
          r ? this.manager.granted(r.id) : null,
          r ? this.manager.isRunning(r.id) : null,
          // Its views and tools register when it starts: the Open button follows.
          this.services.extensionFeatures.openers.value.length,
          this.services.extensionFeatures.menus.value.length,
          // A newer version on Open VSX, and its install (D284).
          pendingUpdate(this.id),
          this.storeInfo.value?.version,
          isVerified(this.id),
        ]);
        if (key === this.shownKey) return undefined;
        this.shownKey = key;
        this.render(r, tab);
        return undefined;
      }),
    );
    // Its Open VSX page, once it's known to come from there (D284).
    let asked = false;
    this.store.add(
      effect(() => {
        const r = this.manager.records.value.find((x) => x.id === this.id);
        if (asked || !r || !fromStore(r)) return undefined;
        if (this.services.settings.peek<boolean>("extensions.store.enabled") === false)
          return undefined;
        asked = true;
        void storeDetailsOf(this.id).then(
          (d) => (this.storeInfo.value = d),
          () => (this.storeInfo.value = null),
        );
        return undefined;
      }),
    );
  }

  /**
   * Who published it. One from Open VSX: its publisher, as VS Code's page shows it, a link that
   * searches for the publisher's extensions, with the verified mark (D284). Else its authors when
   * it lists them (D185), else its publisher.
   */
  private publisher(r: ExtensionRecord): HTMLElement[] {
    const m = r.manifest;
    if (!fromStore(r) && m?.authors.length) return [authorsLine(m.authors)];
    const name = this.storeInfo.peek()?.publisher || m?.publisher || r.id.split(".")[0] || r.id;
    return [
      publisherLink(this.services, name, fromStore(r) && isVerified(r.id) ? verifiedMark() : null),
    ];
  }

  private openers(id: string) {
    return this.services.extensionFeatures.allOpeners(
      (when) => this.services.context.matches(when),
      id,
    );
  }

  /** A split button's other choices (D258). */
  private splitMenu(which: string, r: ExtensionRecord): MenuItem[] {
    const run =
      (command: string, input: unknown = { id: r.id }) =>
      () =>
        void this.services.dispatcher.execute(command, input).catch(() => {});
    if (which === "disable")
      return [
        { label: "Disable", run: run("extensions.disable") },
        { label: "Disable (workspace)", run: run("extensions.disableWorkspace") },
      ];
    return [
      {
        label: r.dev ? "Uninstall (delete folder)…" : "Uninstall…",
        run: run("extensions.uninstall"),
      },
      { label: "Install specific version…", run: run("extensions.installSpecificVersion") },
    ];
  }

  /** The Open button: its one tool, or a menu of them. */
  private openTool(anchor: HTMLElement): void {
    const openers = this.openers(this.id);
    const run = (o: (typeof openers)[number]) =>
      void this.services.dispatcher.execute(o.command, o.input ?? {}).catch(() => {});
    if (openers.length === 1 && openers[0]) run(openers[0]);
    else if (openers.length)
      showMenu(
        anchor,
        openers.map((o) => ({
          label: o.title,
          icon: (o.icon ?? "box") as IconName,
          run: () => run(o),
        })),
        "Open",
      );
  }

  private render(r: ExtensionRecord | undefined, tab: Tab): void {
    if (!r) {
      replaceChildren(this.header);
      replaceChildren(this.tabs);
      replaceChildren(
        this.body,
        h("div", { class: "empty-state-text" }, `The extension ${this.id} isn't installed.`),
      );
      return;
    }
    const m = r.manifest;
    const action = (label: string, command: string, cls = "button-secondary") =>
      h(
        "button",
        { class: `button ${cls} button-sm`, type: "button", "data-ext-command": command },
        label,
      );
    const buttons: HTMLElement[] = [];
    // A newer version on Open VSX comes first, as VS Code's "Update to x.y.z" (D284).
    const pending = pendingUpdate(r.id);
    if (pending?.installing)
      buttons.push(
        h(
          "button",
          { class: "button button-accent button-sm", type: "button", disabled: true },
          "Updating…",
        ),
      );
    else if (pending)
      buttons.push(
        action(`Update to ${pending.latest}`, "extensions.updateFromStore", "button-accent"),
      );
    // Open (D181): what it can open (its sidebar view, pages, a tool's command). One opens
    // directly; several give a menu. Secondary while an update takes the accent.
    const openers = this.openers(r.id);
    if (openers.length) {
      const only = openers.length === 1 ? openers[0] : undefined;
      buttons.push(
        h(
          "button",
          {
            class: `button ${pending ? "button-secondary" : "button-accent"} button-sm ext-open`,
            type: "button",
          },
          only ? `Open ${only.title}` : "Open",
          only ? null : icon("chevron-down"),
        ),
      );
    }
    // What it brings to use right away (VS Code's Set Color Theme, D258).
    if (r.status === "active" && m?.contributes.themes.length)
      buttons.push(action("Set color theme", "extensions.setColorTheme"));
    if (r.status === "active" && m?.contributes.iconThemes.length)
      buttons.push(action("Set file icon theme", "extensions.setFileIconTheme"));
    if (r.status === "needsPermission")
      buttons.push(action("Allow…", "extensions.grantPermissions", "button-accent"));
    // Code waiting for permission (D256): allowing it runs it.
    if (r.codeWaiting)
      buttons.push(action("Allow its code…", "extensions.grantPermissions", "button-accent"));
    const folder = !!this.services.workspace.root.peek();
    if (this.manager.disabledHere(r.id))
      buttons.push(action("Enable (workspace)", "extensions.enableWorkspace", "button-accent"));
    else if (r.status === "disabled")
      buttons.push(action("Enable", "extensions.enable", "button-accent"));
    else if (r.status !== "invalid")
      buttons.push(splitAction(action("Disable", "extensions.disable"), "disable", folder));
    // A development extension (unpacked, or in this folder's extensions): make it permanent.
    if (r.dev && m)
      buttons.push(
        action(
          r.replaces ? "Update installed version…" : "Install permanently",
          "extensions.installPermanently",
        ),
      );
    if (r.customized) buttons.push(action("Use the IDE's version…", "extensions.revertToBundled"));
    if (m && this.services.dispatcher.has("agent.compose"))
      buttons.push(action("Edit with agent…", "extensions.editWithAgent"));
    buttons.push(
      splitAction(
        action(r.dev ? "Uninstall (delete folder)…" : "Uninstall…", "extensions.uninstall"),
        "uninstall",
        fromStore(r),
      ),
    );
    // Auto update for one from Open VSX (D258, VS Code's checkbox beside the buttons).
    if (fromStore(r)) {
      const box = h("input", {
        type: "checkbox",
        class: "checkbox",
        "data-ext-command": "extensions.setAutoUpdate",
        checked: this.manager.autoUpdates(r.id),
      });
      box.checked = this.manager.autoUpdates(r.id);
      buttons.push(h("label", { class: "ext-page-check" }, box, "Auto update"));
    }
    /** A button with a ▾ beside it for its other choices (only when there are some). */
    function splitAction(button: HTMLElement, menu: string, hasMore: boolean): HTMLElement {
      if (!hasMore) return button;
      const chevron = h(
        "button",
        {
          class: "button button-secondary button-sm ext-split-more",
          type: "button",
          "data-ext-split": menu,
          "aria-label": "More choices",
        },
        icon("chevron-down"),
      );
      return h("span", { class: "ext-split" }, button, chevron);
    }
    const more = h(
      "button",
      { class: "icon-button ext-page-more", type: "button", "aria-label": "More actions" },
      icon("ellipsis"),
    );
    setTooltip(more, "More actions");
    replaceChildren(
      this.header,
      avatar(r, "lg"),
      h(
        "div",
        { class: "ext-page-title" },
        h(
          "div",
          { class: "ext-page-name-line" },
          h("h1", { class: "ext-page-name" }, m?.displayName ?? r.id),
          h("span", { class: "ext-version" }, m?.version ? `v${m.version}` : ""),
        ),
        h(
          "div",
          { class: "ext-page-meta" },
          ...this.publisher(r),
          h("span", { class: "ext-page-id" }, r.id),
          ...(this.storeInfo.peek()
            ? storeStats(this.services, this.storeInfo.peek() as StoreDetails)
            : []),
          ...badges(r, false),
        ),
        h("p", { class: "ext-page-desc" }, m?.description ?? ""),
        r.error ? h("p", { class: "ext-error" }, r.error) : null,
        h("div", { class: "ext-page-actions" }, ...buttons, more),
      ),
    );
    const shown = TABS.filter(([key]) => this.tabShown(r, key));
    if (!shown.some(([key]) => key === tab)) {
      queueMicrotask(() => {
        this.tab.value = "details";
      });
      return;
    }
    replaceChildren(
      this.tabs,
      ...shown.map(([key, label]) =>
        h(
          "button",
          {
            class: { "ext-page-tab": true, "is-active": key === tab },
            type: "button",
            role: "tab",
            "aria-selected": String(key === tab),
            "data-tab": key,
          },
          label,
        ),
      ),
    );
    if (tab !== "files") {
      this.files = null;
      this.tabStore.clear();
    }
    if (tab === "details") this.renderDetails(r);
    else if (tab === "features") replaceChildren(this.body, ...features(this.services, r.manifest));
    else if (tab === "settings")
      replaceChildren(this.body, ...settingsTab(this.services, r, this.tabStore));
    else if (tab === "files") {
      if (this.files) this.files.update(r);
      else {
        this.tabStore.clear();
        this.files = this.tabStore.add(new FilesPane(this.services, r, this.images));
        replaceChildren(this.body, this.files.element);
      }
    } else if (tab === "changelog") this.renderText(r, CHANGELOG, "It has no changelog.");
    else if (tab === "permissions") replaceChildren(this.body, ...permissions(this.manager, r));
    else
      replaceChildren(
        this.body,
        h(
          "pre",
          { class: "ext-page-log" },
          this.manager
            .logOf(r.id)
            .map((l) => `${new Date(l.time).toLocaleTimeString()} [${l.level}] ${l.text}`)
            .join("\n") || "Nothing logged yet.",
        ),
      );
  }

  /** Settings only when it has some; Changelog only when the file is there. */
  private tabShown(r: ExtensionRecord, tab: Tab): boolean {
    if (tab === "settings") return Object.keys(r.manifest?.contributes.settings ?? {}).length > 0;
    if (tab === "changelog") {
      const key = `${r.root}\0${r.mtimeMs}`;
      if (this.hasChangelog?.key !== key) {
        // Keep the last answer while checking again (an edit mustn't bounce the reader away).
        const before = this.hasChangelog?.yes ?? false;
        this.hasChangelog = { key, yes: before };
        void extIpc
          .files(r.root)
          .then((files) => files.some((f) => f.path === CHANGELOG))
          .catch(() => false)
          .then((yes) => {
            if (this.store.isDisposed || this.hasChangelog?.key !== key) return;
            this.hasChangelog = { key, yes };
            if (yes === before) return;
            const now = this.manager.get(this.id);
            if (now) this.render(now, this.tab.peek());
          });
      }
      return this.hasChangelog.yes;
    }
    return true;
  }

  /** The README beside the side panel (facts, categories, links, marketplace). */
  private renderDetails(r: ExtensionRecord): void {
    const readme = h("div", { class: "ext-page-readme md md-document" });
    const shots = screenshotGallery(this.services, r, this.images);
    const main = h("div", { class: "ext-page-main" });
    // A pack lists its members first, as VS Code's page does (tabStore is cleared per render).
    const pack = this.storeInfo.peek()?.pack ?? [];
    if (pack.length) this.tabStore.add(new ExtensionPack(main, this.services, this.manager, pack));
    if (shots) main.append(shots);
    main.append(readme);
    replaceChildren(
      this.body,
      h("div", { class: "ext-page-details" }, main, sidePanel(this.services, this.manager, r)),
    );
    this.fillText(readme, r, "README.md", "This extension has no README.");
  }

  private renderText(r: ExtensionRecord, file: string, empty: string): void {
    const host = h("div", { class: "ext-page-readme md md-document" });
    replaceChildren(this.body, host);
    this.fillText(host, r, file, empty);
  }

  /** A Markdown file of the extension, drawn like the Markdown preview (cached per change). */
  private fillText(host: HTMLElement, r: ExtensionRecord, file: string, empty: string): void {
    const show = (text: string | null) =>
      text
        ? host.replaceChildren(
            ...markdownNodes(text, markdownOptions(this.services, r, this.images)),
          )
        : host.replaceChildren(h("p", { class: "ext-page-muted" }, empty));
    const key = `${r.root}\0${r.mtimeMs}\0${file}`;
    if (this.texts.has(key)) {
      show(this.texts.get(key) ?? null);
      return;
    }
    void extIpc
      .readText(r.root, file)
      .catch(() => null)
      .then((text) => {
        if (this.store.isDisposed) return;
        if (this.texts.size > 20) this.texts.clear();
        this.texts.set(key, text);
        if (this.body.contains(host)) show(text);
      });
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return { id: this.id };
  }

  dispose(): void {
    this.store.dispose();
  }
}
