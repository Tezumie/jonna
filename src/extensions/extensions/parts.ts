// Pieces the Extensions view and the extension page share: the avatar (the manifest's icon file,
// an icon of the IDE's own set by name, or the name's initials on a tinted tile), badges, the actions menu (gear / right-click) and the
// summary of what an extension adds.

import { h, on } from "../../core/dom/index";
import { filterText } from "../../core/extensions/extensionQuery";
import { formatCount } from "../../core/extensions/openVsx";
import { extIpc } from "../../core/ipc/extensions";
import { clipboardIpc } from "../../core/ipc/system";
import { type IconName, icon, knownIcon } from "../../ui/Icon";
import { type MenuItem, showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { fromStore } from "./actions";
import type { ExtensionManager, ExtensionRecord } from "./manager";
import { pendingUpdate } from "./store";

const TINTS = ["ts", "python", "style", "rust", "go", "markup", "json", "shell"];
/** Per folder + icon path: the newest version's URL (an older one is revoked when replaced). */
const iconUrls = new Map<string, { mtimeMs: number; url: Promise<string | null> }>();

const IMAGE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const imageType = (path: string): string =>
  IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";

/** The extension's icon (cached per folder and change time), or null. */
function iconUrl(r: ExtensionRecord): Promise<string | null> {
  const path = r.manifest?.icon;
  if (!path) return Promise.resolve(null);
  const key = `${r.root}\0${path}`;
  const cached = iconUrls.get(key);
  if (cached?.mtimeMs === r.mtimeMs) return cached.url;
  if (cached)
    void cached.url.then((old) => {
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
    });
  {
    const url = extIpc.read(r.root, path).then(
      (bytes) =>
        URL.createObjectURL(
          new Blob([bytes as BlobPart], {
            type: imageType(path),
          }),
        ),
      () => null,
    );
    iconUrls.set(key, { mtimeMs: r.mtimeMs, url });
    return url;
  }
}

export function avatar(r: ExtensionRecord, size: "md" | "lg" = "md"): HTMLElement {
  const name = r.manifest?.displayName ?? r.id;
  const initials =
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("") || "?";
  let hash = 0;
  for (const c of r.id) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  const tint = TINTS[Math.abs(hash) % TINTS.length] ?? "ts";
  const el = h(
    "div",
    {
      class: `ext-avatar is-${size}`,
      style: { "--ext-tint": `var(--file-icon-${tint})` },
      "aria-hidden": "true",
    },
    initials,
  );
  // "icon": "list-todo" — one of the IDE's icons, drawn in the tile's tint (D176).
  const named = r.manifest?.iconName;
  if (named && knownIcon(named, "circle-dot") === named) {
    el.classList.add("is-icon");
    el.replaceChildren(icon(knownIcon(named)));
    return el;
  }
  void iconUrl(r).then((url) => {
    if (!url) return;
    // A logo is shown as it is, without the tile: any shape looks right (VS Code's).
    el.classList.add("has-image");
    el.replaceChildren(h("img", { src: url, alt: "" }));
  });
  return el;
}

const STATUS: Record<ExtensionRecord["status"], [label: string, tone: string] | null> = {
  active: null,
  disabled: ["Disabled", "muted"],
  needsPermission: ["Needs permission", "warning"],
  failed: ["Failed", "danger"],
  invalid: ["Invalid", "danger"],
};

/** Status and kind badges; in a row, "Needs permission" is an "Allow…" button. */
/**
 * An extension's downloads and rating on Open VSX, as VS Code's page header shows them (D284):
 * the stars open its reviews on the website.
 */
export function storeStats(
  services: WorkbenchServices,
  d: { id: string; downloads?: number; rating?: number; reviewCount?: number },
): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (d.downloads !== undefined) {
    const el = h("span", { class: "ext-store-stat" }, icon("download"), formatCount(d.downloads));
    setTooltip(el, `${d.downloads.toLocaleString()} downloads on Open VSX`);
    out.push(el);
  }
  if (d.rating !== undefined) {
    const rating = d.rating;
    const reviews = d.reviewCount;
    const el = h(
      "button",
      { class: "ext-store-stars", type: "button" },
      ...[1, 2, 3, 4, 5].map((n) => {
        const star = icon("star");
        if (rating >= n - 0.25) star.classList.add("is-filled");
        return star;
      }),
      h("span", null, reviews !== undefined ? `(${reviews})` : rating.toFixed(1)),
    );
    setTooltip(
      el,
      `Rated ${rating.toFixed(1)} out of 5${reviews !== undefined ? ` by ${reviews} ${reviews === 1 ? "review" : "reviews"}` : ""}: open the reviews on Open VSX`,
    );
    on(el, "click", () =>
      services.dispatcher
        .execute("extensions.openStorePage", { id: d.id, reviews: true })
        .catch(() => {}),
    );
    out.push(el);
  }
  return out;
}

/**
 * A publisher's name that searches for its extensions (VS Code: clicking it on an extension's
 * page searches `publisher:"…"`, D284).
 */
export function publisherLink(
  services: WorkbenchServices,
  name: string,
  ...after: (HTMLElement | null)[]
): HTMLElement {
  const el = h(
    "button",
    { class: "ext-store-publisher ext-publisher-link", type: "button" },
    name,
    ...after,
  );
  setTooltip(el, `Extensions by ${name}`);
  on(el, "click", (e) => {
    // The verified mark inside keeps its own tooltip; the click still searches.
    e.stopPropagation();
    services.dispatcher
      .execute("extensions.show", { query: filterText("publisher", name) })
      .catch(() => {});
  });
  return el;
}

/** A category or tag chip that searches for it (`@category:…`, `@tag:…`, D284). */
export function filterChip(services: WorkbenchServices, key: "@category" | "@tag", value: string) {
  const el = h(
    "button",
    { class: "ext-chip ext-chip-link", type: "button" },
    key === "@tag" ? `#${value}` : value,
  );
  setTooltip(el, key === "@category" ? `Extensions in ${value}` : `Extensions tagged ${value}`);
  on(el, "click", () =>
    services.dispatcher
      .execute("extensions.show", { query: filterText(key, value) })
      .catch(() => {}),
  );
  return el;
}

/**
 * Install's ▾ (D284, VS Code's): Install specific version…. Joined to an Install button with
 * `.ext-split`; `cls` matches that button's.
 */
export function installMore(services: WorkbenchServices, id: string, cls: string): HTMLElement {
  const more = h(
    "button",
    {
      class: `button ${cls} button-sm ext-split-more`,
      type: "button",
      "aria-label": "More install choices",
    },
    icon("chevron-down"),
  );
  setTooltip(more, "More install choices");
  on(more, "click", (e) => {
    e.stopPropagation();
    showMenu(
      more,
      [
        {
          label: "Install specific version…",
          run: () =>
            void services.dispatcher
              .execute("extensions.installSpecificVersion", { id })
              .catch((err: unknown) =>
                services.notifications.show(
                  "error",
                  err instanceof Error ? err.message : String(err),
                ),
              ),
        },
      ],
      "Install",
    );
  });
  return more;
}

const SVG = "http://www.w3.org/2000/svg";
/** The badge's outline (the sprite's badge-check, Lucide, ISC) and its check. */
const BADGE =
  "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z";
const CHECK = "m9 12 2 2 4-4";

/**
 * A filled badge with its check cut out (a mask, so it reads on any background), colored like
 * the rating's filled stars (the owner's ask: filled, not outlined, not blue).
 */
function filledBadge(): SVGSVGElement {
  const el = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const id = `ext-verified-${Math.random().toString(36).slice(2, 8)}`;
  const svg = el("svg", {
    viewBox: "0 0 24 24",
    class: "icon",
    "aria-hidden": "true",
  }) as SVGSVGElement;
  const mask = el("mask", { id });
  mask.append(
    el("rect", { width: "24", height: "24", fill: "white" }),
    el("path", {
      d: CHECK,
      fill: "none",
      stroke: "black",
      "stroke-width": "2.4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  svg.append(mask, el("path", { d: BADGE, fill: "currentColor", mask: `url(#${id})` }));
  return svg;
}

/** VS Code's verified-publisher mark (D284): its namespace is verified on Open VSX. */
export function verifiedMark(): HTMLElement {
  const mark = h(
    "span",
    { class: "ext-store-verified", "aria-label": "Verified publisher" },
    filledBadge(),
  );
  setTooltip(mark, "Verified publisher: its namespace is verified on Open VSX");
  return mark;
}

export function badges(r: ExtensionRecord, actionable = true): HTMLElement[] {
  const out: HTMLElement[] = [];
  const status = STATUS[r.status];
  // "Needs permission" is a button: it opens the permission dialog.
  if (status && r.status === "needsPermission" && actionable) {
    const b = h(
      "button",
      {
        class: `ext-badge is-${status[1]} is-action`,
        type: "button",
        "data-command": "extensions.grantPermissions",
      },
      "Allow…",
    );
    setTooltip(b, "It asks for permissions before it can run: review them");
    out.push(b);
  } else if (status) out.push(h("span", { class: `ext-badge is-${status[1]}` }, status[0]));
  if (r.dev) {
    const b = h("span", { class: "ext-badge" }, "Dev");
    setTooltip(b, "A development extension: it runs from its folder and reloads when files change");
    out.push(b);
  }
  if (r.replaces) {
    const b = h("span", { class: "ext-badge is-warning" }, `Replaces ${r.replaces.version}`);
    setTooltip(
      b,
      `Used instead of the installed version ${r.replaces.version} while it's loaded. Install it permanently to update the installed one, or remove it to go back.`,
    );
    out.push(b);
  }
  if (r.customized) {
    const b = h("span", { class: "ext-badge" }, "Customized");
    setTooltip(
      b,
      "Your changed copy of an extension that comes with the IDE: the IDE's updates to it are skipped",
    );
    out.push(b);
  }
  if (r.manifest?.format === "vscode") out.push(h("span", { class: "ext-badge" }, "VS Code"));
  return out;
}

/** "2 commands, 1 theme, 1 language" */
export function contributionSummary(record: ExtensionRecord): string {
  const c = record.manifest?.contributes;
  if (!c) return "";
  const parts: [number, string][] = [
    [c.commands.length, "command"],
    [c.views.length, "view"],
    [c.viewers.length, "file viewer"],
    [c.menus.length, "menu item"],
    [c.agents.length, "agent"],
    [c.mcpServers.length, "MCP server"],
    [c.modelProviders.length, "model provider"],
    [c.themes.length, "color theme"],
    [c.languages.length, "language"],
    [c.grammars.filter((g) => !c.languages.some((l) => l.id === g.language)).length, "grammar"],
    [c.snippets.length, "snippet file"],
    [Object.keys(c.settings).length, "setting"],
    [c.keybindings.length, "keybinding"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}${n === 1 ? "" : "s"}`)
    .join(", ");
}

/** The gear / right-click menu of an extension: every item runs an extensions.* command. */
export function actionsMenu(
  services: WorkbenchServices,
  r: ExtensionRecord,
  options: { details?: boolean; manager?: ExtensionManager } = {},
): MenuItem[] {
  const { manager } = options;
  const id = { id: r.id };
  const exec =
    (command: string, input: unknown = id) =>
    () =>
      void services.dispatcher.execute(command, input).catch(() => {});
  const items: MenuItem[] = [];
  // A newer version on Open VSX first (D284): the row's Update button, here too.
  const pending = pendingUpdate(r.id);
  if (pending && !pending.installing)
    items.push({
      label: `Update to ${pending.latest}`,
      icon: "download",
      run: exec("extensions.updateFromStore"),
    });
  const afterUpdate = items.length;
  // What it can open first (D181), as on its page's Open button.
  for (const o of services.extensionFeatures.allOpeners(
    (when) => services.context.matches(when),
    r.id,
  ))
    items.push({
      label: `Open ${o.title}`,
      icon: (o.icon ?? "box") as IconName,
      run: exec(o.command, o.input ?? {}),
    });
  // What it brings to use right away (VS Code's Set Color Theme…, D258).
  if (r.status === "active" && r.manifest?.contributes.themes.length)
    items.push({
      label: "Set color theme",
      icon: "palette",
      run: exec("extensions.setColorTheme"),
    });
  if (r.status === "active" && r.manifest?.contributes.iconThemes.length)
    items.push({ label: "Set file icon theme", run: exec("extensions.setFileIconTheme") });
  if (options.details !== false)
    items.push({
      label: "Details",
      icon: "info",
      run: exec("extensions.showDetails"),
      separatorBefore: items.length > 0,
    });
  if (r.status === "needsPermission")
    items.push({
      label: "Review permissions…",
      icon: "shield",
      run: exec("extensions.grantPermissions"),
    });
  // Enable / Disable, everywhere or in this workspace only (VS Code's, D258).
  const folder = !!services.workspace.root.peek();
  if (manager?.disabledHere(r.id))
    items.push({
      label: "Enable (workspace)",
      run: exec("extensions.enableWorkspace"),
      separatorBefore: true,
    });
  else if (r.status === "disabled")
    items.push({ label: "Enable", run: exec("extensions.enable"), separatorBefore: true });
  else if (r.status !== "invalid") {
    items.push({ label: "Disable", run: exec("extensions.disable"), separatorBefore: true });
    if (folder && manager)
      items.push({ label: "Disable (workspace)", run: exec("extensions.disableWorkspace") });
  }
  // From Open VSX: updates and versions (D258).
  if (manager && fromStore(r)) {
    items.push(
      {
        label: "Auto update",
        checked: manager.autoUpdates(r.id),
        run: exec("extensions.setAutoUpdate"),
        separatorBefore: true,
      },
      { label: "Install specific version…", run: exec("extensions.installSpecificVersion") },
    );
  }
  // Installed from a repository (D185): fetched again from there.
  if (r.source)
    items.push({
      label: "Update from repository",
      icon: "cloud-download",
      run: exec("extensions.updateFromRepo"),
    });
  items.push(
    { label: "Reload", run: exec("extensions.reload") },
    { label: "Show log", run: exec("extensions.showLog"), separatorBefore: true },
    {
      label: r.dev ? "Reveal folder" : "Reveal installed files",
      run: exec("extensions.revealFolder"),
    },
    { label: "Copy", run: exec("extensions.copyInfo"), separatorBefore: true },
    {
      label: "Copy extension ID",
      run: () => void clipboardIpc.writeText(r.id).catch(() => {}),
    },
  );
  if (fromStore(r)) {
    items.push({ label: "Copy link", run: exec("extensions.copyLink") });
    if (folder)
      items.push({
        label: "Add to workspace recommendations",
        run: exec("extensions.addToRecommendations"),
        separatorBefore: true,
      });
    items.push(
      { label: "Download VSIX…", run: exec("extensions.downloadVsix"), separatorBefore: true },
      {
        label: "Download specific version VSIX…",
        run: exec("extensions.downloadVsix", { id: r.id, pickVersion: true }),
      },
    );
  }
  if (r.dev && r.manifest)
    items.push({
      label: r.replaces ? "Update installed version…" : "Install permanently",
      icon: "box",
      run: exec("extensions.installPermanently"),
      separatorBefore: true,
    });
  // Its pictures (D190): a development copy's files are the user's to change.
  if (r.dev && r.manifest)
    items.push(
      { label: "Change icon…", icon: "image", run: exec("extensions.setIcon") },
      { label: "Add screenshot of the IDE", icon: "camera", run: exec("extensions.addScreenshot") },
      {
        label: "Add screenshot from file…",
        run: exec("extensions.addScreenshot", { id: r.id, from: "file" }),
      },
    );
  if (!r.dev && r.manifest && services.workspace.root.peek())
    items.push({
      label: "Copy for development",
      icon: "copy",
      run: exec("extensions.copyForDevelopment"),
      separatorBefore: true,
    });
  if (r.customized)
    items.push({
      label: "Go back to the IDE's version…",
      icon: "undo-2",
      run: exec("extensions.revertToBundled"),
    });
  if (services.dispatcher.has("agent.compose") && r.manifest)
    items.push({ label: "Edit with agent…", icon: "agent", run: exec("extensions.editWithAgent") });
  if (r.dev)
    items.push({
      label: "Remove from list",
      run: exec("extensions.remove"),
      separatorBefore: true,
    });
  items.push({
    label: r.dev ? "Uninstall (delete folder)…" : "Uninstall…",
    destructive: true,
    separatorBefore: !r.dev,
    run: exec("extensions.uninstall"),
  });
  const next = items[afterUpdate];
  if (afterUpdate && next) items[afterUpdate] = { ...next, separatorBefore: true };
  return items;
}
