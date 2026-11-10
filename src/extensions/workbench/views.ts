// Dock views owned by the workbench: "welcome" (shown when no editor is open, so the main region
// never disappears). The agent view belongs to the agent extension.
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { dirname, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { logo } from "../../ui/Logo";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { locationLabel } from "../../workbench/workspace";

interface Entry {
  label: string;
  command: string;
  icon: IconName;
  when?: () => boolean;
}

export function welcomeViewDescriptor(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: "welcome",
    title: () => "Welcome",
    icon: () => "layout-dashboard",
    iconElement: () => logo(16, "icon logo-icon"),
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: () => new WelcomeView(services),
  };
}

/**
 * DESIGN.md §12.17, reworked in D121 after VS Code's "Start" list and Cursor's cards: the logo,
 * four start cards (open folder, clone, new file, open file), a line of smaller actions, and
 * recent folders (name and path; × on hover forgets one; "View all" lists them all).
 */
class WelcomeView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly renderStore = this.store.add(new DisposableStore());

  constructor(private readonly services: WorkbenchServices) {
    const cards = h("div", { class: "welcome-cards" });
    const recentList = h("div", { class: "welcome-recent-list" });
    const viewAll = h("button", { class: "welcome-view-all", type: "button" });
    const recent = h(
      "div",
      { class: "welcome-recent" },
      h("div", { class: "welcome-heading" }, h("span", null, "Recent projects"), viewAll),
      recentList,
    );
    this.store.add(on(viewAll, "click", () => this.run("workspace.openRecent")));
    // Moving from VS Code (D193): its settings, shortcuts, snippets and MCP servers in one step.
    const importOpen = h(
      "button",
      { class: "welcome-import-open", type: "button" },
      icon("download"),
      "Coming from VS Code? Import your setup",
    );
    // Dismissed for good with its ×, like a recent folder's (D194); Help → Import from VS Code
    // stays.
    const importHide = h(
      "button",
      { class: "icon-button welcome-import-hide", type: "button", "aria-label": "Hide" },
      icon("x"),
    );
    setTooltip(importHide, "Hide (Help → Import from VS Code… still has it)");
    const importLink = h("div", { class: "welcome-import" }, importOpen, importHide);
    importLink.hidden = services.persistence.globalState().hideImportLink === true;
    this.store.add(on(importHide, "click", () => this.run("workbench.hideImportLink")));
    this.element = h(
      "div",
      { class: "welcome-view", tabindex: "-1" },
      h("div", { class: "welcome" }, logo(44, "welcome-logo"), cards, importLink, recent),
    );
    this.store.add(on(importOpen, "click", () => this.run("settings.showImport")));
    const cardEntries: Entry[] = [
      { label: "Open folder", command: "workspace.openFolder", icon: "folder-open" },
      { label: "Clone repository", command: "git.clone", icon: "git-branch" },
      { label: "New file", command: "workspace.newUntitledFile", icon: "file-plus" },
      { label: "Open file", command: "workspace.openFile", icon: "file" },
    ];
    const has = (e: Entry) => services.dispatcher.has(e.command) && (e.when?.() ?? true);
    const render = () => {
      this.renderStore.clear();
      cards.replaceChildren(
        ...cardEntries.filter(has).map((entry) => {
          const key = services.keyboard.labelFor(entry.command);
          const card = h(
            "button",
            { class: "welcome-card", type: "button" },
            icon(entry.icon),
            h("span", { class: "welcome-card-label" }, entry.label),
            key ? h("kbd", null, key) : null,
          );
          // While its command runs (a folder dialog, a clone), the card says so (D169).
          this.renderStore.add(
            on(card, "click", () => {
              card.classList.add("is-busy");
              void this.services.dispatcher
                .execute(entry.command)
                .catch(() => {})
                .finally(() => card.classList.remove("is-busy"));
            }),
          );
          return card;
        }),
      );
      // Not the folders open in this window (VS Code's Start list leaves them out too, D254).
      const open = services.workspace.folders.peek().map((f) => f.path);
      const all = services.workspace
        .recentOrdered()
        .filter((p) => !open.some((o) => samePath(o, p)));
      const pinnedNow = services.workspace.pinned.peek();
      const folders = all.slice(0, 6);
      recent.hidden = folders.length === 0;
      viewAll.textContent = `View all (${all.length})`;
      viewAll.hidden = all.length <= folders.length;
      recentList.replaceChildren(
        ...folders.map((path) => {
          const open = h(
            "button",
            { class: "welcome-recent-open", type: "button" },
            h("span", { class: "welcome-recent-name" }, locationLabel(path)),
            h("span", { class: "welcome-recent-path" }, dirname(path)),
          );
          const remove = h(
            "button",
            {
              class: "icon-button welcome-recent-remove",
              type: "button",
              "aria-label": `Remove ${locationLabel(path)} from recent`,
            },
            icon("x"),
          );
          // Pinned folders stay at the top and are never dropped from the list (D192).
          const isPinned = pinnedNow.some((p) => samePath(p, path));
          const pin = h(
            "button",
            {
              class: { "icon-button": true, "welcome-recent-pin": true, "is-pinned": isPinned },
              type: "button",
              "aria-label": `${isPinned ? "Unpin" : "Pin"} ${locationLabel(path)}`,
              "aria-pressed": String(isPinned),
            },
            icon(isPinned ? "pin-off" : "pin"),
          );
          setTooltip(pin, isPinned ? "Unpin" : "Pin to the top");
          this.renderStore.add(
            on(pin, "click", () => this.run("workspace.pinRecent", { path, pinned: !isPinned })),
          );
          setTooltip(open, path);
          setTooltip(remove, "Remove from recent");
          this.renderStore.add(on(open, "click", () => this.run("workspace.openRecent", { path })));
          this.renderStore.add(
            on(remove, "click", () => this.run("workspace.removeRecent", { path })),
          );
          // The folder being opened (D169): its row shimmers until the workspace is ready.
          const opening = services.workspace.opening.peek();
          return h(
            "div",
            {
              class: {
                "welcome-recent-item": true,
                "is-opening": opening !== null && samePath(opening, path),
              },
            },
            open,
            pin,
            remove,
          );
        }),
      );
    };
    this.store.add(
      effect(() => {
        services.workspace.root.value;
        services.workspace.folders.value;
        services.workspace.recent.value;
        services.workspace.pinned.value;
        this.element.classList.toggle("is-opening", services.workspace.opening.value !== null);
        services.keyboard.rulesVersion.value;
        render();
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  focus(): void {
    // The view itself (Tab reaches the actions); no focus ring on an action nobody chose.
    this.element.focus();
  }

  serialize(): null {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
