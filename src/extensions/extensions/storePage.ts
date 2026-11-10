// An Open VSX extension's page (dock tab "extension-store", like VS Code's extension editor for
// a marketplace extension): header with its icon, name, publisher, downloads, rating and
// Install / Update / Installed; tabs Details (its README beside a side panel of facts and
// links), Features (what its package.json adds, read like an installed one's) and Changelog.
// Everything comes from Open VSX through the backend (storeMedia.ts): texts and pictures from
// its hosts only, size-capped; other images in the README through the Markdown preview's
// remote images. Every action runs a command.

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { readmeLink, type StoreDetails, storePageUrl } from "../../core/extensions/openVsx";
import { parseManifest, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { localizePackage } from "../../core/extensions/vscodePackage";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { showMenu } from "../../ui/Menu";
import { markdownNodes } from "../../ui/markdown/render";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { features, formatSize, markdownBase, webLink } from "./detailsTabs";
import { ExtensionPack } from "./extensionPack";
import type { ExtensionManager } from "./manager";
import { filterChip, installMore, publisherLink, storeStats, verifiedMark } from "./parts";
import { storeDetailsOf, storeInstalling, storeUpdates } from "./store";
import { readmeImage, storeAvatar, storeText } from "./storeMedia";

type Tab = "details" | "features" | "changelog";

/** Display names of pages opened this session, for their tabs' titles before they load. */
const titles = new Map<string, string>();

export function storePageDescriptor(
  services: WorkbenchServices,
  manager: ExtensionManager,
): DockViewDescriptor {
  const idOf = (state: Json) => String(stateField(state, "id") ?? "");
  return {
    type: "extension-store",
    title: (state) => titles.get(idOf(state).toLowerCase()) ?? idOf(state),
    icon: () => "blocks",
    tooltip: (state) => `Extension: ${idOf(state)} (Open VSX)`,
    defaultPlacement: "main",
    create: (state) => new StorePage(idOf(state), services, manager),
  };
}

const exec = (services: WorkbenchServices, command: string, input: unknown) =>
  void services.dispatcher.execute(command, input).catch((err: unknown) => {
    services.notifications.show("error", err instanceof Error ? err.message : String(err));
  });

class StorePage implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly tab = signal<Tab>("details");
  /** Undefined while loading; null when Open VSX doesn't have it. */
  private readonly details = signal<StoreDetails | null | undefined>(undefined);
  /** A pack's members above the README (Details tab). */
  private readonly pack = this.store.add(new MutableDisposable<ExtensionPack>());
  private error: string | null = null;
  /** Its package.json read like an installed extension's manifest (for Features). */
  private manifest: Promise<ThirdPartyManifest> | null = null;
  private readonly header: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private headerKey = "";
  private bodyKey = "";

  constructor(
    private readonly id: string,
    private readonly services: WorkbenchServices,
    private readonly manager: ExtensionManager,
  ) {
    this.header = h("div", { class: "ext-page-header" });
    this.tabs = h("div", { class: "ext-page-tabs", role: "tablist" });
    this.body = h("div", { class: "ext-page-body" });
    this.element = h(
      "div",
      { class: "ext-page", tabindex: "-1" },
      h("div", { class: "ext-page-inner" }, this.header, this.tabs, this.body),
    );
    this.store.add(on(this.element, "click", (e) => this.onClick(e)));
    this.load();
    this.store.add(
      effect(() => {
        const d = this.details.value;
        const tab = this.tab.value;
        const installed = this.manager.records.value.find((r) => r.id === this.id.toLowerCase());
        const key = JSON.stringify([
          d?.version ?? d,
          this.error,
          installed?.manifest?.version ?? null,
          storeInstalling.value.has(this.id.toLowerCase()),
          storeUpdates.value.find((u) => u.id === this.id.toLowerCase())?.latest ?? null,
        ]);
        // The records are replaced on every poll: redraw only what changed (the README keeps
        // its scroll position).
        if (key !== this.headerKey) {
          this.headerKey = key;
          this.renderHeader(d, installed?.manifest?.version);
        }
        const bodyKey = JSON.stringify([
          tab,
          d?.version ?? d,
          this.error,
          installed?.manifest?.version ?? null,
        ]);
        if (bodyKey !== this.bodyKey) {
          this.bodyKey = bodyKey;
          this.renderBody(d, tab);
        }
        return undefined;
      }),
    );
  }

  private load(): void {
    this.details.value = undefined;
    this.error = null;
    void storeDetailsOf(this.id).then(
      (d) => {
        if (this.store.isDisposed) return;
        if (d) titles.set(this.id.toLowerCase(), d.displayName);
        this.details.value = d;
        this.changed.fire();
      },
      (err: unknown) => {
        if (this.store.isDisposed) return;
        this.error = err instanceof Error ? err.message : String(err);
        this.details.value = null;
        this.changed.fire();
      },
    );
  }

  private onClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    const tab = target?.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
    if (tab) {
      this.tab.value = tab;
      return;
    }
    if (target?.closest(".ext-store-retry")) {
      this.headerKey = "";
      this.bodyKey = "";
      this.load();
      return;
    }
    const more = target?.closest<HTMLElement>(".ext-page-more");
    const d = this.details.peek();
    if (more && d) {
      showMenu(
        more,
        [
          {
            label: "Open on Open VSX",
            icon: "external-link",
            run: () => exec(this.services, "ui.openLink", { url: storePageUrl(d) }),
          },
          {
            label: "Copy extension ID",
            icon: "copy",
            run: () => void clipboardIpc.writeText(d.id).catch(() => {}),
          },
          {
            label: "Copy link",
            icon: "link",
            run: () => void clipboardIpc.writeText(storePageUrl(d)).catch(() => {}),
          },
        ],
        "Extension actions",
      );
      return;
    }
    const command = target?.closest<HTMLElement>("[data-ext-command]")?.dataset.extCommand;
    // Installed ids are lowercase; Open VSX finds either.
    if (command) exec(this.services, command, { id: this.id.toLowerCase() });
  }

  private renderHeader(d: StoreDetails | null | undefined, installed: string | undefined): void {
    if (!d) {
      replaceChildren(this.header);
      return;
    }
    const button = (label: string, command: string, cls = "button-secondary") =>
      h(
        "button",
        { class: `button ${cls} button-sm`, type: "button", "data-ext-command": command },
        label,
      );
    const key = this.id.toLowerCase();
    const update = storeUpdates.peek().find((u) => u.id === key);
    const buttons: HTMLElement[] = [];
    if (storeInstalling.peek().has(key))
      buttons.push(
        h(
          "button",
          { class: "button button-accent button-sm", type: "button", disabled: true },
          installed ? "Updating…" : "Installing…",
        ),
      );
    else if (!installed)
      buttons.push(
        h(
          "span",
          { class: "ext-split" },
          button("Install", "extensions.installFromStore", "button-accent"),
          installMore(this.services, this.id, "button-accent"),
        ),
      );
    else if (update)
      buttons.push(
        button(`Update to ${update.latest}`, "extensions.installFromStore", "button-accent"),
      );
    if (installed) {
      buttons.push(button("Manage", "extensions.showDetails"));
    }
    const more = h(
      "button",
      { class: "icon-button ext-page-more", type: "button", "aria-label": "More actions" },
      icon("ellipsis"),
    );
    setTooltip(more, "More actions");
    const verified = d.verified ? verifiedMark() : null;
    replaceChildren(
      this.header,
      storeAvatar(d, "lg"),
      h(
        "div",
        { class: "ext-page-title" },
        h(
          "div",
          { class: "ext-page-name-line" },
          h("h1", { class: "ext-page-name" }, d.displayName),
          h("span", { class: "ext-version" }, `v${d.version}`),
          d.preRelease ? h("span", { class: "ext-badge" }, "Pre-release") : null,
          d.deprecated ? h("span", { class: "ext-badge is-warning" }, "Deprecated") : null,
        ),
        h(
          "div",
          { class: "ext-page-meta" },
          publisherLink(this.services, d.publisher, verified),
          h("span", { class: "ext-page-id" }, d.id),
          ...storeStats(this.services, d),
        ),
        h("p", { class: "ext-page-desc" }, d.description),
        installed
          ? h(
              "p",
              { class: "ext-page-muted" },
              update
                ? `Version ${installed} is installed; ${update.latest} is the latest.`
                : `Installed (version ${installed}).`,
            )
          : null,
        h("div", { class: "ext-page-actions" }, ...buttons, more),
      ),
    );
  }

  private renderBody(d: StoreDetails | null | undefined, tab: Tab): void {
    this.pack.clear();
    if (d === undefined) {
      replaceChildren(this.tabs);
      replaceChildren(this.body, h("p", { class: "ext-page-muted" }, "Loading from Open VSX…"));
      return;
    }
    if (!d) {
      replaceChildren(this.tabs);
      replaceChildren(
        this.body,
        h(
          "div",
          { class: "ext-store-missing" },
          h(
            "p",
            { class: "ext-page-muted" },
            this.error
              ? `Open VSX couldn't be reached: ${this.error}`
              : `Open VSX has no extension ${this.id}.`,
          ),
          this.error
            ? h(
                "button",
                { class: "button button-secondary button-sm ext-store-retry", type: "button" },
                "Try again",
              )
            : null,
        ),
      );
      return;
    }
    const shown: [Tab, string][] = [
      ["details", "Details"],
      ["features", "Features"],
      ...(d.files.changelog ? [["changelog", "Changelog"] as [Tab, string]] : []),
    ];
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
    if (tab === "features") this.renderFeatures(d);
    else if (tab === "changelog" && d.files.changelog) {
      const host = h("div", { class: "ext-page-readme md md-document" });
      replaceChildren(this.body, host);
      this.fillMarkdown(host, d.files.changelog, "It has no changelog.");
    } else {
      const readme = h("div", { class: "ext-page-readme md md-document" });
      const main = h("div", { class: "ext-page-main" });
      // A pack lists its members first, as VS Code's page does.
      if (d.pack.length)
        this.pack.value = new ExtensionPack(main, this.services, this.manager, d.pack);
      main.append(readme);
      replaceChildren(
        this.body,
        h(
          "div",
          { class: "ext-page-details" },
          main,
          storeSide(this.services, d, this.manager.get(d.id)?.manifest?.version),
        ),
      );
      if (d.files.readme) this.fillMarkdown(readme, d.files.readme, "It has no README.");
      else readme.replaceChildren(h("p", { class: "ext-page-muted" }, "It has no README."));
    }
  }

  /** A Markdown file from Open VSX, its links and images resolved against its address. */
  private fillMarkdown(host: HTMLElement, url: string, empty: string): void {
    host.replaceChildren(h("p", { class: "ext-page-muted" }, "Loading…"));
    void storeText(url).then(
      (text) => {
        if (this.store.isDisposed || !this.body.contains(host)) return;
        if (!text.trim()) {
          host.replaceChildren(h("p", { class: "ext-page-muted" }, empty));
          return;
        }
        host.replaceChildren(
          ...markdownNodes(text, {
            ...markdownBase(this.services, (href) => readmeLink(href, url)),
            image: (src) => readmeImage(this.services, src, url),
          }),
        );
      },
      (err: unknown) => {
        if (this.store.isDisposed || !this.body.contains(host)) return;
        host.replaceChildren(
          h(
            "p",
            { class: "ext-page-muted" },
            `Couldn't load it: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  }

  /** Features: its package.json (localized when it has package.nls.json), read as installed. */
  private renderFeatures(d: StoreDetails): void {
    const url = d.files.manifest;
    if (!url) {
      replaceChildren(
        this.body,
        h("p", { class: "ext-page-muted" }, "Open VSX has no package.json for it."),
      );
      return;
    }
    replaceChildren(this.body, h("p", { class: "ext-page-muted" }, "Reading its package.json…"));
    this.manifest ??= (async () => {
      const value: unknown = JSON.parse(await storeText(url));
      const nlsUrl = url.replace(/package\.json$/i, "package.nls.json");
      const nls =
        nlsUrl !== url
          ? await storeText(nlsUrl)
              .then((t) => JSON.parse(t) as unknown)
              .catch(() => null)
          : null;
      return parseManifest(localizePackage(value, nls), "package.json");
    })();
    const shown = this.bodyKey;
    this.manifest.then(
      (m) => {
        if (this.store.isDisposed || this.bodyKey !== shown) return;
        replaceChildren(this.body, ...features(this.services, m));
      },
      (err: unknown) => {
        // Not cached: a network failure is tried again next time.
        this.manifest = null;
        if (this.store.isDisposed || this.bodyKey !== shown) return;
        replaceChildren(
          this.body,
          h(
            "p",
            { class: "ext-page-muted" },
            `Its package.json couldn't be read: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  }

  title(): string {
    return this.details.peek()?.displayName ?? this.id;
  }

  busy(): boolean {
    return this.details.peek() === undefined;
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

/** The README's side panel: VS Code's Marketplace facts, categories and links. */
function storeSide(
  services: WorkbenchServices,
  d: StoreDetails,
  installed: string | undefined,
): HTMLElement {
  const section = (title: string, ...children: (Node | null)[]) =>
    h("section", { class: "ext-side-section" }, h("h3", null, title), ...children);
  const fact = (label: string, value: Node | string) =>
    h(
      "div",
      { class: "ext-side-fact" },
      h("span", { class: "ext-side-label" }, label),
      h("span", { class: "ext-side-value" }, value),
    );
  // Each chip searches for its category or tag (D284, VS Code's).
  const chips = (key: "@category" | "@tag", list: readonly string[]) =>
    h("div", { class: "ext-side-chips" }, ...list.map((c) => filterChip(services, key, c)));
  const released = d.released ? new Date(d.released) : null;
  const links = [
    webLink(services, "Open VSX", storePageUrl(d)),
    d.repository ? webLink(services, "Repository", d.repository) : null,
    d.homepage && d.homepage !== d.repository ? webLink(services, "Homepage", d.homepage) : null,
    d.bugs ? webLink(services, "Issues", d.bugs) : null,
    d.files.license
      ? webLink(services, d.license ? `License (${d.license})` : "License", d.files.license)
      : null,
  ].filter((x): x is HTMLAnchorElement => !!x);
  return h(
    "aside",
    { class: "ext-side" },
    section(
      "Marketplace",
      fact("Identifier", h("code", null, d.id)),
      fact("Version", d.version),
      installed ? fact("Installed", installed) : null,
      released ? fact("Last released", released.toLocaleDateString()) : null,
      d.size !== undefined ? fact("Size", formatSize(d.size)) : null,
      d.engine ? fact("VS Code", d.engine) : null,
      d.license ? fact("License", d.license) : null,
      fact("Published by", d.publisher),
    ),
    d.categories.length || d.tags.length
      ? section(
          "Categories",
          d.categories.length ? chips("@category", d.categories) : null,
          d.tags.length ? chips("@tag", d.tags.slice(0, 16)) : null,
        )
      : null,
    section("Resources", ...links),
  );
}
