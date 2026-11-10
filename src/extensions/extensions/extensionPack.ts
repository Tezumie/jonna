// An extension pack's members at the top of its page's Details tab (VS Code's "Extension Pack
// (N)"): a card each with its icon, name, description and publisher, and Install / Installed.
// A card opens that extension's page; its button installs it. Members load from Open VSX one by
// one (cached); one that isn't there (Pylance: Microsoft's marketplace only) says so.

import { h, on, replaceChildren } from "../../core/dom/index";
import type { StoreDetails } from "../../core/extensions/openVsx";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExtensionManager } from "./manager";
import { verifiedMark } from "./parts";
import { storeDetailsOf, storeInstalling } from "./store";
import { storeAvatar } from "./storeMedia";

export class ExtensionPack implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Each member's details: undefined while loading, null when Open VSX hasn't it. */
  private readonly members = signal<ReadonlyMap<string, StoreDetails | null>>(new Map());

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly manager: ExtensionManager,
    private readonly ids: readonly string[],
  ) {
    const grid = h("div", { class: "ext-pack-grid" });
    this.element = h(
      "section",
      { class: "ext-pack", "aria-label": "Extension pack" },
      h("h2", { class: "ext-pack-title" }, `Extension Pack (${ids.length})`),
      grid,
    );
    host.append(this.element);
    const activate = (target: Element | null) => {
      const id = target?.closest<HTMLElement>("[data-pack-id]")?.dataset.packId;
      if (!id) return;
      const install = !!target?.closest(".ext-pack-install");
      void this.services.dispatcher
        .execute(install ? "extensions.installFromStore" : "extensions.showStoreDetails", { id })
        .catch((err: unknown) => {
          if (install)
            this.services.notifications.show(
              "error",
              err instanceof Error ? err.message : String(err),
            );
        });
    };
    this.store.add(
      on(grid, "click", (e) => activate(e.target instanceof Element ? e.target : null)),
    );
    this.store.add(
      on(grid, "keydown", (e) => {
        const target = e.target instanceof Element ? e.target : null;
        // A card opens with Enter or Space, as a button; its Install button handles its own.
        if ((e.key === "Enter" || e.key === " ") && target?.matches("[data-pack-id]")) {
          e.preventDefault();
          activate(target);
        }
      }),
    );
    for (const id of ids)
      void storeDetailsOf(id).then(
        (d) => this.settle(id, d),
        () => this.settle(id, null),
      );
    // Installed / Installing… follow the manager and the store's installs. The records are
    // replaced on every poll: redraw only when a card would change (icons don't flicker).
    let shown = "";
    this.store.add(
      effect(() => {
        const installed = new Set(this.manager.records.value.map((r) => r.id.toLowerCase()));
        const installing = storeInstalling.value;
        const members = this.members.value;
        const key = JSON.stringify(
          this.ids.map((id) => {
            const k = id.toLowerCase();
            return [
              members.get(id)?.version ?? members.has(id),
              installed.has(k),
              installing.has(k),
            ];
          }),
        );
        if (key === shown) return undefined;
        shown = key;
        replaceChildren(
          grid,
          ...this.ids.map((id) => this.card(id, members.get(id), installed, installing)),
        );
        return undefined;
      }),
    );
  }

  private settle(id: string, d: StoreDetails | null): void {
    if (this.store.isDisposed) return;
    this.members.value = new Map([...this.members.peek(), [id, d]]);
  }

  private card(
    id: string,
    d: StoreDetails | null | undefined,
    installed: ReadonlySet<string>,
    installing: ReadonlySet<string>,
  ): HTMLElement {
    const key = id.toLowerCase();
    const name = d?.displayName ?? id;
    let action: HTMLElement | null = null;
    if (installed.has(key)) action = h("span", { class: "ext-pack-state" }, "Installed");
    else if (installing.has(key))
      action = h(
        "button",
        { class: "button button-accent button-sm", type: "button", disabled: true },
        "Installing…",
      );
    else if (d)
      action = h(
        "button",
        { class: "button button-accent button-sm ext-pack-install", type: "button" },
        "Install",
      );
    const card = h(
      "div",
      {
        class: "ext-pack-card",
        role: "button",
        tabindex: "0",
        "data-pack-id": id,
        "aria-label": name,
      },
      storeAvatar({ id: key, displayName: name, ...(d?.iconUrl && { iconUrl: d.iconUrl }) }),
      h(
        "div",
        { class: "ext-pack-text" },
        h("div", { class: "ext-pack-name" }, name),
        h(
          "div",
          { class: "ext-pack-desc" },
          d === undefined ? "Loading…" : d ? d.description : "Not on Open VSX",
        ),
        h(
          "div",
          { class: "ext-pack-foot" },
          h(
            "span",
            { class: "ext-pack-publisher" },
            d?.publisher ?? id.split(".")[0] ?? "",
            d?.verified ? verifiedMark() : null,
          ),
          action,
        ),
      ),
    );
    if (d?.description) setTooltip(card, d.description);
    return card;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
