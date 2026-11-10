// The extension page's tabs besides the README (D176): the side panel with its facts and links
// (VS Code's "More info", with a marketplace placeholder), Features, Settings (live controls),
// Files (the folder's files with a preview: Markdown rendered, code colored, images shown),
// Permissions. DOM only; every action runs a command.

import { h, on, replaceChildren } from "../../core/dom/index";
import { describePermission, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { clipboardIpc } from "../../core/ipc/system";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { fileIcon, icon } from "../../ui/Icon";
import { markdownNodes, type RenderOptions } from "../../ui/markdown/render";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { isInWorkspaceFolders } from "../../workbench/workspaceFolder";
import { settingRow } from "../settings/controls";
import { authorsList } from "./authorsView";
import type { ExtensionManager, ExtensionRecord } from "./manager";
import { filterChip } from "./parts";
import { readmeImage } from "./storeMedia";

const exec = (services: WorkbenchServices, command: string, input: unknown) =>
  void services.dispatcher.execute(command, input).catch((err: unknown) => {
    services.notifications.show("error", err instanceof Error ? err.message : String(err));
  });

/** Markdown the way the IDE's previews draw it (diagrams and math too), links opened outside. */
export function markdownOptions(
  services: WorkbenchServices,
  r: ExtensionRecord,
  images: ImageUrls,
): RenderOptions {
  return {
    ...markdownBase(services, (href) => href),
    // Images of the extension's own folder (screenshots in its README); a web address (a VS Code
    // package's README links its badges and screenshots) as the Markdown preview loads remote
    // images (markdown.preview.remoteImages, D258).
    image: (src) =>
      /^(https:|data:image\/)/i.test(src.trim())
        ? readmeImage(services, src, undefined)
        : images.url(r, src),
  };
}

/**
 * The options every extension page's Markdown shares; `link` turns a link into the address to
 * open (null: nothing), e.g. a store README's relative links against its address.
 */
export function markdownBase(
  services: WorkbenchServices,
  link: (href: string) => string | null,
): RenderOptions {
  return {
    openLink: (href) => {
      const url = link(href);
      if (url) exec(services, "ui.openLink", { url });
    },
    copy: (t) => void clipboardIpc.writeText(t).catch(() => {}),
    headingShift: 0,
    softBreaks: "space",
    visuals: true,
    highlight: async (code, lang) => {
      const html = await services.documents.highlight(code, lang).catch(() => null);
      if (!html) return null;
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
      return Array.from(doc.body.firstElementChild?.childNodes ?? []).map((n) =>
        document.importNode(n, true),
      );
    },
  };
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Blob URLs of an extension's images, revoked with the page. */
export class ImageUrls implements Disposable {
  /** By folder and path: the file's change time and its URL (a newer one revokes the older). */
  private readonly urls = new Map<string, { mtimeMs: number; url: Promise<string | null> }>();
  private disposed = false;

  url(r: ExtensionRecord, src: string): Promise<string | null> | null {
    if (this.disposed) return null;
    if (src.startsWith("data:image/")) return Promise.resolve(src);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return null;
    const rel = src.replace(/^\.\//, "").split(/[?#]/)[0] ?? "";
    const type = IMAGE_TYPES[rel.split(".").pop()?.toLowerCase() ?? ""];
    if (!type || rel.split("/").includes("..")) return null;
    const key = `${r.root}\0${rel}`;
    const cached = this.urls.get(key);
    if (cached?.mtimeMs === r.mtimeMs) return cached.url;
    if (cached) revoke(cached.url);
    const url = extIpc.read(r.root, rel).then(
      (bytes) => {
        const made = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        // Closed while it was read: nothing will revoke it later.
        if (this.disposed) {
          URL.revokeObjectURL(made);
          return null;
        }
        return made;
      },
      () => null,
    );
    this.urls.set(key, { mtimeMs: r.mtimeMs, url });
    return url;
  }

  dispose(): void {
    this.disposed = true;
    for (const { url } of this.urls.values()) revoke(url);
    this.urls.clear();
  }
}

function revoke(url: Promise<string | null>): void {
  void url.then((u) => {
    if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
  });
}

/** Where the extension comes from, in words. */
export function sourceOf(services: WorkbenchServices, r: ExtensionRecord): string {
  if (r.source)
    return `From ${repoLabel(r.source.repo)}${r.source.path ? ` (${r.source.path})` : ""}`;
  if (!r.dev) return r.id.startsWith("bundled.") ? "Comes with the IDE" : "Installed";
  // Any of the workspace's folders (D251).
  const owner = services.workspace.folderOf(r.root);
  if (owner && isInWorkspaceFolders(owner.path, r.root, "extensions"))
    return services.workspace.folders.peek().length > 1
      ? `${owner.name}'s extensions (development)`
      : "This folder's extensions (development)";
  return "Development (unpacked)";
}

/** "owner/name" for a GitHub URL, else the URL as given. */
export const repoLabel = (repo: string) =>
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(repo)?.[1] ?? repo;

export const webLink = (services: WorkbenchServices, label: string, url: string) => {
  const href = /^https?:\/\//i.test(url) ? url : null;
  const a = h(
    "a",
    { class: "ext-side-link", href: href ?? "#", role: "link" },
    icon("external-link"),
    label,
  );
  setTooltip(a, url);
  on(a, "click", (e) => {
    e.preventDefault();
    if (href) exec(services, "ui.openLink", { url: href });
  });
  return a;
};

/** The README's side panel: facts, categories, links, and the marketplace's place. */
export function sidePanel(
  services: WorkbenchServices,
  manager: ExtensionManager,
  r: ExtensionRecord,
): HTMLElement {
  const m = r.manifest;
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
  const location = h(
    "button",
    { class: "ext-side-path", type: "button" },
    icon("folder"),
    h("span", null, r.root),
  );
  setTooltip(location, "Reveal the folder");
  on(location, "click", () => exec(services, "extensions.revealFolder", { id: r.id }));
  const updated = r.mtimeMs ? new Date(r.mtimeMs) : null;
  const links = [
    m?.repository ? webLink(services, "Repository", m.repository) : null,
    m?.homepage ? webLink(services, "Homepage", m.homepage) : null,
    // Where it was installed from, when that's a web address and not already listed (D185).
    r.source && /^https?:\/\//i.test(r.source.repo) && r.source.repo !== m?.repository
      ? webLink(services, "Installed from", r.source.repo.replace(/\.git$/, ""))
      : null,
  ].filter((x): x is HTMLAnchorElement => !!x);
  const running = manager.isRunning(r.id);
  return h(
    "aside",
    { class: "ext-side" },
    section(
      "Installation",
      fact("Identifier", h("code", null, r.id)),
      fact("Version", m?.version ?? "—"),
      fact("Source", sourceOf(services, r)),
      fact("State", running ? "Running" : r.status === "active" ? "Not started yet" : r.status),
      updated ? fact("Last updated", updated.toLocaleString()) : null,
      m?.license ? fact("License", m.license) : null,
      location,
    ),
    m?.authors.length
      ? section(m.authors.length === 1 ? "Author" : "Authors", authorsList(services, m.authors))
      : null,
    m && (m.categories.length || m.keywords.length)
      ? section(
          "Categories",
          m.categories.length ? chips("@category", m.categories) : null,
          m.keywords.length ? chips("@tag", m.keywords) : null,
        )
      : null,
    links.length ? section("Resources", ...links) : null,
    section(
      "Marketplace",
      h(
        "p",
        { class: "ext-page-muted" },
        "Not published to a marketplace. Ratings, reviews and installs will show here once there is one.",
      ),
    ),
  );
}

/**
 * Features: what it adds, a table per kind (an installed extension's manifest, or a store
 * extension's package.json read the same way).
 */
export function features(
  services: WorkbenchServices,
  manifest: ThirdPartyManifest | null | undefined,
): HTMLElement[] {
  const c = manifest?.contributes;
  if (!c) return [h("p", { class: "ext-page-muted" }, "Its manifest couldn't be read.")];
  const out: HTMLElement[] = [];
  const table = (title: string, head: string[], rows: string[][]) => {
    if (!rows.length) return;
    out.push(
      h("h2", null, `${title} (${rows.length})`),
      h(
        "table",
        { class: "ext-page-table" },
        h("thead", null, h("tr", null, ...head.map((x) => h("th", null, x)))),
        h(
          "tbody",
          null,
          ...rows.map((row) => h("tr", null, ...row.map((cell) => h("td", null, cell)))),
        ),
      ),
    );
  };
  const keyFor = (command: string) =>
    services.keyboard.labelFor(command) ??
    c.keybindings.find((k) => k.command === command)?.key ??
    "";
  const WHERE = {
    sidebar: "Sidebar",
    panel: "Panel",
    editor: "Editor area",
    secondary: "Secondary side bar",
  } as const;
  table(
    "Commands",
    ["Command", "ID", "Keybinding"],
    c.commands.map((x) => [x.title, x.id, keyFor(x.id)]),
  );
  table(
    "Views",
    ["View", "Where", "Kind"],
    c.views.map((v) => [v.title, WHERE[v.location] ?? v.location, v.type]),
  );
  table(
    "File viewers",
    ["Viewer", "Files", "Opens"],
    c.viewers.map((v) => [
      v.title,
      v.extensions.join(" "),
      v.default ? "Directly" : "As a preview / Reopen with",
    ]),
  );
  table(
    "Menu items",
    ["Item", "Menu", "Command"],
    c.menus.map((x) => [x.title ?? x.command, x.location, x.command]),
  );
  table(
    "Agents",
    ["Agent", "Runs"],
    c.agents.map((a) => [a.name, [a.command, ...(a.args ?? [])].join(" ")]),
  );
  table(
    "MCP servers",
    ["Server", "Runs"],
    c.mcpServers.map((a) => [a.name, [a.command, ...(a.args ?? [])].join(" ")]),
  );
  table(
    "Model providers",
    ["Provider", "Address"],
    c.modelProviders.map((p) => [p.name, p.baseUrl]),
  );
  table(
    "Settings",
    ["Setting", "Default", "Description"],
    Object.entries(c.settings).map(([key, s]) => [
      key,
      JSON.stringify(s.default ?? null),
      s.description ?? "",
    ]),
  );
  table(
    "Color themes",
    ["Theme", "Kind"],
    c.themes.map((t) => [
      t.label,
      t.uiTheme === "vs" || t.uiTheme === "hc-light" ? "Light" : "Dark",
    ]),
  );
  table(
    "File icon themes",
    ["Theme", "ID"],
    c.iconThemes.map((t) => [t.label, t.id]),
  );
  table(
    "Languages",
    ["Language", "File types"],
    c.languages.map((l) => [l.id, [...(l.extensions ?? []), ...(l.filenames ?? [])].join(" ")]),
  );
  // Grammars for languages it doesn't define itself (an injection, or another's language).
  table(
    "Grammars",
    ["Scope", "Language"],
    c.grammars
      .filter((g) => !c.languages.some((l) => l.id === g.language))
      .map((g) => [g.scopeName, g.language ?? ""]),
  );
  table(
    "Keybindings",
    ["Key", "Command"],
    c.keybindings
      .filter((k) => !k.command.startsWith("-"))
      .map((k) => [services.platform === "mac" ? (k.mac ?? k.key) : k.key, k.command]),
  );
  table(
    "Snippets",
    ["Language", "File"],
    c.snippets.map((s) => [s.language, s.path]),
  );
  if (!out.length) out.push(h("p", { class: "ext-page-muted" }, "It doesn't add anything yet."));
  return out;
}

/** Settings: the same rows as the settings editor (changes are `settings.set`). */
export function settingsTab(
  services: WorkbenchServices,
  r: ExtensionRecord,
  store: DisposableStore,
): HTMLElement[] {
  const keys = Object.keys(r.manifest?.contributes.settings ?? {});
  const infos = keys
    .map((k) => services.settings.registry.get(k))
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!infos.length)
    return [
      h(
        "p",
        { class: "ext-page-muted" },
        keys.length
          ? "Its settings show here while it's enabled."
          : "It has no settings of its own.",
      ),
    ];
  // A card per group (a VS Code package's configuration titles), labelled when there are several.
  const groups = new Map<string, typeof infos>();
  for (const info of infos) {
    const title = info.section ?? info.category;
    groups.set(title, [...(groups.get(title) ?? []), info]);
  }
  const cards: HTMLElement[] = [];
  const rows = [...groups].flatMap(([title, list]) => {
    const card = h("div", { class: "settings-card ext-settings-card" });
    if (groups.size > 1) cards.push(h("h2", { class: "settings-section-title" }, title));
    cards.push(card);
    return list.map((info) => {
      const row = store.add(settingRow(info, "user", "", services));
      card.append(row.element);
      return row;
    });
  });
  store.add(
    services.settings.model.onDidChange(() => {
      for (const row of rows) row.update();
    }),
  );
  const open = h(
    "button",
    { class: "button button-secondary button-sm", type: "button" },
    "Open in settings",
  );
  on(open, "click", () => exec(services, "settings.open", { query: `@ext:${r.id}` }));
  return [...cards, h("div", { class: "ext-page-actions" }, open)];
}

/** Permissions: asked and granted. */
export function permissions(manager: ExtensionManager, r: ExtensionRecord): HTMLElement[] {
  const asked = r.manifest?.permissions ?? [];
  const granted = manager.granted(r.id);
  // Other settings it reads (D202): not a permission, but the user may want to know.
  const reads = r.manifest?.readsSettings ?? [];
  const readsNote = reads.length
    ? [
        h(
          "p",
          { class: "ext-page-muted" },
          "It also reads these settings: ",
          ...reads.flatMap((k, i) => [i ? ", " : "", h("code", null, k)]),
        ),
      ]
    : [];
  if (!asked.length)
    return [
      h(
        "p",
        { class: "ext-page-muted" },
        "It asks for no permissions: it can only use its own commands, views and settings.",
      ),
      ...readsNote,
    ];
  return [
    ...readsNote,
    h(
      "ul",
      { class: "ext-page-perms" },
      ...asked.map((p) =>
        h(
          "li",
          null,
          icon(granted.includes(p) ? "circle-check" : "circle-dot"),
          h("span", null, describePermission(p)),
          h("code", null, p),
          h(
            "span",
            { class: "ext-page-muted" },
            granted.includes(p) ? "Allowed" : "Not allowed yet",
          ),
        ),
      ),
    ),
    h(
      "p",
      { class: "ext-page-muted" },
      "Extensions run in a sandbox: everything else they try is refused and shows in the Log tab.",
    ),
  ];
}

const MAX_PREVIEW = 512 * 1024;

/**
 * Files: the folder's files on the left, the chosen one on the right. Development extensions'
 * files open in the editor; installed ones are read-only copies (change them in a development
 * copy, or ask the agent).
 */
export class FilesPane implements Disposable {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly store = new DisposableStore();
  private files: { path: string; size: number }[] | null = null;
  private chosen: string | null = null;
  /** Separate counters: picking a file mustn't cancel a reload of the list, nor the reverse. */
  private generation = 0;
  private listGeneration = 0;

  constructor(
    private readonly services: WorkbenchServices,
    private r: ExtensionRecord,
    private readonly images: ImageUrls,
  ) {
    this.list = h("div", { class: "ext-files-list", role: "listbox", "aria-label": "Files" });
    this.preview = h("div", { class: "ext-files-preview" });
    this.element = h("div", { class: "ext-files" }, this.list, this.preview);
    this.store.add(
      on(this.list, "click", (e) => {
        const row = (e.target as Element | null)?.closest<HTMLElement>("[data-file]");
        if (row?.dataset.file) this.show(row.dataset.file);
      }),
    );
    this.store.add(
      toDisposable(() => {
        this.generation++;
        this.listGeneration++;
      }),
    );
    void this.load();
  }

  /** The record changed (files edited): reload the list and the open file. */
  update(r: ExtensionRecord): void {
    if (r.mtimeMs === this.r.mtimeMs && r.root === this.r.root) return;
    this.r = r;
    void this.load();
  }

  private async load(): Promise<void> {
    const generation = ++this.listGeneration;
    const files = await extIpc.files(this.r.root).catch(() => null);
    if (generation !== this.listGeneration) return;
    this.files = files;
    if (!files?.length) {
      replaceChildren(this.list, h("p", { class: "ext-page-muted" }, "No files to show."));
      replaceChildren(this.preview);
      return;
    }
    replaceChildren(
      this.list,
      ...files.map((f) => {
        const depth = f.path.split("/").length - 1;
        const name = f.path.split("/").pop() ?? f.path;
        const row = h(
          "button",
          {
            class: { "ext-file": true, "is-selected": f.path === this.chosen },
            type: "button",
            role: "option",
            "data-file": f.path,
            style: { "--ext-file-depth": String(depth) },
          },
          icon(fileIcon(name)),
          h("span", { class: "ext-file-name" }, depth ? f.path : name),
        );
        setTooltip(row, `${f.path} · ${formatSize(f.size)}`);
        return row;
      }),
    );
    const first =
      (this.chosen && files.some((f) => f.path === this.chosen) && this.chosen) ||
      files.find((f) => /^readme\.md$/i.test(f.path))?.path ||
      files.find((f) => f.path === this.r.manifestFile)?.path ||
      files[0]?.path;
    if (first) this.show(first);
  }

  private show(path: string): void {
    this.chosen = path;
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-file]"))
      el.classList.toggle("is-selected", el.dataset.file === path);
    const generation = ++this.generation;
    const file = this.files?.find((f) => f.path === path);
    const open = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      icon("file-code"),
      this.r.dev ? "Open in editor" : "Open read-only",
    );
    on(open, "click", () => void this.openInEditor(path));
    const head = h(
      "div",
      { class: "ext-files-head" },
      h("span", { class: "ext-files-path" }, path),
      h("span", { class: "ext-page-muted" }, file ? formatSize(file.size) : ""),
      open,
    );
    replaceChildren(this.preview, head, h("div", { class: "ext-page-muted" }, "Loading…"));
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_TYPES[ext]) {
      void Promise.resolve(this.images.url(this.r, path)).then((url) => {
        if (generation !== this.generation) return;
        replaceChildren(
          this.preview,
          head,
          url
            ? h("div", { class: "ext-files-image" }, h("img", { src: url, alt: path }))
            : h("p", { class: "ext-page-muted" }, "Couldn't show this image."),
        );
      });
      return;
    }
    if ((file?.size ?? 0) > MAX_PREVIEW) {
      replaceChildren(
        this.preview,
        head,
        h("p", { class: "ext-page-muted" }, "Too large to preview here: open it in the editor."),
      );
      return;
    }
    void extIpc
      .read(this.r.root, path)
      .then((bytes) => {
        if (generation !== this.generation) return;
        if (bytes.subarray(0, 8000).includes(0)) {
          replaceChildren(
            this.preview,
            head,
            h("p", { class: "ext-page-muted" }, "A binary file."),
          );
          return;
        }
        const text = new TextDecoder().decode(bytes);
        const body =
          ext === "md" || ext === "markdown"
            ? h(
                "div",
                { class: "md md-document ext-files-md" },
                ...markdownNodes(text, markdownOptions(this.services, this.r, this.images)),
              )
            : h(
                "div",
                { class: "md ext-files-code" },
                ...markdownNodes(fence(text, languageOf(ext)), {
                  ...markdownOptions(this.services, this.r, this.images),
                  visuals: false,
                }),
              );
        replaceChildren(this.preview, head, body);
      })
      .catch((err: unknown) => {
        if (generation !== this.generation) return;
        replaceChildren(
          this.preview,
          head,
          h("p", { class: "ext-error" }, err instanceof Error ? err.message : String(err)),
        );
      });
  }

  private async openInEditor(path: string): Promise<void> {
    const full = joinPath(this.r.root, path);
    if (this.r.dev && this.services.workspace.contains(full)) {
      exec(this.services, "editor.openFile", { path: full });
      return;
    }
    const text = await extIpc.readText(this.r.root, path).catch(() => null);
    if (text === null) return;
    exec(this.services, "editor.openReadOnly", {
      title: `${path.split("/").pop() ?? path} (${this.r.id})`,
      content: text,
    });
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** A fenced block that holds `text` whatever backticks it has. */
function fence(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

const LANGS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  json: "json",
  jsonc: "json",
  html: "html",
  css: "css",
  svg: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  py: "python",
  tpl: "",
  txt: "",
};

function languageOf(ext: string): string {
  return LANGS[ext] ?? ext;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
