// Third-party extensions (PLAN §9, D102): manifests (our extension.json, or a VS Code extension's
// package.json: its themes, grammars, snippets and languages, and its code behind the `vscode`
// shim, D256), the
// permission vocabulary, and the checks the host applies to every request an extension's worker
// makes. DOM-free and unit-tested.

import type { Effect } from "../dispatcher/types";
import type { KeybindingRule } from "../keybindings/index";
import { type ExtensionAuthor, parseAuthors } from "./authors";
import type { ManifestSetting } from "./index";
import {
  type ContributedDebugger,
  type ContributedTaskDefinition,
  parseWorkbenchContributions,
} from "./manifestWorkbench";
import { BLOCKED_SETTING_PREFIXES, isBlockedSetting, parseReadsSettings } from "./settingsAccess";
import {
  camelSegment,
  parseConfiguration,
  parseConfigurationDefaults,
  parseTerminalProfiles,
  parseVscodeKeybindings,
  restrictedConfigurations,
  VSCODE_PERMISSIONS,
  vscodeContributions,
} from "./vscodePackage";

/** What an extension may be granted (PLAN §9.2). `network:<domain>` narrows `network`. */
export const PERMISSIONS = {
  "fs.read": "Read files in the open folder",
  "fs.write": "Change files in the open folder",
  shell: "Run programs (terminals, tasks, its own processes)",
  terminal: "Use terminals",
  network: "Connect to the internet",
  git: "Use git (status, commits, branches)",
  github: "Use GitHub through your own gh sign-in (notifications, pull requests)",
  browser: "See and control browser tabs",
  agent: "Use the agent (chat, sessions)",
  clipboard: "Read and write the clipboard",
  "web.embed": "Show web pages inside its views",
  // D255: its code runs in Node (`"host": "node"`), outside the sandbox.
  node: "Run its code in Node.js, with access to your files and programs like any program",
} as const;

export type BasePermission = keyof typeof PERMISSIONS;

export interface ContributedCommand {
  id: string;
  title: string;
  category?: string;
  description?: string;
  /** What running it may do (default: none — a UI or read-only action). */
  effects?: Effect[];
  /** Offered to agents and MCP clients (default "discoverable"). */
  agent?: "discoverable" | "hidden";
  /** Off the command palette (a VS Code package's `"when": "false"` under commandPalette, D256). */
  palette?: false;
  /**
   * A VS Code package's command id when the dispatcher's differs ("markdown-preview.open" is
   * "markdownPreview.open", D256): what the extension's code registers and runs.
   */
  vscodeId?: string;
  /** A VS Code package's language model tool this command runs (D258: `lm.registerTool`). */
  vscodeTool?: string;
  /** A context-key clause (D208): the command is unavailable (and off the palette) while false. */
  when?: string;
  /**
   * A small JSON Schema of its input (D202; commandInput.ts turns it into the dispatcher's): agents
   * see the shape and the input is checked before the handler runs.
   */
  input?: Record<string, unknown>;
}

/**
 * A state path the extension's code fills (`ide.state.register`, D202): under
 * `ide://ext/<id>/`, or for an extension that comes with the IDE, a path of its own
 * ("ide://notebook") as long as nothing else has it.
 */
export interface ContributedState {
  path: string;
  description?: string;
}

export interface ContributedView {
  id: string;
  title: string;
  /**
   * "sidebar": a sidebar view (activity bar icon); "panel": a tab in the bottom panel; "editor":
   * a tab in the editor area (D176); "secondary": a tab on the right, beside the agent (VS Code's
   * secondary side bar, D260). Dock tabs can be moved anywhere, into a window of their own too.
   */
  location: "sidebar" | "panel" | "editor" | "secondary";
  /** "tree": data from `ide.ui.registerTreeView`; "webview": an HTML page of the extension. */
  type: "tree" | "webview";
  /** Icon name (the IDE's icon set), default "box". */
  icon?: string;
  /** An image of the extension for its icon (an SVG is drawn in the icon's color, as VS Code does). */
  iconPath?: string;
  /** Shown while this `when` clause holds (VS Code's views and containers, D260). */
  when?: string;
  /** webview: the page to show, relative to the extension folder. */
  path?: string;
  /** webview: its code writes the page (`ide.ui.webview(id).setHtml`; VS Code's webview views, D257). */
  codePage?: boolean;
  /**
   * A sidebar view that can live as a section of another sidebar view (D208): "scm.view"
   * (Source control) or "explorer.view", like Outline under the Explorer. It is a section
   * while hidden from the activity bar (the activity bar's menu moves it).
   */
  sectionOf?: string;
  /** Its place among that view's sections, top to bottom. */
  sectionOrder?: number;
  /** Always a section of `sectionOf` (a VS Code package's Explorer and Source control views). */
  sectionOnly?: boolean;
  /**
   * A VS Code package's view in a container it doesn't declare (another extension's, like Cell
   * Tags in Jupyter's panel): that container's id, looked up when the extension loads. Until
   * then, and when no enabled extension has it, the view is an Explorer section (VS Code's).
   */
  container?: string;
}

/** A VS Code package's view container (`contributes.viewsContainers`), for its own views and others'. */
export interface ContributedViewContainer {
  id: string;
  title: string;
  icon?: string;
  iconPath?: string;
  where: "activitybar" | "panel" | "secondarySidebar";
  when?: string;
}

/**
 * A keybinding. A VS Code package's rule for a command it doesn't declare keeps VS Code's id in
 * `vscodeCommand`, resolved when the extension loads (vscodePackage.ts).
 */
export type ContributedKeybinding = KeybindingRule & { vscodeCommand?: string };

/** A terminal profile an extension's code provides (D264). */
export interface ContributedTerminalProfile {
  id: string;
  title: string;
  /** An icon name of the IDE's set ("$(name)" in VS Code's). */
  icon?: string;
}

/** A command in a context menu (D176). */
export interface ContributedMenuItem {
  location:
    | "explorer/context"
    | "editor/context"
    | "editor/title"
    | "view/title"
    | "menubar/view"
    // A notebook's toolbar, a cell's toolbar ("…" without an icon), the kernel picker (D204).
    | "notebook/toolbar"
    | "notebook/cell/title"
    | "notebook/kernelSource"
    // A row of one of its tree views (VS Code's): `when` tests `view` and `viewItem` (the
    // item's `contextValue`); group "inline" puts it on the row as a button.
    | "view/item/context";
  /** One of the extension's own commands. */
  command: string;
  /** Default: the command's title. */
  title?: string;
  icon?: string;
  /** An image of the extension for its button, and the one for dark themes (D262). */
  iconPath?: string;
  iconPathDark?: string;
  when?: string;
  /** VS Code's menu group, with an optional `@order` ("navigation", "inline", "2_edit@1"). */
  group?: string;
}

/**
 * A viewer for files (VS Code's custom editors, D176): a webview page that opens files with
 * these extensions, gets their text and can save it back.
 */
/** A notebook file format the extension reads and writes (D202: `ide.notebooks.registerSerializer`). */
export interface ContributedNotebook {
  /** Its notebook type id (starts with the extension's id or prefix). */
  type: string;
  displayName: string;
  /** Lower-case, with the dot: [".toynb"]. */
  extensions: string[];
  /** Its files open in the notebook editor by default (else offered in Reopen with…). */
  default: boolean;
}

/**
 * An output renderer (D204, VS Code's `notebookRenderer`): the extension's script draws outputs of
 * these mime types inside the notebook's sandboxed output frame.
 */
export interface ContributedRenderer {
  /** Starts with the extension's id or prefix. */
  id: string;
  displayName: string;
  mimeTypes: string[];
  /** The script, relative to the extension folder (an ES module or `module.exports`). */
  entrypoint: string;
}

export interface ContributedViewer {
  id: string;
  title: string;
  /** Lower-case, with the dot: [".csv"]. */
  extensions: string[];
  /** Its page; absent with `codePage`. */
  path?: string;
  /**
   * Its code writes each tab's page (VS Code's custom editors, D257): the worker hears
   * `{ ide: "viewerOpened", path, instance }`, the page's messages as `{ ide: "viewerMessage",
   * instance, message }`, and sets the page with `setHtml(html, instance)`.
   */
  codePage?: boolean;
  /** Files open in it directly (otherwise it's offered as a preview / "Reopen with"). */
  default: boolean;
  icon?: string;
}

/** An agent (Agent Client Protocol over stdio) for the model menu (D176). */
export interface ContributedAgentDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

/** An MCP server whose tools the agent gets (D176). */
export interface ContributedMcpServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A model provider tile on the AI models page (the user connects it with a key, D176). */
export interface ContributedProviderDef {
  id: string;
  name: string;
  baseUrl: string;
  kind?: "openai" | "anthropic";
  needsKey: boolean;
  keyHint?: string;
  blurb?: string;
  defaultModel?: string;
}

export interface ContributedTheme {
  label: string;
  /** VS Code's "vs-dark" | "vs" | "hc-black" | "hc-light". */
  uiTheme: string;
  path: string;
}

/** A file icon theme (VS Code's `contributes.iconThemes`, D132). */
export interface ContributedIconTheme {
  id: string;
  label: string;
  path: string;
}

/** A product icon theme (VS Code's `contributes.productIconThemes`, D267). */
export type ContributedProductIconTheme = ContributedIconTheme;

export interface ContributedLanguage {
  id: string;
  extensions?: string[];
  filenames?: string[];
  aliases?: string[];
  /** Globs on the file name (or the path when they hold a `/`), VS Code's `filenamePatterns`. */
  filenamePatterns?: string[];
  /** A RegExp source tried on a file's first line (a shebang), VS Code's `firstLine`. */
  firstLine?: string;
  /** language-configuration.json (relative path, D200): comments, brackets, auto-closing… */
  configuration?: string;
}

export interface ContributedGrammar {
  language?: string;
  scopeName: string;
  path: string;
  /** An injection grammar: the scopes it's injected into (VS Code's `injectTo`). */
  injectTo?: string[];
  /** Scope → language id of embedded code (VS Code's `embeddedLanguages`). */
  embeddedLanguages?: Record<string, string>;
  /** Scope → "string" | "comment" | "other" (VS Code's `tokenTypes`). */
  tokenTypes?: Record<string, string>;
}

/**
 * VS Code's `contributes.semanticTokenScopes`: semantic token selectors ("type.modifier") mapped to
 * TextMate scopes the theme colors, for one language or all.
 */
export interface ContributedSemanticTokenScopes {
  language?: string;
  scopes: Record<string, string[]>;
}

/** VS Code's `contributes.semanticTokenTypes`: a custom token type and the type it falls back to. */
export interface ContributedSemanticTokenType {
  id: string;
  superType?: string;
}

export interface ContributedSnippets {
  language: string;
  path: string;
}

/**
 * A named problem matcher or pattern (VS Code's `contributes.problemMatchers` /
 * `problemPatterns`): tasks name it as "$name". The definition is kept as written; the tasks
 * system checks it (tasks/problemMatchers.ts).
 */
export interface ContributedProblemMatcher {
  name: string;
  definition: Record<string, unknown>;
}

export interface ContributedProblemPattern {
  name: string;
  /** One pattern object, or several (multi-line). */
  pattern: unknown;
}

export interface ExtensionScreenshot {
  path: string;
  caption?: string;
}

/** At most this many screenshots are read from a manifest. */
export const MAX_SCREENSHOTS = 12;

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;

function parseScreenshots(v: unknown): ExtensionScreenshot[] {
  const out: ExtensionScreenshot[] = [];
  for (const item of arr(v)) {
    const path = relPath(typeof item === "string" ? item : obj(item).path);
    // A file of the extension: no URLs (pages show nothing remote).
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || !IMAGE_FILE.test(path)) continue;
    if (out.some((s) => s.path === path)) continue;
    const caption = typeof item === "string" ? undefined : str(obj(item).caption);
    out.push({ path, ...(caption && { caption: caption.slice(0, 200) }) });
    if (out.length >= MAX_SCREENSHOTS) break;
  }
  return out;
}

export interface ThirdPartyManifest {
  id: string;
  version: string;
  displayName: string;
  description: string;
  publisher: string;
  /** Worker code (relative path); declarative-only extensions have none. */
  main?: string;
  /** A PNG/SVG for the Extensions view (relative path). */
  icon?: string;
  /** An icon from the IDE's own set ("rocket"), when `icon` names one instead of a file (D176). */
  iconName?: string;
  /**
   * Pictures of it at work (D190): files of the extension (PNG, JPEG, GIF, WebP, SVG), shown on
   * its page. `"screenshots": ["screenshots/1.png", { "path": "…", "caption": "…" }]`.
   */
  screenshots: ExtensionScreenshot[];
  /** About it (D176): shown in the extension page's side panel. */
  author?: string;
  /** Who made it, like a repository's contributors (D185): `authors`, else `author`. */
  authors: ExtensionAuthor[];
  repository?: string;
  homepage?: string;
  license?: string;
  categories: string[];
  keywords: string[];
  activation: string[];
  permissions: string[];
  /**
   * Settings beyond its own and editor/workbench/files ones that its code reads (D202): keys or
   * "prefix.*" (settingsAccess.ts; credentials' areas are refused).
   */
  readsSettings: string[];
  /**
   * Built-in namespaces its commands, views and settings may use besides its own prefix (D208:
   * the Git tools extension keeps `git.lineHistory`). Only for extensions that come with the IDE:
   * the manifest of any other is refused, and the host checks it ships with the IDE.
   */
  namespaces: string[];
  /** Where the manifest came from: our format, or a VS Code extension's package.json. */
  format: "ide" | "vscode";
  /**
   * Where its code runs (D255): the sandboxed worker (default), or a Node process
   * (`"host": "node"`, with the "node" permission) for npm packages, files and programs.
   */
  host?: "node";
  /**
   * A VS Code package with code (D256): first segments of the context keys its code may set
   * besides "<id>." ("gitlens" for "gitlens:enabled"), from its commands, settings and views.
   */
  contextNamespaces?: string[];
  /** Bare context keys a VS Code package's `when` clauses test (vscodePackage.ts). */
  contextKeys?: string[];
  /** What a VS Code package declares that the IDE leaves out: logged when it loads. */
  warnings?: string[];
  contributes: {
    commands: ContributedCommand[];
    keybindings: ContributedKeybinding[];
    settings: Record<string, ManifestSetting>;
    /**
     * A VS Code package's defaults for settings, its own or others' (VS Code's
     * `configurationDefaults`): plain keys and `[language]` blocks.
     */
    configurationDefaults?: Record<string, unknown>;
    views: ContributedView[];
    /** A VS Code package's view containers (its views' and other extensions'). */
    viewContainers?: ContributedViewContainer[];
    themes: ContributedTheme[];
    iconThemes: ContributedIconTheme[];
    /** Product icon themes (D267): fonts that redraw the workbench's icons. */
    productIconThemes?: ContributedProductIconTheme[];
    languages: ContributedLanguage[];
    grammars: ContributedGrammar[];
    semanticTokenScopes?: ContributedSemanticTokenScopes[];
    semanticTokenTypes?: ContributedSemanticTokenType[];
    snippets: ContributedSnippets[];
    problemMatchers: ContributedProblemMatcher[];
    problemPatterns: ContributedProblemPattern[];
    /** Commands offered to agents as tools (they need `agent: "discoverable"`). */
    agentTools: string[];
    /**
     * Terminal profiles its code provides (VS Code's `contributes.terminal.profiles`, D264): in
     * the terminal's profile menu before its code runs; picking one asks its provider.
     */
    terminalProfiles?: ContributedTerminalProfile[];
    menus: ContributedMenuItem[];
    viewers: ContributedViewer[];
    notebooks: ContributedNotebook[];
    /** Output renderers for notebooks (D204). */
    notebookRenderers: ContributedRenderer[];
    agents: ContributedAgentDef[];
    mcpServers: ContributedMcpServerDef[];
    modelProviders: ContributedProviderDef[];
    state: ContributedState[];
    /** Task types its code provides (D233). */
    taskDefinitions: ContributedTaskDefinition[];
    /** Debug types its code supplies adapters for (D233). */
    debuggers: ContributedDebugger[];
  };
}

const ID = /^[a-z0-9][a-z0-9-_]*(\.[a-z0-9][a-z0-9-_]*)+$/;
const REL_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(^|[\\/])\.\.([\\/]|$)).+$/;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const relPath = (v: unknown): string | undefined => {
  const p = str(v)?.replace(/^\.\//, "");
  return p && REL_PATH.test(p) ? p : undefined;
};

/** Built-in namespaces an extension can't use as its short prefix (it uses its full id instead). */
const RESERVED = new Set([
  "accounts",
  "debug",
  "jupyter",
  "notebook",
  "testing",
  "ai",
  "http",
  "agent",
  "browser",
  "edit",
  "editor",
  "explorer",
  "extensions",
  "file",
  "files",
  "git",
  "history",
  "keybindings",
  "layout",
  "lsp",
  "mcp",
  "palette",
  "quickOpen",
  "search",
  "settings",
  "tasks",
  "terminal",
  "ui",
  "view",
  "viewers",
  "workbench",
  "workspace",
  "dev",
  "notifications",
]);

/**
 * Reserved namespaces their VS Code owner (by publisher) still uses, as it does in VS Code:
 * Microsoft's Jupyter (ms-toolsai.jupyter) has its jupyter.* settings, commands and context keys.
 */
const VSCODE_OWNERS: Record<string, readonly string[]> = {
  jupyter: [
    "ms-toolsai.jupyter",
    "ms-toolsai.jupyter-renderers",
    "ms-toolsai.jupyter-keymap",
    "ms-toolsai.vscode-jupyter-cell-tags",
    "ms-toolsai.vscode-jupyter-slideshow",
  ],
};

/**
 * Why a VS Code package can't declare setting `key`, if it can't. VS Code reserves no names, so
 * only the IDE's areas that hold credentials and say where requests go (the agent, AI, MCP,
 * accounts, proxies, language servers' commands) are refused; any other key is the first
 * declarer's, shared with later ones (ExtensionRuntime).
 */
function refuseVscodeSetting(key: string): string | undefined {
  return BLOCKED_SETTING_PREFIXES.some((p) => key.startsWith(p))
    ? `the "${key.split(".")[0]}" settings are the IDE's own (they hold credentials or start programs).`
    : undefined;
}

/** Whether `name` is reserved for the extension `id`. */
const reservedFor = (id: string) => (name: string) =>
  RESERVED.has(name) && !VSCODE_OWNERS[name]?.includes(id);

/** The prefixes an extension's commands, views and settings may use: "<id>." and "<name>.". */
function prefixes(id: string): string[] {
  const name = id.split(".").pop() ?? id;
  // Command ids are camelCase ("todoHighlighter.run" for "acme.todo-highlighter").
  const camel = name.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  // The IDE's own extensions (`bundled.jupyter`) keep their short name ("jupyter.") even when it's
  // reserved for everyone else; which of them may claim core files is checked when they run.
  const short = [...new Set([name, camel])]
    .filter((n) => id.startsWith("bundled.") || !reservedFor(id)(n))
    .map((n) => `${n}.`);
  return [`${id}.`, ...short];
}

/** Command ids the dispatcher accepts ("namespace.verb", camelCase segments). */
const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** The short prefix new commands should use ("todoList" for "acme.todo-list"; the full id when reserved). */
export function commandPrefix(id: string): string {
  const all = prefixes(id);
  return (all[all.length - 1] ?? `${id}.`).slice(0, -1);
}

function ownsName(id: string, name: string, namespaces: readonly string[] = []): boolean {
  return [...prefixes(id), ...namespaces.map((n) => `${n}.`)].some(
    (p) => name.startsWith(p) && name.length > p.length,
  );
}

/**
 * Whether `name` (a command, view or setting) is in one of the built-in namespaces the manifest
 * claims rather than under its own prefix (D208): the host only allows that for an extension that
 * ships with the IDE.
 */
export function inClaimedNamespace(manifest: ThirdPartyManifest, name: string): boolean {
  return !ownsName(manifest.id, name) && ownsName(manifest.id, name, manifest.namespaces);
}

const NAMESPACE = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Whether extension `id` may change setting `key` (`settings.set` / `settings.reset`, which only
 * need "fs.write"): its own settings, and others a folder's settings could set too. Never the
 * user-only ones (`scope: "user"`: they start programs, pick shells and servers, say where the
 * network goes) nor the areas it can't even read (credentials, the agent, MCP, language
 * servers): that would turn "change files" into running any program.
 */
export function extensionMayWriteSetting(
  id: string,
  key: string,
  scope: "user" | "workspace" | "both" | undefined,
  /**
   * The extensions that declared the setting (the registering one, then any that share it, as two
   * VS Code packages can), if any did.
   */
  owner?: string | readonly string[],
): boolean {
  const owners = owner === undefined ? [] : typeof owner === "string" ? [owner] : owner;
  // One of the extensions that declared it may change it (VS Code's shared settings).
  if (owners.includes(id)) return true;
  // Its own name only when no other extension registered the key (D261: "evil.python" isn't the
  // owner of the Python extension's "python." settings).
  if (ownsName(id, key) && !owners.length) return true;
  if (isBlockedSetting(key)) return false;
  return scope !== "user";
}

/** True for a permission we know (`network:<domain>` included). */
export function isPermission(p: string): boolean {
  if (p in PERMISSIONS) return true;
  return /^network:(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(p);
}

/** Human description of a permission (install dialog). */
export function describePermission(p: string): string {
  if (p.startsWith("network:")) return `Connect to ${p.slice(8)}`;
  return PERMISSIONS[p as BasePermission] ?? p;
}

/**
 * Reads a manifest: our extension.json, or a VS Code extension's package.json (`nls`: its
 * package.nls.json resolved first). A VS Code package with code (`main`) runs in the Node host
 * behind the `vscode` shim with its commands, settings, views and menus (D256); without code,
 * only its declarative parts are used. Throws a readable error listing what is wrong.
 */
export function parseManifest(value: unknown, file: string): ThirdPartyManifest {
  const m = obj(value);
  const errors: string[] = [];
  const vscode = file === "package.json";
  const c = obj(m.contributes);
  const publisher = str(m.publisher) ?? "";
  const rawId = vscode ? `${publisher}.${str(m.name) ?? ""}`.toLowerCase() : (str(m.id) ?? "");
  // D256: a VS Code package with code; its contributions come in the IDE's shapes.
  // What a VS Code package declares that the IDE leaves out, for the extension's log.
  const warnings: string[] = [];
  const code =
    vscode && relPath(m.main)
      ? vscodeContributions(
          m,
          camelSegment(str(m.name) ?? "") || "ext",
          reservedFor(rawId),
          refuseVscodeSetting,
          warnings,
        )
      : undefined;
  // Its publisher's namespaces are its context keys' too (ms-toolsai's "jupyter:showTagsExplorer").
  if (code)
    for (const [ns, owner] of Object.entries(VSCODE_OWNERS))
      if (owner.includes(rawId) && !code.contextNamespaces.includes(ns))
        code.contextNamespaces.push(ns);
  if (!ID.test(rawId))
    errors.push(
      vscode
        ? `package.json needs "publisher" and "name" (got ${JSON.stringify(rawId)})`
        : `invalid id ${JSON.stringify(rawId)} (expected "publisher.name", lowercase)`,
    );
  const version = str(m.version);
  if (!version) errors.push("missing version");
  // Built-in namespaces it may use (D208): only the IDE's own extensions.
  const namespaces = vscode
    ? []
    : arr(m.namespaces).filter((n): n is string => typeof n === "string" && NAMESPACE.test(n));
  if (!vscode && m.namespaces !== undefined) {
    if (!rawId.startsWith("bundled."))
      errors.push(`"namespaces": only extensions that come with the IDE may claim namespaces`);
    else if (namespaces.length !== arr(m.namespaces).length || namespaces.length > 5)
      errors.push(`"namespaces": at most 5 names like "git"`);
  }
  const owns = (name: string) => ownsName(rawId, name, namespaces);
  // Fields people (and models) reach for from other formats.
  if (!vscode && typeof m.name === "string" && !m.displayName)
    errors.push(`"name" isn't a field: use "displayName" for the name shown`);
  if (!vscode && m.scripts !== undefined)
    errors.push(`"scripts" isn't a field: name the code's file in "main"`);
  const permissions = code
    ? [...VSCODE_PERMISSIONS]
    : vscode
      ? []
      : arr(m.permissions).filter((p): p is string => typeof p === "string");
  for (const p of permissions) if (!isPermission(p)) errors.push(`unknown permission "${p}"`);
  // D255: the Node host is asked for by name and allowed by its permission.
  if (!vscode && m.host !== undefined && m.host !== "node" && m.host !== "worker")
    errors.push(`"host" is "worker" (the default) or "node"`);
  if (!vscode && m.host === "node" && !permissions.includes("node"))
    errors.push(`"host": "node" needs the "node" permission`);
  const main = vscode && !code ? undefined : relPath(m.main);
  if (!vscode && m.main !== undefined && !main)
    errors.push(`"main" must be a path inside the extension`);

  const commands: ContributedCommand[] = vscode
    ? (code?.commands ?? [])
    : arr(c.commands).flatMap((raw) => {
        const cmd = obj(raw);
        const id = str(cmd.id) ?? str(cmd.command);
        const title = str(cmd.title);
        if (!id || !title) {
          errors.push("each command needs id and title");
          return [];
        }
        if (!owns(id)) errors.push(`command ${id} must start with ${prefixes(rawId).join(" or ")}`);
        else if (!COMMAND_ID.test(id))
          errors.push(`command ${id}: use camelCase segments separated by dots`);
        const effects = arr(cmd.effects).filter((e): e is Effect =>
          ["read", "write", "exec", "network", "destructive"].includes(e as string),
        );
        const input = cmd.input && typeof cmd.input === "object" ? obj(cmd.input) : undefined;
        if (cmd.input !== undefined && !input)
          errors.push(`command ${id}: input must be a schema object`);
        return [
          {
            id,
            title,
            ...(input && { input }),
            ...(str(cmd.category) && { category: str(cmd.category) }),
            ...(str(cmd.description) && { description: str(cmd.description) }),
            ...(effects.length && { effects }),
            ...(str(cmd.when) && { when: str(cmd.when) }),
            agent: cmd.agent === "hidden" ? ("hidden" as const) : ("discoverable" as const),
          },
        ];
      });
  const views: ContributedView[] = vscode
    ? (code?.views ?? [])
    : arr(c.views).flatMap((raw) => {
        const v = obj(raw);
        const id = str(v.id);
        const title = str(v.title);
        const location =
          v.location === "panel" ||
          v.location === "sidebar" ||
          v.location === "editor" ||
          v.location === "secondary"
            ? v.location
            : null;
        const type =
          v.type === "webview"
            ? "webview"
            : v.type === "tree" || v.type === undefined
              ? "tree"
              : null;
        if (id && !owns(id))
          errors.push(`view ${id} must start with ${prefixes(rawId).join(" or ")}`);
        const sectionOf = str(v.sectionOf);
        if (sectionOf && (location !== "sidebar" || !/^[a-z][\w.-]*$/.test(sectionOf)))
          errors.push(
            `view ${id ?? "?"}: sectionOf needs a sidebar view and a view id ("scm.view")`,
          );
        if (!id || !title || !location || !type) {
          errors.push(
            `view ${id ?? "?"}: needs id, title, location (sidebar|panel|editor|secondary), type (tree|webview)`,
          );
          return [];
        }
        const path = relPath(v.path);
        // D257: or its code writes the page (`ide.ui.webview(id).setHtml`).
        const codePage = type === "webview" && v.codePage === true;
        if (type === "webview" && !path && !codePage)
          errors.push(`view ${id}: a webview needs "path" (an HTML file) or "codePage": true`);
        return [
          {
            id,
            title,
            location,
            type,
            ...(str(v.icon) && { icon: str(v.icon) }),
            ...(relPath(v.iconPath) && { iconPath: relPath(v.iconPath) }),
            ...(str(v.when)?.trim() && { when: str(v.when)?.trim() }),
            ...(path && !codePage && { path }),
            ...(codePage && { codePage: true }),
            ...(sectionOf && location === "sidebar" && { sectionOf }),
            ...(typeof v.sectionOrder === "number" &&
              Number.isFinite(v.sectionOrder) && { sectionOrder: v.sectionOrder }),
          },
        ];
      });
  const themes = arr(c.themes).flatMap((raw): ContributedTheme[] => {
    const t = obj(raw);
    const path = relPath(t.path);
    const label = str(t.label) ?? str(t.id);
    if (!path || !label) return [];
    return [{ label, uiTheme: str(t.uiTheme) ?? "vs-dark", path }];
  });
  const iconThemes = arr(c.iconThemes).flatMap((raw): ContributedIconTheme[] => {
    const t = obj(raw);
    const path = relPath(t.path);
    const id = str(t.id);
    if (!path || !id) return [];
    return [{ id, label: str(t.label) ?? id, path }];
  });
  const productIconThemes = arr(c.productIconThemes).flatMap(
    (raw): ContributedProductIconTheme[] => {
      const t = obj(raw);
      const path = relPath(t.path);
      const id = str(t.id);
      if (!path || !id) return [];
      return [{ id, label: str(t.label) ?? id, path }];
    },
  );
  const languages = arr(c.languages).flatMap((raw): ContributedLanguage[] => {
    const l = obj(raw);
    const id = str(l.id);
    if (!id) return [];
    const strings = (v: unknown) => arr(v).filter((x): x is string => typeof x === "string");
    return [
      {
        id,
        ...(strings(l.extensions).length && { extensions: strings(l.extensions) }),
        ...(strings(l.filenames).length && { filenames: strings(l.filenames) }),
        ...(strings(l.aliases).length && { aliases: strings(l.aliases) }),
        ...(strings(l.filenamePatterns).length && {
          filenamePatterns: strings(l.filenamePatterns),
        }),
        ...(str(l.firstLine) && { firstLine: str(l.firstLine) }),
        ...(relPath(l.configuration) && { configuration: relPath(l.configuration) }),
      },
    ];
  });
  // Scope → string maps (embeddedLanguages, tokenTypes), strings only.
  const stringMap = (v: unknown): Record<string, string> | undefined => {
    const entries = Object.entries(obj(v)).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const grammars = arr(c.grammars).flatMap((raw): ContributedGrammar[] => {
    const g = obj(raw);
    const path = relPath(g.path);
    const scopeName = str(g.scopeName);
    if (!path || !scopeName) return [];
    const injectTo = arr(g.injectTo).filter((x): x is string => typeof x === "string");
    const embeddedLanguages = stringMap(g.embeddedLanguages);
    const tokenTypes = stringMap(g.tokenTypes);
    return [
      {
        scopeName,
        path,
        ...(str(g.language) && { language: str(g.language) }),
        ...(injectTo.length && { injectTo }),
        ...(embeddedLanguages && { embeddedLanguages }),
        ...(tokenTypes && { tokenTypes }),
      },
    ];
  });
  const semanticTokenScopes = arr(c.semanticTokenScopes).flatMap(
    (raw): ContributedSemanticTokenScopes[] => {
      const e = obj(raw);
      const scopes = Object.fromEntries(
        Object.entries(obj(e.scopes)).flatMap(([selector, list]) => {
          const names = arr(list).filter((x): x is string => typeof x === "string");
          return names.length ? [[selector, names]] : [];
        }),
      );
      if (!Object.keys(scopes).length) return [];
      return [{ ...(str(e.language) && { language: str(e.language) }), scopes }];
    },
  );
  const semanticTokenTypes = arr(c.semanticTokenTypes).flatMap(
    (raw): ContributedSemanticTokenType[] => {
      const t = obj(raw);
      const id = str(t.id);
      if (!id) return [];
      return [{ id, ...(str(t.superType) && { superType: str(t.superType) }) }];
    },
  );
  const snippets = arr(c.snippets).flatMap((raw): ContributedSnippets[] => {
    const s = obj(raw);
    const path = relPath(s.path);
    const language = str(s.language);
    return path && language ? [{ language, path }] : [];
  });
  // Declarative in both formats (a VS Code extension's matchers work as they are).
  const MATCHER_NAME = /^[\w.-]{1,60}$/;
  const problemMatchers = arr(c.problemMatchers)
    .slice(0, 50)
    .flatMap((raw): ContributedProblemMatcher[] => {
      const { name, ...definition } = obj(raw);
      return typeof name === "string" && MATCHER_NAME.test(name) ? [{ name, definition }] : [];
    });
  const problemPatterns = arr(c.problemPatterns)
    .slice(0, 50)
    .flatMap((raw): ContributedProblemPattern[] => {
      const p = obj(raw);
      const name = p.name;
      if (typeof name !== "string" || !MATCHER_NAME.test(name)) return [];
      // `patterns` (several lines) or the pattern's own fields.
      const { name: _name, patterns, ...single } = p;
      return [{ name, pattern: Array.isArray(patterns) ? patterns : single }];
    });
  // A VS Code package without code binds keys too (Jupyter Keymap: VS Code's own commands).
  const keybindings: ContributedKeybinding[] = vscode
    ? (code?.keybindings ?? parseVscodeKeybindings(c, () => undefined))
    : arr(c.keybindings).flatMap((raw): KeybindingRule[] => {
        const k = obj(raw);
        const key = str(k.key);
        const command = str(k.command);
        if (!key || !command) return [];
        if (!commands.some((cmd) => cmd.id === command))
          errors.push(`keybinding ${key}: ${command} isn't one of the extension's commands`);
        return [
          {
            key,
            command,
            ...(str(k.mac) && { mac: str(k.mac) }),
            ...(str(k.when) && { when: str(k.when) }),
          } as KeybindingRule,
        ];
      });
  // A VS Code package's settings, with or without code (D257: a theme's options too).
  const settings: Record<string, ManifestSetting> = vscode
    ? (code?.settings ??
      parseConfiguration(
        c.configuration,
        refuseVscodeSetting,
        warnings,
        restrictedConfigurations(m),
      ))
    : {};
  if (!vscode)
    for (const [key, raw] of Object.entries(obj(c.settings))) {
      const s = obj(raw);
      if (!owns(key)) {
        errors.push(`setting ${key} must start with ${prefixes(rawId).join(" or ")}`);
        continue;
      }
      if (typeof s.type !== "string") continue;
      settings[key] = s as unknown as ManifestSetting;
    }
  const defaults = vscode ? parseConfigurationDefaults(c.configurationDefaults) : {};
  const configurationDefaults = Object.keys(defaults).length ? defaults : undefined;
  const agentTools = vscode
    ? (code?.agentTools ?? [])
    : arr(c.agentTools).filter((t): t is string => typeof t === "string");
  const terminalProfiles = vscode
    ? (code?.terminalProfiles ?? [])
    : parseTerminalProfiles(c.terminalProfiles);

  const extra = vscode
    ? {
        menus: code?.menus ?? [],
        viewers: code?.viewers ?? [],
        notebooks: code?.notebooks ?? [],
        notebookRenderers: code?.notebookRenderers ?? [],
        agents: [],
        mcpServers: [],
        modelProviders: [],
      }
    : parseMoreContributions(c, rawId, commands, permissions, errors);
  const readsSettings = vscode ? [] : parseReadsSettings(m.readsSettings, errors);
  const state = vscode ? [] : parseStateContributions(c.state, rawId, errors);
  // A VS Code extension's code doesn't run here: nothing would provide them.
  // A VS Code package without code: nothing would provide them.
  const workbench = vscode
    ? {
        taskDefinitions: code?.taskDefinitions ?? [],
        debuggers: code?.debuggers ?? [],
      }
    : parseWorkbenchContributions(c, errors);

  if (errors.length) throw new Error(`${rawId || file}: ${errors.join("; ")}`);
  const iconValue = str(m.icon);
  // "rocket": an icon of the IDE's set; "icon.png": a file of the extension.
  const iconName = iconValue && /^[a-z][a-z0-9-]*$/.test(iconValue) ? iconValue : undefined;
  const textOf = (v: unknown) => str(v) ?? str(obj(v).name) ?? str(obj(v).url);
  const strings = (v: unknown) =>
    arr(v)
      .filter((x): x is string => typeof x === "string")
      .slice(0, 12);
  return {
    id: rawId,
    version: version ?? "0.0.0",
    displayName: str(m.displayName) ?? str(m.name) ?? rawId,
    description: str(m.description) ?? "",
    publisher: publisher || rawId.split(".")[0] || "",
    ...(main && { main }),
    ...(!iconName && relPath(m.icon) && { icon: relPath(m.icon) }),
    ...(iconName && { iconName }),
    screenshots: vscode ? [] : parseScreenshots(m.screenshots),
    ...(textOf(m.author) && { author: textOf(m.author) }),
    authors: parseAuthors(m),
    ...(textOf(m.repository) && { repository: textOf(m.repository) }),
    ...(str(m.homepage) && { homepage: str(m.homepage) }),
    ...(str(m.license) && { license: str(m.license) }),
    categories: strings(m.categories),
    keywords: strings(m.keywords),
    // VS Code's field name works too (D255: a manifest written the VS Code way).
    activation: vscode
      ? (code?.activation ?? [])
      : arr(m.activation ?? m.activationEvents).filter((a): a is string => typeof a === "string"),
    permissions,
    readsSettings,
    namespaces,
    format: vscode ? "vscode" : "ide",
    ...(((!vscode && m.host === "node") || code) && { host: "node" as const }),
    ...(code && { contextNamespaces: code.contextNamespaces, contextKeys: code.contextKeys }),
    ...(warnings.length && { warnings: warnings.slice(0, 50) }),
    contributes: {
      commands,
      keybindings,
      settings,
      ...(configurationDefaults && { configurationDefaults }),
      views,
      ...(code?.viewContainers.length && { viewContainers: code.viewContainers }),
      themes,
      iconThemes,
      ...(productIconThemes.length && { productIconThemes }),
      languages,
      grammars,
      ...(semanticTokenScopes.length && { semanticTokenScopes }),
      ...(semanticTokenTypes.length && { semanticTokenTypes }),
      snippets,
      problemMatchers,
      problemPatterns,
      agentTools,
      ...(terminalProfiles.length && { terminalProfiles }),
      ...extra,
      state,
      ...workbench,
    },
  };
}

/** The state namespace every extension owns: `ide://ext/<id>`. */
export function ownStatePrefix(id: string): string {
  return `ide://ext/${id}`;
}

/** Whether `path` is the extension's own (`ide://ext/<id>` or under it). */
export function ownsStatePath(id: string, path: string): boolean {
  const own = ownStatePrefix(id);
  return path === own || path.startsWith(`${own}/`);
}

const STATE_PATH = /^ide:\/\/[a-z][\w.-]*(\/[\w.-]+)*$/;

/** `contributes.state`: paths (or { path, description }); only bundled ones may claim others. */
function parseStateContributions(v: unknown, id: string, errors: string[]): ContributedState[] {
  const out: ContributedState[] = [];
  for (const raw of arr(v).slice(0, 20)) {
    const path = typeof raw === "string" ? raw : str(obj(raw).path);
    if (!path || !STATE_PATH.test(path)) {
      errors.push(`state: ${JSON.stringify(path ?? raw)} isn't an ide:// path`);
      continue;
    }
    if (!ownsStatePath(id, path) && !id.startsWith("bundled.")) {
      errors.push(`state ${path}: an extension's state goes under ${ownStatePrefix(id)}/`);
      continue;
    }
    const description = typeof raw === "string" ? undefined : str(obj(raw).description);
    out.push({ path, ...(description && { description: description.slice(0, 500) }) });
  }
  return out;
}

/** Names of the built-in model providers an extension's tile mustn't pass for (a fake "OpenAI"). */
const BUILT_IN_PROVIDER_NAMES =
  // Also a name that starts with one ("Anthropic API", "OpenAI (fast)"): no posing as them.
  /^(anthropic|openai|google( gemini)?|gemini|xai|openrouter|groq|ollama|lm ?studio|llama\.cpp|mistral|deepseek|together|fireworks|cerebras|hugging ?face|nvidia|kimi|moonshot|qwen|z\.ai|azure|amazon|aws|bedrock|vllm)\b/i;

/** Menus, viewers, agents, MCP servers and model providers (D176). */
function parseMoreContributions(
  c: Record<string, unknown>,
  id: string,
  commands: readonly ContributedCommand[],
  permissions: readonly string[],
  errors: string[],
): Pick<
  ThirdPartyManifest["contributes"],
  | "menus"
  | "viewers"
  | "notebooks"
  | "notebookRenderers"
  | "agents"
  | "mcpServers"
  | "modelProviders"
> {
  const strings = (v: unknown) => arr(v).filter((x): x is string => typeof x === "string");
  const env = (v: unknown): Record<string, string> | undefined => {
    const entries = Object.entries(obj(v)).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  // "menubar/view": the menu bar's View → Extensions submenu (D181), for a command that opens
  // the extension's tool when it has no view of its own to list there.
  const LOCATIONS = [
    "explorer/context",
    "editor/context",
    "editor/title",
    "view/title",
    "menubar/view",
    "notebook/toolbar",
    "notebook/cell/title",
    "notebook/kernelSource",
    "view/item/context",
  ] as const;
  const menus: ContributedMenuItem[] = [];
  // VS Code's shape ({ "explorer/context": [items] }) or a list of items with a `location`.
  const groups: [string, unknown[]][] = Array.isArray(c.menus)
    ? arr(c.menus).map((raw) => [str(obj(raw).location) ?? "?", [raw]])
    : Object.entries(obj(c.menus)).map(([location, list]) => [location, arr(list)]);
  for (const [location, list] of groups) {
    if (!(LOCATIONS as readonly string[]).includes(location)) {
      errors.push(`menus: unknown location "${location}" (${LOCATIONS.join(", ")})`);
      continue;
    }
    for (const raw of list) {
      const item = obj(raw);
      const command = str(item.command);
      if (!command || !commands.some((x) => x.id === command)) {
        errors.push(`menus.${location}: ${command ?? "?"} isn't one of the extension's commands`);
        continue;
      }
      menus.push({
        location: location as ContributedMenuItem["location"],
        command,
        ...(str(item.title) && { title: str(item.title) }),
        ...(str(item.icon) && { icon: str(item.icon) }),
        ...(str(item.when) && { when: str(item.when) }),
        ...(str(item.group) && { group: str(item.group)?.slice(0, 60) }),
      });
    }
  }
  const viewers = arr(c.viewers).flatMap((raw): ContributedViewer[] => {
    const v = obj(raw);
    const viewerId = str(v.id);
    const title = str(v.title);
    const path = relPath(v.path);
    const extensions = strings(v.extensions)
      .map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase())
      .filter((e) => /^\.[a-z0-9._-]+$/.test(e));
    // D257: a viewer whose code writes each tab's page has no file.
    const codePage = v.codePage === true;
    if (!viewerId || !title || (!path && !codePage) || !extensions.length) {
      errors.push(
        `viewer ${viewerId ?? "?"}: needs id, title, path (an HTML file) or "codePage": true, and extensions`,
      );
      return [];
    }
    if (!ownsName(id, viewerId))
      errors.push(`viewer ${viewerId} must start with ${prefixes(id).join(" or ")}`);
    return [
      {
        id: viewerId,
        title,
        extensions,
        ...(codePage ? { codePage: true } : path && { path }),
        default: v.default === true,
        ...(str(v.icon) && { icon: str(v.icon) }),
      },
    ];
  });
  // Agents and MCP servers are programs the IDE starts: they need the user to allow both.
  const runsPrograms = permissions.includes("shell") && permissions.includes("agent");
  const program = (raw: unknown, what: string) => {
    const p = obj(raw);
    const name = str(p.name);
    const command = str(p.command);
    if (!name || !command) {
      errors.push(`${what}: each needs name and command`);
      return null;
    }
    if (!runsPrograms) {
      errors.push(`${what} ${name}: needs the "shell" and "agent" permissions (it runs a program)`);
      return null;
    }
    return {
      name: name.slice(0, 60),
      command,
      ...(strings(p.args).length && { args: strings(p.args) }),
      ...(env(p.env) && { env: env(p.env) }),
    };
  };
  const agents = arr(c.agents).flatMap((raw): ContributedAgentDef[] => {
    const p = program(raw, "agent");
    const description = str(obj(raw).description);
    return p ? [{ ...p, ...(description && { description }) }] : [];
  });
  // `{ "name": { command, args } }` (agent.mcpServers' shape) or a list with names.
  const mcpRaw = Array.isArray(c.mcpServers)
    ? c.mcpServers
    : Object.entries(obj(c.mcpServers)).map(([name, v]) => ({ ...obj(v), name }));
  const mcpServers = arr(mcpRaw).flatMap((raw): ContributedMcpServerDef[] => {
    const p = program(raw, "MCP server");
    return p ? [p] : [];
  });
  const modelProviders = arr(c.modelProviders).flatMap((raw): ContributedProviderDef[] => {
    const p = obj(raw);
    const providerId = str(p.id);
    const name = str(p.name);
    const baseUrl = str(p.baseUrl);
    if (!providerId || !name || !baseUrl) {
      errors.push("modelProviders: each needs id, name and baseUrl");
      return [];
    }
    let url: URL | null = null;
    try {
      url = new URL(baseUrl);
    } catch {
      url = null;
    }
    const local = url && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
    if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
      errors.push(`modelProviders ${providerId}: baseUrl must be https (or http on this computer)`);
      return [];
    }
    if (BUILT_IN_PROVIDER_NAMES.test(name.trim())) {
      errors.push(`modelProviders ${providerId}: "${name}" is a built-in provider's name`);
      return [];
    }
    if (!permissions.includes("agent")) {
      errors.push(`modelProviders ${providerId}: needs the "agent" permission`);
      return [];
    }
    return [
      {
        id: providerId.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        name: name.slice(0, 40),
        baseUrl,
        ...(p.kind === "anthropic" && { kind: "anthropic" as const }),
        needsKey: p.needsKey !== false,
        ...(str(p.keyHint) && { keyHint: str(p.keyHint) }),
        ...(str(p.blurb) && { blurb: str(p.blurb)?.slice(0, 80) }),
        ...(str(p.defaultModel) && { defaultModel: str(p.defaultModel) }),
      },
    ];
  });
  const notebooks = arr(c.notebooks).flatMap((raw): ContributedNotebook[] => {
    const n = obj(raw);
    const type = str(n.type);
    const displayName = str(n.displayName) ?? str(n.title);
    const extensions = strings(n.extensions)
      .map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase())
      .filter((e) => /^\.[a-z0-9._-]+$/.test(e));
    if (!type || !displayName || !extensions.length) {
      errors.push(`notebook ${type ?? "?"}: needs type, displayName and extensions`);
      return [];
    }
    if (!ownsName(id, type)) {
      errors.push(`notebook ${type} must start with ${prefixes(id).join(" or ")}`);
      return [];
    }
    return [
      { type, displayName: displayName.slice(0, 60), extensions, default: n.default === true },
    ];
  });
  const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
  const notebookRenderers = arr(c.notebookRenderers).flatMap((raw): ContributedRenderer[] => {
    const r = obj(raw);
    const rendererId = str(r.id);
    const displayName = str(r.displayName) ?? rendererId;
    const entrypoint = relPath(r.entrypoint);
    const mimeTypes = strings(r.mimeTypes)
      .filter((m) => MIME.test(m))
      .slice(0, 20);
    if (!rendererId || !displayName || !entrypoint || !mimeTypes.length) {
      errors.push(
        `notebookRenderer ${rendererId ?? "?"}: needs id, entrypoint (a .js file) and mimeTypes`,
      );
      return [];
    }
    if (!ownsName(id, rendererId)) {
      errors.push(`notebookRenderer ${rendererId} must start with ${prefixes(id).join(" or ")}`);
      return [];
    }
    return [{ id: rendererId, displayName: displayName.slice(0, 60), mimeTypes, entrypoint }];
  });
  return { menus, viewers, notebooks, notebookRenderers, agents, mcpServers, modelProviders };
}

/** Command namespaces that need their own permission, whatever the command's effects. */
const NAMESPACE_PERMISSIONS: Record<string, BasePermission> = {
  git: "git",
  github: "github",
  browser: "browser",
  agent: "agent",
  terminal: "terminal",
};

/** Commands that write the clipboard. */
const CLIPBOARD_COMMANDS: ReadonlySet<string> = new Set(["ui.copyText", "explorer.copyPath"]);

/**
 * The permissions an extension needs to run command `id` with `effects`, or null if it needs
 * none. Every listed permission is required.
 */
export function requiredPermissions(id: string, effects: readonly Effect[]): string[] {
  const out = new Set<string>();
  const namespace = id.split(".")[0] ?? "";
  const ns = NAMESPACE_PERMISSIONS[namespace];
  if (ns) out.add(ns);
  // Writing the clipboard declares no effect but is the clipboard permission's (D233).
  if (CLIPBOARD_COMMANDS.has(id)) out.add("clipboard");
  // Reading (file text, search results, editor state) is what fs.read is for (D176: without
  // this, editor.getText or viewer.open read any file in the folder).
  if (effects.includes("read")) out.add("fs.read");
  if (effects.includes("write") || effects.includes("destructive")) out.add("fs.write");
  if (effects.includes("exec") && ns !== "terminal") out.add("shell");
  if (effects.includes("network")) out.add("network");
  return [...out];
}

/** Whether `granted` covers `needed` (`network:<domain>` grants count as `network`). */
export function hasPermission(granted: readonly string[], needed: string): boolean {
  if (granted.includes(needed)) return true;
  if (needed === "network") return granted.some((g) => g.startsWith("network"));
  // "shell" also lets an extension use terminals.
  if (needed === "terminal") return granted.includes("shell");
  return false;
}

/** Whether `url` may be fetched with the granted network permissions. */
export function networkAllows(granted: readonly string[], url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.host.toLowerCase();
  } catch {
    return false;
  }
  for (const g of granted) {
    if (g === "network") return true;
    if (!g.startsWith("network:")) continue;
    const pattern = g.slice(8).toLowerCase();
    if (pattern === host || pattern === host.replace(/:\d+$/, "")) return true;
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      const bare = host.replace(/:\d+$/, "");
      if (bare === base || bare.endsWith(`.${base}`)) return true;
    }
  }
  return false;
}

/**
 * Activation events (PLAN §9.2): "*", "onStartup", "onStartupFinished", "onLanguage:<id>",
 * "workspaceContains:<glob>" (D176), "onFileSystem:<scheme>" (D234), "onUri", and (D255)
 * "onNotebook:<type>", "onDebug"; "onCommand:<id>" and "onView:<id>" are implicit (using one
 * starts the worker). The manifest may call the list `activationEvents`, as VS Code's does.
 */
export function activatesOn(manifest: ThirdPartyManifest, event: string): boolean {
  const events = manifest.activation.length ? manifest.activation : ["*"];
  return events.some(
    (e) => e === "*" || e === "onStartup" || e === event || (event === "onStartup" && e === "*"),
  );
}
