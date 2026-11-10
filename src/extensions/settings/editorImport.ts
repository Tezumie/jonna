// "Import from VS Code" (D193): one page that brings over another editor's setup — settings (the
// theme with them), keyboard shortcuts, snippets, MCP servers — and its extensions: installed from
// Open VSX (VS Code extensions run here, D296) before the settings and shortcuts, so theirs come
// along too; what the IDE does itself is said. Nothing changes until Import; the user's own values win unless they say
// otherwise. VS Code, VS Code Insiders, Cursor, VSCodium and Windsurf are found on their own;
// "Choose a folder…" reads a portable install or a copied profile.

import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { dialogIpc, type EditorProfile, settingsIpc } from "../../core/ipc/system";
import { type DisposableStore, DisposableStore as Store } from "../../core/lifecycle/index";
import { dirname, isAbsolute, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { appendJsoncArrayItem, setJsoncProperty } from "../../core/settings/jsoncEdit";
import { isLanguageOverrideKey, validBlock } from "../../core/settings/languageOverrides";
import { isValid } from "../../core/settings/schema";
import { translateVscodeSettings } from "../../core/settings/vscode";
import {
  type ExtensionFate,
  extensionFate,
  type ImportedRule,
  type KeybindingImport,
  type McpInput,
  type McpServerConfig,
  parseMcpConfig,
  translateKeybindings,
} from "../../core/settings/vscodeImport";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

export type ImportPart = "settings" | "keybindings" | "snippets" | "mcp" | "extensions";
export const IMPORT_PARTS: readonly ImportPart[] = [
  "settings",
  "keybindings",
  "snippets",
  "mcp",
  "extensions",
];

export interface ImportPlan {
  app: string;
  dir: string;
  settings: {
    /** Keys new here (not set in the user's settings). */
    add: Record<string, unknown>;
    /** Keys the user set to something else: theirs, kept unless "replace". */
    differs: Record<string, unknown>;
    same: number;
    /** VS Code keys with no counterpart here. */
    skipped: string[];
  };
  keybindings: KeybindingImport & { already: number };
  snippets: { name: string; text: string; exists: boolean }[];
  mcp: {
    servers: Record<string, McpServerConfig>;
    inputs: McpInput[];
    existing: string[];
  };
  extensions: { id: string; fate: ExtensionFate; on?: boolean }[];
}

export interface ImportResult {
  settings: number;
  keybindings: number;
  snippets: number;
  mcp: number;
  /** Extensions installed, and built-in replacements turned on. */
  extensions: number;
  /** Extensions that didn't install (why, per id). */
  failed?: { id: string; error: string }[];
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b).replace(/^﻿/, "");
const readText = (path: string) => fsIpc.read(path).then(decode, () => "");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function jsonc(text: string | null): unknown {
  if (!text) return undefined;
  const parsed = parseJsonc(text);
  return parsed.ok ? parsed.value : undefined;
}

function userDir(services: WorkbenchServices): string | null {
  const file = services.settings.filePath("user");
  return file ? dirname(file) : null;
}

/** What importing `profile` would change (nothing is written). */
export async function planImport(
  services: WorkbenchServices,
  profile: EditorProfile,
): Promise<ImportPlan> {
  const { settings, dispatcher } = services;
  // Settings: what applies here, and whether the user has their own value.
  const raw = jsonc(profile.settings);
  const translated =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? translateVscodeSettings(raw as Record<string, unknown>, (k) => !!settings.registry.get(k))
      : { values: {}, skipped: [] };
  const add: Record<string, unknown> = {};
  const differs: Record<string, unknown> = {};
  let sameCount = 0;
  const skipped = [...translated.skipped];
  const applies = (key: string, value: unknown) => {
    const schema = settings.registry.get(key);
    return !!schema && isValid(schema, value);
  };
  for (const [key, value] of Object.entries(translated.values)) {
    if (isLanguageOverrideKey(key)) {
      // A language block (`[python]`): its settings join the user's block of that name, theirs
      // kept unless "replace".
      const block = validBlock(value, applies);
      if (!block) {
        skipped.push(key);
        continue;
      }
      const mine = settings.model.inspect(key, "user");
      const own =
        mine && typeof mine === "object" && !Array.isArray(mine)
          ? (mine as Record<string, unknown>)
          : {};
      const entries = Object.entries(block);
      const fresh = Object.fromEntries(entries.filter(([k]) => own[k] === undefined));
      const changed = Object.fromEntries(
        entries.filter(([k, v]) => own[k] !== undefined && !same(own[k], v)),
      );
      if (Object.keys(fresh).length) add[key] = { ...own, ...fresh };
      if (Object.keys(changed).length) differs[key] = { ...own, ...fresh, ...changed };
      if (!Object.keys(fresh).length && !Object.keys(changed).length) sameCount++;
      continue;
    }
    const schema = settings.registry.get(key);
    if (!schema || !isValid(schema, value)) {
      skipped.push(key);
      continue;
    }
    const mine = settings.model.inspect(key, "user");
    if (mine === undefined) add[key] = value;
    else if (same(mine, value)) sameCount++;
    else differs[key] = value;
  }
  // Shortcuts, minus those keybindings.json already has.
  const keys = translateKeybindings(jsonc(profile.keybindings), (c) => dispatcher.has(c));
  const existingRules = settings.keybindingsPath
    ? jsonc(await readText(settings.keybindingsPath))
    : undefined;
  const have = Array.isArray(existingRules) ? existingRules.map((r) => JSON.stringify(r)) : [];
  const fresh = keys.rules.filter((r) => !have.includes(JSON.stringify(r)));
  // Snippets: their files, and whether a file of that name is here already.
  const dir = userDir(services);
  const present = dir
    ? new Set(
        (await fsIpc.listDir(joinPath(dir, "snippets")).catch(() => [])).map((e) =>
          e.name.toLowerCase(),
        ),
      )
    : new Set<string>();
  // MCP servers, and the names the user's mcp.json has already.
  const mcp = parseMcpConfig(jsonc(profile.mcp));
  const userMcp = dir ? parseMcpConfig(jsonc(await readText(joinPath(dir, "mcp.json")))) : null;
  return {
    app: profile.app,
    dir: profile.dir,
    settings: { add, differs, same: sameCount, skipped },
    keybindings: { rules: fresh, skipped: keys.skipped, already: keys.rules.length - fresh.length },
    snippets: profile.snippets.map(([name, text]) => ({
      name,
      text,
      exists: present.has(name.toLowerCase()),
    })),
    mcp: { ...mcp, existing: Object.keys(userMcp?.servers ?? {}) },
    extensions: await settleExtensions(services, profile.extensions),
  };
}

/** The extensions installed here (ids, lower-case). */
async function installedIds(services: WorkbenchServices): Promise<Set<string>> {
  const r = (await services.dispatcher.execute("extensions.list", {}).catch(() => null)) as {
    extensions?: { id: string }[];
  } | null;
  return new Set((r?.extensions ?? []).map((e) => e.id.toLowerCase()));
}

/** Whether Open VSX has the extension (its details answer). */
async function onOpenVsx(id: string): Promise<boolean> {
  const dot = id.indexOf(".");
  if (dot <= 0) return false;
  try {
    const details = JSON.parse(await extIpc.storeDetails(id.slice(0, dot), id.slice(dot + 1))) as {
      error?: unknown;
      version?: unknown;
    };
    return !details.error && typeof details.version === "string";
  } catch {
    return false;
  }
}

/**
 * Each extension's fate settled: installed here already, on Open VSX (installed by Import), or
 * not there. Six questions to the store at a time.
 */
async function settleExtensions(
  services: WorkbenchServices,
  ids: readonly string[],
): Promise<ImportPlan["extensions"]> {
  const installed = await installedIds(services);
  const out: ImportPlan["extensions"] = ids.map((id) => {
    const fate = extensionFate(id);
    return {
      id,
      fate:
        fate.kind === "store" && installed.has(id.toLowerCase())
          ? { kind: "installed" as const, ...(fate.note && { note: fate.note }) }
          : fate,
      ...(fate.kind === "setting" && { on: services.settings.peek(fate.setting) === true }),
    };
  });
  const ask = out.filter((e) => e.fate.kind === "store");
  for (let i = 0; i < ask.length; i += 6)
    await Promise.all(
      ask.slice(i, i + 6).map(async (e) => {
        if (await onOpenVsx(e.id)) return;
        const note = e.fate.kind === "store" ? e.fate.note : undefined;
        e.fate = { kind: "missing", ...(note && { note }) };
      }),
    );
  return out;
}

/**
 * Writes the chosen parts of `plan`. With `replace`, theirs wins where both have a value.
 * Extensions install first; `replan` then reads the settings and shortcuts again, so the
 * extensions' own (`python.*`, their keybindings) apply now that they're here.
 */
export async function applyImport(
  services: WorkbenchServices,
  plan: ImportPlan,
  parts: readonly ImportPart[],
  replace: boolean,
  replan?: () => Promise<ImportPlan>,
): Promise<ImportResult> {
  const { settings } = services;
  const result: ImportResult = { settings: 0, keybindings: 0, snippets: 0, mcp: 0, extensions: 0 };
  const dir = userDir(services);
  if (parts.includes("extensions")) {
    const failed: { id: string; error: string }[] = [];
    for (const e of plan.extensions) {
      if (e.fate.kind !== "store") continue;
      try {
        // As the user (Import was pressed): each asks for what its code needs, as installing does.
        await services.dispatcher.execute("extensions.installFromStore", { id: e.id });
        result.extensions++;
      } catch (err) {
        failed.push({ id: e.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (failed.length) result.failed = failed;
    if (result.extensions && replan) {
      const fresh = await replan();
      plan = { ...plan, settings: fresh.settings, keybindings: fresh.keybindings };
    }
  }
  if (parts.includes("settings")) {
    const values = { ...plan.settings.add, ...(replace ? plan.settings.differs : {}) };
    // The built-in replacements for their extensions (inline blame for GitLens…) come with them.
    if (parts.includes("extensions"))
      for (const e of plan.extensions)
        if (e.fate.kind === "setting" && !e.on) {
          values[e.fate.setting] = true;
          result.extensions++;
        }
    const toggles = parts.includes("extensions")
      ? plan.extensions.filter((e) => e.fate.kind === "setting" && !e.on).length
      : 0;
    await settings.updateMany(values, "user");
    result.settings = Object.keys(values).length - toggles;
  } else if (parts.includes("extensions")) {
    const values: Record<string, unknown> = {};
    for (const e of plan.extensions)
      if (e.fate.kind === "setting" && !e.on) values[e.fate.setting] = true;
    await settings.updateMany(values, "user");
    result.extensions += Object.keys(values).length;
  }
  if (parts.includes("keybindings") && plan.keybindings.rules.length && settings.keybindingsPath) {
    let text = await readText(settings.keybindingsPath);
    if (text.trim() && !Array.isArray(jsonc(text)))
      throw new Error(
        "Your keybindings.json has a syntax error; fix it first so nothing in it is lost.",
      );
    if (!text.trim()) text = "[\n]\n";
    for (const rule of plan.keybindings.rules)
      text = appendJsoncArrayItem(text, rule satisfies ImportedRule);
    await fsIpc.write(settings.keybindingsPath, new TextEncoder().encode(text));
    result.keybindings = plan.keybindings.rules.length;
  }
  if (parts.includes("snippets") && dir && plan.snippets.length) {
    await fsIpc.createDir(dir, "snippets").catch(() => {});
    for (const snippet of plan.snippets) {
      if (snippet.exists && !replace) continue;
      await fsIpc.write(
        joinPath(joinPath(dir, "snippets"), snippet.name),
        new TextEncoder().encode(snippet.text),
      );
      result.snippets++;
    }
  }
  const servers = Object.entries(plan.mcp.servers).filter(
    ([name]) => replace || !plan.mcp.existing.includes(name),
  );
  if (parts.includes("mcp") && dir && servers.length) {
    const path = joinPath(dir, "mcp.json");
    let text = await readText(path);
    if (text.trim() && !parseJsonc(text).ok)
      throw new Error("Your mcp.json has a syntax error; fix it first so nothing in it is lost.");
    const current = jsonc(text) as
      | { servers?: Record<string, unknown>; inputs?: McpInput[] }
      | undefined;
    text = setJsoncProperty(text, "servers", {
      ...(current?.servers ?? {}),
      ...Object.fromEntries(servers),
    });
    const used = new Set(
      servers.flatMap(([, c]) => JSON.stringify(c).match(/\$\{input:([^}]+)\}/g) ?? []),
    );
    const inputs = plan.mcp.inputs.filter((i) => used.has(`\${input:${i.id}}`));
    if (inputs.length) {
      const kept = (current?.inputs ?? []).filter((i) => !inputs.some((n) => n.id === i.id));
      text = setJsoncProperty(text, "inputs", [
        ...kept,
        ...inputs.map((i) => ({
          type: "promptString",
          id: i.id,
          description: i.description,
          password: i.password,
        })),
      ]);
    }
    await fsIpc.write(path, new TextEncoder().encode(text));
    result.mcp = servers.length;
  }
  return result;
}

/** The editors found here, or the folder given (relative: in the open folder). */
async function profiles(dir?: string, root?: string | null): Promise<EditorProfile[]> {
  const full = dir && root && !isAbsolute(dir) ? joinPath(root, dir) : dir;
  return settingsIpc.editorProfiles(full);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An extension's row: what Import does with it, and what's also built in. */
function extensionDetail(e: ImportPlan["extensions"][number]): string {
  const f = e.fate;
  const also = (text: string, note?: string) => (note ? `${text} · ${note}` : text);
  switch (f.kind) {
    case "store":
      return also("Installs from Open VSX", f.note);
    case "installed":
      return also("Installed", f.note);
    case "missing":
      return also("Not on Open VSX", f.note);
    case "setting":
      return `${f.note}${e.on ? "" : " · turned on by Import"}`;
    case "builtin":
      return f.note;
  }
}

export function summary(r: ImportResult): string {
  const parts = [
    r.settings && plural(r.settings, "setting"),
    r.keybindings && plural(r.keybindings, "shortcut"),
    r.snippets && plural(r.snippets, "snippet file"),
    r.mcp && plural(r.mcp, "MCP server"),
    r.extensions && plural(r.extensions, "extension"),
  ].filter(Boolean);
  const done = parts.length ? parts.join(", ") : "nothing new";
  return r.failed?.length
    ? `${done} (${plural(r.failed.length, "extension")} didn't install: ${r.failed.map((f) => f.id).join(", ")})`
    : done;
}

/** The page: one source, a row per part (checkbox, counts, details), Import. */
class ImportView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new Store();
  private readonly render = this.store.add(new Store());
  private found: EditorProfile[] = [];
  private current: EditorProfile | null = null;
  private plan: ImportPlan | null = null;
  private readonly chosen = new Set<ImportPart>(IMPORT_PARTS);
  private replace = false;
  private status = "";
  private readonly body: HTMLElement;

  constructor(
    private readonly services: WorkbenchServices,
    private dir: string | undefined,
  ) {
    this.body = h("div", { class: "ai-setup vsimport" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    void this.load();
  }

  private async load(): Promise<void> {
    this.status = "Looking for VS Code…";
    this.draw();
    try {
      this.found = await profiles(this.dir);
      this.current = this.found[0] ?? null;
      this.plan = this.current ? await planImport(this.services, this.current) : null;
      this.status = "";
    } catch (err) {
      this.status = err instanceof Error ? err.message : String(err);
    }
    this.draw();
  }

  private async choose(app: string): Promise<void> {
    this.current = this.found.find((f) => f.app === app) ?? null;
    this.plan = this.current ? await planImport(this.services, this.current) : null;
    this.draw();
  }

  private part(
    part: ImportPart,
    title: string,
    detail: string,
    count: number,
    more?: () => HTMLElement | null,
  ): HTMLElement {
    const box = h("input", {
      type: "checkbox",
      class: "vsimport-check",
      "aria-label": title,
    }) as HTMLInputElement;
    box.checked = count > 0 && this.chosen.has(part);
    box.disabled = count === 0;
    this.render.add(
      on(box, "change", () => {
        if (box.checked) this.chosen.add(part);
        else this.chosen.delete(part);
        this.draw();
      }),
    );
    const extra = more?.() ?? null;
    return h(
      "div",
      { class: "vsimport-part", "data-part": part },
      h(
        "label",
        { class: "ai-row vsimport-row" },
        box,
        h(
          "span",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, title),
          h("span", { class: "ai-row-detail" }, detail),
        ),
      ),
      extra,
    );
  }

  private details(summaryText: string, lines: string[]): HTMLElement | null {
    if (!lines.length) return null;
    return h(
      "details",
      { class: "vsimport-details" },
      h("summary", null, summaryText),
      h("ul", null, ...lines.slice(0, 200).map((l) => h("li", null, l))),
    );
  }

  private draw(): void {
    this.render.clear();
    const plan = this.plan;
    const header = h(
      "div",
      { class: "ai-header" },
      h(
        "div",
        null,
        h("h1", { class: "ai-title" }, "Import from VS Code"),
        h(
          "p",
          { class: "ai-lead" },
          "Bring your settings, shortcuts, snippets and MCP servers. Nothing changes until you press Import, and your own settings stay unless you choose otherwise.",
        ),
      ),
    );
    const folder = h(
      "button",
      { class: "button button-ghost button-sm", type: "button" },
      "Choose a folder…",
    );
    setTooltip(folder, "A portable install or a copied profile (its data/user-data/User folder)");
    this.render.add(
      on(folder, "click", () => {
        void dialogIpc
          .pickFolder("VS Code's User folder")
          .then((path) => {
            if (path) {
              this.dir = path;
              void this.load();
            }
          })
          .catch(() => {});
      }),
    );
    const source =
      this.found.length > 1
        ? (() => {
            const select = h(
              "select",
              { class: "input vsimport-source", "aria-label": "Import from" },
              ...this.found.map((f) =>
                h("option", { value: f.app, selected: f === this.current }, f.app),
              ),
            ) as HTMLSelectElement;
            this.render.add(on(select, "change", () => void this.choose(select.value)));
            return select;
          })()
        : h("span", { class: "vsimport-source-name" }, this.current?.app ?? "");
    const from = h(
      "div",
      { class: "vsimport-from" },
      h("span", { class: "ai-default-label" }, "From"),
      source,
      folder,
    );
    if (!plan) {
      replaceChildren(
        this.body,
        header,
        from,
        h(
          "p",
          { class: "ai-section-lead vsimport-empty" },
          this.status ||
            "No VS Code, Cursor, VSCodium or Windsurf settings were found on this computer. If yours is a portable install, choose its folder.",
        ),
      );
      return;
    }
    const st = plan.settings;
    const theme = st.add["workbench.colorTheme"] ?? st.differs["workbench.colorTheme"];
    const settingsCount =
      Object.keys(st.add).length + (this.replace ? Object.keys(st.differs).length : 0);
    const differs = Object.keys(st.differs);
    const settingsPart = this.part(
      "settings",
      "Settings",
      `${plural(Object.keys(st.add).length, "new setting")}${differs.length ? `, ${plural(differs.length, "different from yours", "different from yours")}` : ""}${st.same ? `, ${st.same} already the same` : ""}${theme ? ` · theme ${String(theme)}` : ""}`,
      settingsCount + differs.length,
      () =>
        this.details(`${plural(st.skipped.length, "setting")} that don't apply here`, st.skipped),
    );
    const kb = plan.keybindings;
    const keysPart = this.part(
      "keybindings",
      "Keyboard shortcuts",
      `${plural(kb.rules.length, "shortcut")} to add${kb.already ? `, ${kb.already} already here` : ""}${kb.skipped.length ? `, ${kb.skipped.length} without a matching command` : ""}`,
      kb.rules.length,
      () =>
        this.details(
          `${plural(kb.skipped.length, "shortcut")} left out`,
          kb.skipped.map((x) => `${x.key} → ${x.command} (${x.reason})`),
        ),
    );
    const newSnippets = plan.snippets.filter((x) => !x.exists || this.replace).length;
    const snippetsPart = this.part(
      "snippets",
      "Snippets",
      plan.snippets.length
        ? `${plural(plan.snippets.length, "file")}${plan.snippets.some((x) => x.exists) ? ` (${plan.snippets.filter((x) => x.exists).length} with a name you have)` : ""}`
        : "None",
      newSnippets,
      () =>
        this.details(
          "Files",
          plan.snippets.map((x) => x.name),
        ),
    );
    const servers = Object.keys(plan.mcp.servers);
    const mcpPart = this.part(
      "mcp",
      "MCP servers",
      servers.length
        ? `${servers.join(", ")}${plan.mcp.inputs.some((i) => i.password) ? " · passwords are asked when a server starts" : ""}`
        : "None",
      servers.filter((n) => this.replace || !plan.mcp.existing.includes(n)).length,
    );
    const toggles = plan.extensions.filter((e) => e.fate.kind === "setting" && !e.on).length;
    const count = (kind: ExtensionFate["kind"]) =>
      plan.extensions.filter((e) => e.fate.kind === kind).length;
    const toInstall = count("store");
    const extensionsPart = this.part(
      "extensions",
      "Extensions",
      plan.extensions.length
        ? [
            plural(plan.extensions.length, "extension"),
            toInstall && `${toInstall} to install from Open VSX`,
            count("installed") && `${count("installed")} installed already`,
            count("builtin") + count("setting") &&
              `${count("builtin") + count("setting")} built in here${toggles ? ` (${toggles} to turn on)` : ""}`,
            count("missing") && `${count("missing")} not on Open VSX`,
          ]
            .filter(Boolean)
            .join(", ")
        : "None installed",
      toInstall + toggles,
    );
    const extList = plan.extensions.length
      ? h(
          "div",
          { class: "ai-list vsimport-extensions" },
          ...plan.extensions.map((e) =>
            h(
              "div",
              { class: "ai-row vsimport-ext" },
              h("span", { class: `ai-dot${e.fate.kind === "missing" ? "" : " is-ok"}` }),
              h(
                "span",
                { class: "ai-row-main" },
                h("span", { class: "ai-row-name" }, e.id),
                h("span", { class: "ai-row-detail" }, extensionDetail(e)),
              ),
            ),
          ),
        )
      : null;
    const replace = h("input", { type: "checkbox", class: "vsimport-check" }) as HTMLInputElement;
    replace.checked = this.replace;
    this.render.add(
      on(replace, "change", () => {
        this.replace = replace.checked;
        this.draw();
      }),
    );
    const go = h(
      "button",
      { class: "button button-accent", type: "button" },
      icon("download"),
      "Import",
    ) as HTMLButtonElement;
    go.disabled = this.chosen.size === 0 || !!this.status.endsWith("…");
    this.render.add(
      on(go, "click", () => {
        go.disabled = true;
        this.status = "Importing…";
        void this.services.dispatcher
          .execute("settings.importFromEditor", {
            app: plan.app,
            ...(this.dir && { dir: this.dir }),
            parts: [...this.chosen],
            replace: this.replace,
          })
          .then((r) => {
            this.status = `Imported ${summary(r as ImportResult)}.`;
            return this.current ? planImport(this.services, this.current) : null;
          })
          .then((p) => {
            this.plan = p;
            this.draw();
          })
          .catch((err: unknown) => {
            this.status = err instanceof Error ? err.message : String(err);
            this.draw();
          });
      }),
    );
    replaceChildren(
      this.body,
      header,
      from,
      h(
        "section",
        { class: "ai-section" },
        h(
          "div",
          { class: "ai-list" },
          settingsPart,
          keysPart,
          snippetsPart,
          mcpPart,
          extensionsPart,
        ),
        h(
          "label",
          { class: "vsimport-replace" },
          replace,
          h(
            "span",
            null,
            "Where we both have one, use theirs (settings, snippet files, MCP servers)",
          ),
        ),
      ),
      extList
        ? h(
            "section",
            { class: "ai-section" },
            h("h2", { class: "ai-section-title" }, "What becomes of their extensions"),
            h(
              "p",
              { class: "ai-section-lead" },
              "They install from Open VSX, the open registry of VS Code extensions; a few only Microsoft's marketplace has. Some of what they do is also built in here.",
            ),
            extList,
          )
        : null,
      h(
        "div",
        { class: "vsimport-actions" },
        h("span", { class: "vsimport-status", role: "status" }, this.status),
        go,
      ),
    );
  }

  serialize(): Json {
    return this.dir ? { dir: this.dir } : null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerEditorImport(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock } = services;
  const descriptor: DockViewDescriptor = {
    type: "vscodeImport",
    title: () => "Import from VS Code",
    icon: () => "download",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) =>
      new ImportView(
        services,
        state && typeof state === "object" && typeof (state as { dir?: unknown }).dir === "string"
          ? (state as { dir: string }).dir
          : undefined,
      ),
  };
  sub.add(dock.views.register(descriptor));
  sub.add(
    dispatcher.register({
      id: "settings.showImport",
      title: "Import from VS Code…",
      category: "Preferences",
      description:
        "Opens the Import from VS Code page: another editor's settings, keyboard shortcuts, snippets and MCP servers, and what becomes of its extensions here (VS Code, Insiders, Cursor, VSCodium, Windsurf).",
      input: s.object({
        dir: s.string().describe("A VS Code User folder to read instead").optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ dir }) => {
        const root = services.workspace.root.peek();
        const full = dir && root && !isAbsolute(dir) ? joinPath(root, dir) : dir;
        // A page already open on another source is replaced (one tab).
        for (const tab of dock.tabs("vscodeImport")) await dock.closeTab(tab.id, true);
        return { tabId: dock.openView("vscodeImport", full ? { dir: full } : null, "main", true) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "settings.importFromEditor",
      title: "Import from another editor",
      category: "Preferences",
      description:
        "Imports parts of another editor's setup (VS Code, Insiders, Cursor, VSCodium, Windsurf; `dir`: a User folder): settings, keybindings, snippets, mcp (its servers into the user mcp.json) and extensions (installed from Open VSX first, so their settings and shortcuts import too; the built-in replacements turned on). The user's own values are kept unless `replace`. Returns counts, and the extensions that didn't install.",
      input: s.object({
        app: s.string().describe("Which editor; default the first found").optional(),
        dir: s.string().describe("A User folder to read instead").optional(),
        parts: s.array(s.enum(IMPORT_PARTS)).describe("Default all").optional(),
        replace: s.boolean().describe("Theirs wins where both have a value").optional(),
        dryRun: s.boolean().describe("Only say what would change").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ app, dir, parts, replace, dryRun }) => {
        const found = await profiles(dir, services.workspace.root.peek());
        const profile = (app ? found.find((f) => f.app === app) : undefined) ?? found[0];
        if (!profile)
          throw new Error(
            dir
              ? `No settings found in ${dir}.`
              : "No VS Code, Cursor, VSCodium or Windsurf profile found on this computer.",
          );
        const plan = await planImport(services, profile);
        if (dryRun)
          return {
            app: plan.app,
            settings: {
              add: Object.keys(plan.settings.add),
              differs: Object.keys(plan.settings.differs),
              skipped: plan.settings.skipped.length,
            },
            keybindings: {
              add: plan.keybindings.rules.length,
              skipped: plan.keybindings.skipped.length,
            },
            snippets: plan.snippets.map((x) => x.name),
            mcp: Object.keys(plan.mcp.servers),
            extensions: plan.extensions.map((e) => ({ id: e.id, kind: e.fate.kind })),
          };
        const result = await applyImport(
          services,
          plan,
          parts ?? IMPORT_PARTS,
          replace === true,
          () => planImport(services, profile),
        );
        return { app: plan.app, ...result };
      },
    }),
  );
}
