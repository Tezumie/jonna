// A VS Code extension's package.json with code (D256, docs/vscode-extensions-plan.md phase 2):
// its contributions in the IDE's shapes, so the extension runs in the Node host behind the
// `vscode` shim (core/extensions/vscode/). VS Code's command ids don't always fit the dispatcher's
// ("markdown-preview.open"): such a command gets an id that does, and keeps VS Code's in
// `vscodeId`, which is what its code, keybindings and menus use. DOM-free and unit-tested.

import type { KeybindingRule } from "../keybindings/index";
import { parseKeybinding } from "../keybindings/keys";
import type { ManifestSetting } from "./index";
import { parseWorkbenchContributions } from "./manifestWorkbench";
import type {
  ContributedCommand,
  ContributedKeybinding,
  ContributedMenuItem,
  ContributedNotebook,
  ContributedRenderer,
  ContributedTerminalProfile,
  ContributedView,
  ContributedViewContainer,
  ContributedViewer,
  ThirdPartyManifest,
} from "./thirdParty";
import { builtinCommand, isVscodeBuiltinId } from "./vscode/builtinCommands";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** What a VS Code extension with code may do: everything a program may (its code is Node's). */
export const VSCODE_PERMISSIONS = [
  "node",
  "fs.read",
  "fs.write",
  "shell",
  "terminal",
  "network",
  "git",
  "clipboard",
] as const;

const NLS_KEY = /^%([^%\s]+)%$/;
const MAX_DEPTH = 12;

/**
 * Replaces `%key%` strings with package.nls.json's text (VS Code's localized manifests): a
 * string, or `{ message }`. Unknown keys stay as they are.
 */
export function localizePackage(value: unknown, nls: unknown): unknown {
  const table = obj(nls);
  if (!Object.keys(table).length) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const key = NLS_KEY.exec(v)?.[1];
      if (!key) return v;
      const entry = table[key];
      return str(entry) ?? str(obj(entry).message) ?? v;
    }
    if (depth > MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
    return v;
  };
  return walk(value, 0);
}

const DISPATCHER_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** "vscode-eslint" → "vscodeEslint"; "1c" → "x1c": a camelCase segment the dispatcher takes. */
export function camelSegment(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((w, i) => (i === 0 ? w : (w[0] ?? "").toUpperCase() + w.slice(1)))
    .join("");
  if (!joined) return "";
  const lowered = (joined[0] ?? "").toLowerCase() + joined.slice(1);
  return /^[a-z]/.test(lowered) ? lowered : `x${lowered}`;
}

/**
 * The dispatcher's id for VS Code command `id`: the same when it fits ("eslint.restart"), else
 * each segment camelCased ("markdown-preview.open" → "markdownPreview.open"); one segment goes
 * under `namespace` ("helloWorld" → "<namespace>.helloWorld"). Undefined when nothing fits.
 */
export function dispatcherCommandId(id: string, namespace: string): string | undefined {
  if (DISPATCHER_ID.test(id)) return id;
  const segments = id.split(".").map(camelSegment).filter(Boolean);
  if (segments.length === 1) segments.unshift(namespace);
  const out = segments.join(".");
  return DISPATCHER_ID.test(out) ? out : undefined;
}

/**
 * The hidden command the shim routes VS Code commands through when the IDE runs one its code
 * registered without declaring it (a code lens's, a tree row's, a status bar item's).
 */
export function shimCommandId(namespace: string): string {
  return `${namespace}.runVscodeCommand`;
}

/** `[{ id, title, icon }]` (VS Code's `contributes.terminal.profiles`), at most 10. */
export function parseTerminalProfiles(raw: unknown): ContributedTerminalProfile[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 10).flatMap((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 80) : "";
    if (!/^[\w.-]{1,100}$/.test(id) || !title) return [];
    const icon = typeof o.icon === "string" ? /^\$\(([a-z0-9-]+)\)$/.exec(o.icon)?.[1] : undefined;
    return [{ id, title, ...(icon && { icon }) }];
  });
}

/** An icon of the IDE's set from VS Code's "$(name)" (a file icon has none). */
function iconName(v: unknown): string | undefined {
  const m = /^\$\(([a-z0-9-]+)(~spin)?\)$/.exec(str(v) ?? "");
  return m?.[1];
}

/** Context key namespaces that aren't an extension's own (VS Code's and the IDE's). */
const SHARED_CONTEXT = new Set([
  "config",
  "view",
  "viewItem",
  "resource",
  "editor",
  "workbench",
  "explorer",
  "scm",
  "debug",
  "terminal",
  "notebook",
  "ide",
  "extension",
  "extensions",
  "git",
  "testing",
  "agent",
  "chat",
  "workspace",
  "vscode",
]);

/** The context keys a `when` clause tests ("a && !b.c == 'x'" → a, b.c). */
/** VS Code's and the IDE's own context keys: no extension sets these. */
const CORE_CONTEXT_KEYS = new Set([
  "activeEditor",
  "activeEditorIsDirty",
  "activePanel",
  "activeViewlet",
  "config",
  "debugState",
  "debugType",
  "editorFocus",
  "editorHasSelection",
  "editorIsOpen",
  "editorLangId",
  "editorReadonly",
  "editorTextFocus",
  "explorerResourceIsFolder",
  "explorerViewletVisible",
  "filesExplorerFocus",
  "focusedView",
  "inDebugMode",
  "inputFocus",
  "inQuickInput",
  "inQuickOpen",
  "isInDiffEditor",
  "isLinux",
  "isMac",
  "isWeb",
  "isWindows",
  "isWorkspaceTrusted",
  "listFocus",
  "notebookCellType",
  "notebookEditorFocused",
  "notebookKernel",
  "notebookType",
  "panelFocus",
  "remoteName",
  "resource",
  "resourceExtname",
  "resourceFilename",
  "resourceLangId",
  "resourcePath",
  "resourceScheme",
  "sideBarFocus",
  "sideBarVisible",
  "terminalFocus",
  "textInputFocus",
  "view",
  "viewItem",
  "virtualWorkspace",
  "workbenchState",
  "workspaceFolderCount",
]);

export function whenKeys(when: string): string[] {
  return when
    .replace(/'[^']*'|"[^"]*"|\/(?:\\.|[^/])+\/[a-z]*/g, " ")
    .split(/[\s!&|()=<>~]+/)
    .filter((t) => /^[A-Za-z_][\w.:-]*$/.test(t) && t !== "true" && t !== "false" && t !== "in");
}

/** An icon file of the extension ("resources/logo.svg"), as VS Code's containers and views give. */
function iconFile(v: unknown): string | undefined {
  const p = str(v)?.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("$(") || p.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(p)) return;
  if (p.split("/").includes("..") || !/\.(svg|png|jpe?g|gif|webp)$/i.test(p)) return;
  return p;
}

export type VscodeContributions = {
  commands: ContributedCommand[];
  settings: Record<string, ManifestSetting>;
  keybindings: ContributedKeybinding[];
  views: ContributedView[];
  /** Its view containers: its own views' and other extensions' (Cell Tags in Jupyter's panel). */
  viewContainers: ContributedViewContainer[];
  menus: ContributedMenuItem[];
  activation: string[];
  /** First segments of the context keys its code may set ("gitlens" for "gitlens:enabled"). */
  contextNamespaces: string[];
  /**
   * Bare keys ("showCreateEnvButton") its own `when` clauses test: VS Code lets it set them; the
   * IDE does while no one else has set them.
   */
  contextKeys: string[];
  /** Custom editors, as viewers whose code writes each tab's page (D257). */
  viewers: ContributedViewer[];
  /** Its language model tools' commands, offered to the agent (D258). */
  agentTools: string[];
  /** Its terminal profiles (`contributes.terminal.profiles`, D264). */
  terminalProfiles: ContributedTerminalProfile[];
  notebooks: ContributedNotebook[];
  notebookRenderers: ContributedRenderer[];
} & ReturnType<typeof parseWorkbenchContributions>;

const SETTING_TYPES = ["boolean", "string", "number", "integer", "array", "object"];
const MAX_SETTINGS = 500;
const MAX_COMMANDS = 1000;
const VIEW_ID = /^[A-Za-z][\w.-]{0,120}$/;

/**
 * How a setting that names a program to run (or its arguments, its environment) ends: "lspPath",
 * "pytestPath", "pyreflyExecutable", "launchArgs". Lists of folders ("extraPaths") don't.
 */
const RUNS_PROGRAM =
  /(path|executable|command|commandline|interpreter|binary|program|exe|shell|args|arguments|env)$/i;

/**
 * VS Code's `contributes.configuration` (an object or a list of them) as the IDE's settings.
 * VS Code has no reserved names: a key is the first declarer's (the runtime shares one declared
 * already). `refuse` gives the reason a key isn't taken (the IDE's areas that hold credentials),
 * and each refused key is reported in `warnings`. Scopes as in VS Code: "application" and
 * "machine" only in the user's settings; "machine-overridable" in a folder's too, but — like
 * the extension's `restrictedConfigurations` and keys that name a program to run — only once
 * the folder is trusted (`restricted`).
 */
export function parseConfiguration(
  value: unknown,
  refuse: (key: string) => string | undefined = () => undefined,
  warnings: string[] = [],
  restrictedKeys: readonly string[] = [],
): Record<string, ManifestSetting> {
  const out: Record<string, ManifestSetting> = {};
  const sections = Array.isArray(value) ? value : [value];
  for (const rawSection of sections) {
    const section = obj(rawSection);
    const title = str(section.title);
    for (const [key, raw] of Object.entries(obj(section.properties))) {
      if (Object.keys(out).length >= MAX_SETTINGS) {
        warnings.push(`Settings after the first ${MAX_SETTINGS} are skipped.`);
        return out;
      }
      const p = obj(raw);
      if (!/^[A-Za-z][\w.-]*$/.test(key) || !key.includes(".")) continue;
      const refused = refuse(key);
      if (refused) {
        warnings.push(`Setting ${key} skipped: ${refused}`);
        continue;
      }
      const types = (Array.isArray(p.type) ? p.type : [p.type]).filter(
        (t): t is string => typeof t === "string" && SETTING_TYPES.includes(t),
      );
      const type = types[0] ?? (Array.isArray(p.enum) ? "string" : undefined);
      if (!type) continue;
      const fallback =
        type === "boolean"
          ? false
          : type === "string"
            ? ""
            : type === "array"
              ? []
              : type === "object"
                ? {}
                : 0;
      const enumValues = arr(p.enum).filter(
        (e): e is string | number => typeof e === "string" || typeof e === "number",
      );
      const enumDescriptions = arr(p.enumDescriptions ?? p.markdownEnumDescriptions).filter(
        (e): e is string => typeof e === "string",
      );
      const scope = str(p.scope);
      out[key] = {
        type,
        default: p.default !== undefined ? p.default : fallback,
        description:
          (str(p.markdownDescription) ?? str(p.description) ?? str(p.deprecationMessage) ?? "")
            .slice(0, 2000)
            .trim() || key,
        ...(enumValues.length && { enum: enumValues }),
        ...(enumDescriptions.length && { enumDescriptions }),
        ...(typeof p.minimum === "number" && { minimum: p.minimum }),
        ...(typeof p.maximum === "number" && { maximum: p.maximum }),
        ...(typeof p.order === "number" && { order: p.order }),
        // Machine-wide ones only in the user's settings, as in VS Code.
        ...((scope === "application" || scope === "machine") && { scope: "user" }),
        // A folder may set these once it's trusted (VS Code's restricted settings).
        ...(scope !== "application" &&
          scope !== "machine" &&
          (scope === "machine-overridable" ||
            restrictedKeys.includes(key) ||
            RUNS_PROGRAM.test(key)) && { restricted: true }),
        ...(title && { category: title.slice(0, 60) }),
      };
    }
  }
  return out;
}

const LANGUAGE_BLOCK = /^\s*(\[[^[\]]+\]\s*)+$/;
const SETTING_KEY = /^[A-Za-z][\w.-]*$/;

/**
 * VS Code's `contributes.configurationDefaults`: default values for settings (any extension's or
 * the IDE's) and `[language]` blocks of them, as plain JSON. Keys that aren't settings, and
 * blocks that aren't objects, are left out; at most 200.
 */
export function parseConfigurationDefaults(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(obj(value)).slice(0, 200)) {
    if (raw === undefined) continue;
    const block = LANGUAGE_BLOCK.test(key);
    if (block ? !raw || typeof raw !== "object" || Array.isArray(raw) : !SETTING_KEY.test(key))
      continue;
    if (!block && !key.includes(".")) continue;
    try {
      // A copy: nothing the registry merges shares objects with the manifest.
      out[key] = JSON.parse(JSON.stringify(raw)) as unknown;
    } catch {
      // Not JSON (can't happen for a parsed package.json): skipped.
    }
  }
  return out;
}

/** File extensions of VS Code's selectors (`{ filenamePattern: "*.drawio" }`, "*.{png,jpg}"). */
export function selectorExtensions(selector: unknown): string[] {
  const out = new Set<string>();
  for (const raw of arr(selector)) {
    const pattern = str(obj(raw).filenamePattern) ?? "";
    const m = /^(?:\*\*\/)?\*(\.[\w.-]+|\.\{[\w.,-]+\})$/.exec(pattern.trim());
    if (!m?.[1]) continue;
    const ext = m[1];
    const list = ext.startsWith(".{")
      ? ext
          .slice(2, -1)
          .split(",")
          .map((e) => `.${e}`)
      : [ext];
    for (const e of list) if (/^\.[a-z0-9._-]+$/i.test(e)) out.add(e.toLowerCase());
  }
  return [...out];
}

/** VS Code's custom editors as viewers whose code writes the page (D257). */
function customEditors(value: unknown): ContributedViewer[] {
  return arr(value).flatMap((raw): ContributedViewer[] => {
    const e = obj(raw);
    const id = str(e.viewType);
    const extensions = selectorExtensions(e.selector);
    if (!id || !VIEW_ID.test(id) || !extensions.length) return [];
    return [
      {
        id,
        title: (str(e.displayName) ?? id).slice(0, 60),
        extensions,
        codePage: true,
        // "option": offered in Reopen with…, as in VS Code.
        default: str(e.priority) !== "option",
      },
    ];
  });
}

function notebookTypes(value: unknown): ContributedNotebook[] {
  return arr(value).flatMap((raw): ContributedNotebook[] => {
    const n = obj(raw);
    const type = str(n.type);
    const extensions = selectorExtensions(n.selector);
    if (!type || !VIEW_ID.test(type) || !extensions.length) return [];
    return [
      {
        type,
        displayName: (str(n.displayName) ?? type).slice(0, 60),
        extensions,
        default: str(n.priority) !== "option",
      },
    ];
  });
}

/** A `when` as the IDE's context says it: Jupyter's notebook type is "jupyter.notebook" here. */
export const ideWhen = (when: string) =>
  when.replace(/(^|[^\w.-])(['"]?)jupyter-notebook\2(?![\w.-])/g, "$1$2jupyter.notebook$2");

function renderers(value: unknown): ContributedRenderer[] {
  const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+*-]*$/i;
  return arr(value).flatMap((raw): ContributedRenderer[] => {
    const r = obj(raw);
    const id = str(r.id);
    // One that extends another renderer (`{ extends, path }`) has no page of its own here.
    const entrypoint = str(r.entrypoint)?.replace(/^\.\//, "");
    const mimeTypes = arr(r.mimeTypes).filter(
      (m): m is string => typeof m === "string" && MIME.test(m),
    );
    if (!id || !entrypoint || entrypoint.includes("..") || !mimeTypes.length) return [];
    return [
      {
        id,
        displayName: (str(r.displayName) ?? id).slice(0, 60),
        mimeTypes: mimeTypes.slice(0, 20),
        entrypoint,
      },
    ];
  });
}

/**
 * VS Code's own view containers an extension's views may name, as the IDE's views they become
 * sections of (viewsExtensionPoint.ts: "explorer", "scm", "debug"; Testing's container is
 * "workbench.view.extension.test", named "test"). VS Code's panel containers (Output,
 * Terminal) can't be named, so a view there goes to the Explorer, as in VS Code.
 */
const BUILTIN_CONTAINERS: Readonly<Record<string, string>> = {
  explorer: "explorer.view",
  scm: "scm.view",
  debug: "debug.view",
  test: "testing.view",
};

/** `contributes.viewsContainers`: the activity bar's, the panel's and the secondary side bar's. */
export function parseViewContainers(value: unknown): ContributedViewContainer[] {
  const vc = obj(value);
  const out: ContributedViewContainer[] = [];
  for (const [where, list] of [
    ["activitybar", vc.activitybar],
    ["panel", vc.panel],
    ["secondarySidebar", vc.secondarySidebar],
  ] as const)
    for (const raw of arr(list).slice(0, 50)) {
      const x = obj(raw);
      const id = str(x.id);
      if (!id || !VIEW_ID.test(id) || out.some((o) => o.id === id)) continue;
      const icon = iconName(x.icon);
      const iconPath = iconFile(x.icon);
      const when = str(x.when)?.trim();
      out.push({
        id,
        title: (str(x.title) ?? id).slice(0, 60),
        ...(icon && { icon }),
        ...(iconPath && { iconPath }),
        where,
        ...(when && { when }),
      });
    }
  return out;
}

/**
 * A view in another extension's container (`view.container`) placed there: that container's
 * place (activity bar, panel, secondary side bar), icon (unless the view has its own) and `when`,
 * titled "<container>: <view>" as the views of a shared container are. A container's image icon
 * is a file of the other extension, so only an icon of the IDE's set ("$(notebook)") carries over.
 */
export function placeInContainer(
  view: ContributedView,
  container: ContributedViewContainer,
): ContributedView {
  const {
    sectionOf: _sectionOf,
    sectionOnly: _sectionOnly,
    sectionOrder: _sectionOrder,
    container: _container,
    ...rest
  } = view;
  const own = view.icon || view.iconPath;
  const when = [...new Set([container.when, view.when].filter((w): w is string => !!w))];
  return {
    ...rest,
    title: `${container.title}: ${view.title}`,
    location:
      container.where === "panel"
        ? "panel"
        : container.where === "secondarySidebar"
          ? "secondary"
          : "sidebar",
    ...(!own && container.icon && { icon: container.icon }),
    ...(when.length && {
      when: when.length > 1 ? when.map((w) => `(${w})`).join(" && ") : when[0],
    }),
  };
}

/**
 * A VS Code package's `contributes.keybindings` (`c` its contributes). A command it declares
 * (`ownId`: its dispatcher id) is bound by that id; any other — one its code registers, VS
 * Code's own (`undo`, `notebook.cell.copy`), another extension's — keeps VS Code's id in
 * `vscodeCommand`, resolved when the extension loads (`resolveVscodeKeybindings`). "-command"
 * removes that command's default binding, as in VS Code.
 */
export function parseVscodeKeybindings(
  c: Record<string, unknown>,
  ownId: (vscodeId: string) => string | undefined,
): ContributedKeybinding[] {
  const list = Array.isArray(c.keybindings) ? c.keybindings : [c.keybindings];
  return list.slice(0, MAX_COMMANDS).flatMap((raw): ContributedKeybinding[] => {
    const k = obj(raw);
    const written = str(k.command)?.trim();
    // VS Code on Windows takes `win` first (the IDE's rules have one key and a macOS one).
    const key = str(k.win) ?? str(k.key) ?? str(k.linux);
    if (!written || !key) return [];
    const removal = written.startsWith("-");
    const vscodeId = removal ? written.slice(1) : written;
    if (!vscodeId) return [];
    const own = ownId(vscodeId);
    // As VS Code does, the command's own `enablement` is part of its keys' `when`: a key bound
    // with no `when` (Jupyter's F10, Ctrl+Enter) applies only where the command can run.
    const enablement = own
      ? str(obj(arr(c.commands).find((cmd) => str(obj(cmd).command) === vscodeId)).enablement)
      : undefined;
    const parts = [removal ? undefined : enablement, str(k.when)].filter((w): w is string => !!w);
    const joined = parts.length > 1 ? parts.map((w) => `(${w})`).join(" && ") : parts[0];
    const when = joined && ideWhen(joined);
    return [
      {
        key,
        command: own ? `${removal ? "-" : ""}${own}` : written,
        ...(!own && { vscodeCommand: vscodeId }),
        ...(str(k.mac) && { mac: str(k.mac) }),
        ...(when && { when }),
        ...(k.args !== undefined && !removal && { args: k.args }),
      },
    ];
  });
}

/** Whether the keyboard can read `key` ("ctrl+k ctrl+o"; not "ctrl+shift+" or "a+b"). */
function readableKey(key: string): boolean {
  try {
    return parseKeybinding(key).length > 0;
  } catch {
    return false;
  }
}

/** What `resolveVscodeKeybindings` asks of the IDE when an extension loads. */
export interface KeybindingTargets {
  /** Whether the dispatcher has this command. */
  has(command: string): boolean;
  /** Another loaded extension's declared command with this VS Code id: its dispatcher id. */
  declaredElsewhere(vscodeId: string): string | undefined;
  /** The extension's hidden command into its code (`<ns>.runVscodeCommand`), when it has code. */
  shim?: string;
}

/**
 * An extension's keybindings as the keyboard takes them, VS Code's way: a rule whose command
 * isn't the extension's own runs VS Code's built-in command as the IDE's (builtinCommands.ts),
 * an IDE command of that id, another extension's declared command, or — for an extension with
 * code — whatever its code registered under that id (through its hidden command, resolved when
 * the key is pressed, as VS Code's registry is). Rules nothing can run are left out, each with a
 * warning for the extension's log. A "-command" rule removes the IDE's (or an earlier
 * extension's) binding of the command it resolves to.
 */
export function resolveVscodeKeybindings(
  rules: readonly ContributedKeybinding[],
  targets: KeybindingTargets,
): { rules: KeybindingRule[]; warnings: string[] } {
  const out: KeybindingRule[] = [];
  const warnings: string[] = [];
  const plainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  for (const original of rules) {
    // A key the keyboard can't read would be dropped without a word: said in its log instead.
    if (!readableKey(original.key)) {
      warnings.push(
        `Keybinding "${original.key}" (${original.vscodeCommand ?? original.command}) skipped: the IDE can't read the key.`,
      );
      continue;
    }
    let rule = original;
    if (original.mac !== undefined && !readableKey(original.mac)) {
      warnings.push(
        `Keybinding "${original.mac}" (${original.vscodeCommand ?? original.command}) on macOS: the IDE can't read the key, "${original.key}" is used.`,
      );
      const { mac: _mac, ...rest } = original;
      rule = rest;
    }
    const { vscodeCommand: id, ...base } = rule;
    if (!id) {
      out.push(base);
      continue;
    }
    const removal = base.command.startsWith("-");
    const builtin = builtinCommand(id);
    const args = base.args;
    // VS Code passes a keybinding's `args` as the command's one argument.
    const vscodeArgs = args === undefined ? [] : [args];
    let target: { command: string; args?: unknown } | undefined;
    if (builtin && targets.has(builtin.command))
      target = { command: builtin.command, ...(builtin.input && { args: builtin.input }) };
    else if (targets.has(id)) target = { command: id, ...(plainObject(args) && { args }) };
    else {
      const elsewhere = targets.declaredElsewhere(id);
      if (elsewhere) target = { command: elsewhere, args: { arguments: vscodeArgs } };
      else if (!removal && targets.shim && !isVscodeBuiltinId(id))
        target = {
          command: targets.shim,
          args: { id, arguments: vscodeArgs, resolve: true },
        };
    }
    if (!target) {
      warnings.push(
        `Keybinding ${base.key} (${removal ? "-" : ""}${id}) skipped: ${
          removal
            ? "no binding of that command to remove here."
            : "the IDE has no such command (VS Code's own, or another extension's that isn't loaded)."
        }`,
      );
      continue;
    }
    const { args: _args, ...rest } = base;
    out.push({
      ...rest,
      command: removal ? `-${target.command}` : target.command,
      ...(!removal && target.args !== undefined && { args: target.args }),
    });
  }
  return { rules: out, warnings };
}

/**
 * A VS Code package's contributions with code (`m` the localized package.json): its commands
 * (dispatcher ids, VS Code's kept), settings, keybindings, views, menus and activation events.
 * `reserved` says which first segments are the IDE's own context keys; `refuseSetting` and
 * `warnings` are parseConfiguration's.
 */
export function vscodeContributions(
  m: Record<string, unknown>,
  namespace: string,
  reserved: (namespace: string) => boolean,
  refuseSetting: (key: string) => string | undefined = () => undefined,
  warnings: string[] = [],
): VscodeContributions {
  const c = obj(m.contributes);
  const menusIn = obj(c.menus);
  // A command the palette never offers (`"when": "false"` under menus.commandPalette).
  const paletteHidden = new Set(
    arr(menusIn.commandPalette)
      .map(obj)
      .filter((x) => str(x.when)?.trim() === "false")
      .map((x) => str(x.command))
      .filter((x): x is string => !!x),
  );
  const byVscodeId = new Map<string, ContributedCommand>();
  const icons = new Map<string, string>();
  const iconFiles = new Map<string, { light: string; dark: string }>();
  const used = new Set<string>([shimCommandId(namespace)]);
  for (const raw of arr(c.commands).slice(0, MAX_COMMANDS)) {
    const cmd = obj(raw);
    const vscodeId = str(cmd.command);
    const title = str(cmd.title) ?? str(obj(cmd.title).value);
    if (!vscodeId || !title || byVscodeId.has(vscodeId)) continue;
    const id = dispatcherCommandId(vscodeId, namespace);
    if (!id || used.has(id)) continue;
    used.add(id);
    const category = str(cmd.category) ?? str(obj(cmd.category).value);
    const icon = iconName(cmd.icon);
    if (icon) icons.set(id, icon);
    // An icon file, or a light / dark pair (D262: shown on its menu buttons).
    const light = iconFile(cmd.icon) ?? iconFile(obj(cmd.icon).light);
    const dark = iconFile(cmd.icon) ?? iconFile(obj(cmd.icon).dark) ?? light;
    if (light ?? dark) iconFiles.set(id, { light: light ?? dark ?? "", dark: dark ?? light ?? "" });
    byVscodeId.set(vscodeId, {
      id,
      title,
      ...(category && { category }),
      ...(id !== vscodeId && { vscodeId }),
      ...(str(cmd.enablement) && { when: ideWhen(str(cmd.enablement) as string) }),
      ...(paletteHidden.has(vscodeId) && { palette: false as const }),
      // Its code can do anything: an agent asks before running one.
      effects: ["write", "exec"],
      agent: "discoverable",
    });
  }
  // Language model tools (D258): commands the agent sees as tools, run by `lm.registerTool`'s.
  const tools: ContributedCommand[] = [];
  for (const raw of arr(c.languageModelTools).slice(0, 50)) {
    const t = obj(raw);
    const name = str(t.name);
    if (!name) continue;
    const id = dispatcherCommandId(`${namespace}.tool.${camelSegment(name)}`, namespace);
    if (!id || used.has(id)) continue;
    used.add(id);
    const schema = obj(t.inputSchema);
    tools.push({
      id,
      title: (str(t.displayName) ?? name).slice(0, 80),
      description: (str(t.modelDescription) ?? str(t.userDescription) ?? name).slice(0, 2000),
      ...(Object.keys(schema).length && { input: schema }),
      vscodeTool: name,
      palette: false,
      // Its code can do anything: the agent asks first, as VS Code does for extension tools.
      effects: ["exec"],
      agent: "discoverable",
    });
  }
  const commands = [
    ...byVscodeId.values(),
    ...tools,
    {
      id: shimCommandId(namespace),
      title: "Run a command of the extension",
      description: "Runs a command the extension's code registered (code lenses, tree rows).",
      palette: false as const,
      agent: "hidden" as const,
    },
  ];
  const ownId = (vscodeId: unknown) => byVscodeId.get(str(vscodeId) ?? "")?.id;

  const keybindings = parseVscodeKeybindings(c, (vscodeId) => byVscodeId.get(vscodeId)?.id);

  // Views: a container of its own (activity bar, panel or secondary side bar) gives each of its
  // views an icon there; VS Code's own containers (Explorer, Source control, Run and debug,
  // Testing) take them as sections; another extension's is looked up when it loads. Containers
  // and views can have a `when` (D260): a view shows while its own and its container's hold.
  const viewContainers = parseViewContainers(c.viewsContainers);
  const containers = new Map(viewContainers.map((x) => [x.id, x]));
  const views: ContributedView[] = [];
  for (const [container, list] of Object.entries(obj(c.views))) {
    const own = containers.get(container);
    const builtin = BUILTIN_CONTAINERS[container];
    const many = arr(list).length > 1;
    arr(list).forEach((raw, index) => {
      const v = obj(raw);
      const id = str(v.id);
      // A view without a name shows its container's title (VS Code's single-view containers).
      const name = str(v.name)?.trim() || own?.title || id;
      if (!id || !name || !VIEW_ID.test(id)) return;
      // A webview view's page comes from its code (registerWebviewViewProvider, D257).
      const webview = v.type === "webview";
      const icon = iconName(v.icon) ?? (iconFile(v.icon) ? undefined : own?.icon);
      const iconPath = iconFile(v.icon) ?? (iconName(v.icon) ? undefined : own?.iconPath);
      const when = [...new Set([own?.when, str(v.when)?.trim()].filter((w): w is string => !!w))];
      // Not its own nor VS Code's: another extension's, else the Explorer (VS Code's fallback).
      const sectionOf = own ? undefined : (builtin ?? "explorer.view");
      views.push({
        id,
        title: own && many ? `${own.title}: ${name}` : (own?.title ?? name),
        location:
          own?.where === "panel"
            ? "panel"
            : own?.where === "secondarySidebar"
              ? "secondary"
              : "sidebar",
        type: webview ? "webview" : "tree",
        ...(webview && { codePage: true }),
        ...(icon && { icon }),
        ...(iconPath && { iconPath }),
        ...(when.length && {
          when: when.length > 1 ? when.map((w) => `(${w})`).join(" && ") : when[0],
        }),
        ...(sectionOf && { sectionOf, sectionOnly: true, sectionOrder: 100 + index }),
        ...(!own && !builtin && { container }),
      });
    });
  }

  const MENUS: Record<string, ContributedMenuItem["location"]> = {
    "editor/context": "editor/context",
    "editor/title": "editor/title",
    "explorer/context": "explorer/context",
    "view/title": "view/title",
    "view/item/context": "view/item/context",
    "notebook/toolbar": "notebook/toolbar",
    "notebook/cell/title": "notebook/cell/title",
    // The run button's menu beside a cell: here, the cell's toolbar.
    "notebook/cell/execute": "notebook/cell/title",
    "notebook/kernelSource": "notebook/kernelSource",
  };
  const menus: ContributedMenuItem[] = [];
  for (const [where, list] of Object.entries(menusIn)) {
    const location = MENUS[where];
    if (!location) continue;
    for (const raw of arr(list)) {
      const item = obj(raw);
      const command = ownId(item.command);
      if (!command) continue;
      const icon = icons.get(command);
      const files = iconFiles.get(command);
      menus.push({
        location,
        command,
        ...(icon && { icon }),
        ...(files && { iconPath: files.light, iconPathDark: files.dark }),
        ...(str(item.when) && { when: ideWhen(str(item.when) as string) }),
        ...(str(item.group) && { group: str(item.group)?.slice(0, 60) }),
      });
    }
  }

  // VS Code (1.74+) activates on its commands and views by itself, and on its languages.
  const declared = arr(m.activationEvents).filter((a): a is string => typeof a === "string");
  // Only languages it gives a configuration for (VS Code's languageService.ts, D295): a language
  // listed for its file extensions alone doesn't activate it.
  const languages = arr(c.languages)
    .filter((l) => !!str(obj(l).configuration))
    .map((l) => str(obj(l).id))
    .filter((l): l is string => !!l)
    .map((l) => `onLanguage:${l}`);
  const activation = [...new Set([...declared, ...languages])];
  // Nothing to wait for: the first command or view starts it ("onCommand" matches no event).
  if (!activation.length) activation.push("onCommand");

  const settings = parseConfiguration(
    c.configuration,
    refuseSetting,
    warnings,
    restrictedConfigurations(m),
  );
  const contextNamespaces = new Set<string>();
  const firstOf = (key: string) => key.split(/[.:]/)[0] ?? "";
  for (const id of byVscodeId.keys()) contextNamespaces.add(firstOf(id));
  for (const key of Object.keys(settings)) contextNamespaces.add(firstOf(key));
  for (const v of views) contextNamespaces.add(firstOf(v.id));
  // Keys its views test ("acme-tools.listEnabled") are its own to set (D260), unless
  // the namespace is one the IDE or VS Code uses itself, or doesn't start with its own name's
  // first word (D261: a view's `when` can't claim another extension's keys).
  const ownWord = (str(m.name) ?? "").split(/[-_.]/)[0]?.toLowerCase() ?? "";
  for (const v of views)
    for (const key of whenKeys(v.when ?? ""))
      if (
        /[.:]/.test(key) &&
        !SHARED_CONTEXT.has(firstOf(key)) &&
        ownWord.length >= 3 &&
        firstOf(key).toLowerCase().startsWith(ownWord)
      )
        contextNamespaces.add(firstOf(key));
  const name = str(m.name) ?? "";
  contextNamespaces.add(name);
  contextNamespaces.add(namespace);
  const contextKeys = new Set<string>();
  const whens = [
    ...Object.values(menusIn).flatMap((list) => arr(list).map((i) => str(obj(i).when))),
    ...arr(c.keybindings).map((k) => str(obj(k).when)),
    ...arr(c.viewsWelcome).map((v) => str(obj(v).when)),
    ...arr(c.commands).map((cmd) => str(obj(cmd).enablement)),
    ...Object.values(obj(c.views)).flatMap((list) => arr(list).map((v) => str(obj(v).when))),
  ];
  // Keys only (a comparison's right side is a value: `== python`, `in someList`).
  for (const when of whens)
    for (const key of whenKeys(
      (when ?? "").replace(/(==|!=|=~|>=|<=|>|<|\bnot in\b|\bin\b)\s*[^\s&|()]+/g, " "),
    ))
      if (!/[.:]/.test(key) && key.length <= 60 && !CORE_CONTEXT_KEYS.has(key))
        contextKeys.add(key);

  return {
    commands,
    settings,
    keybindings,
    views,
    menus,
    activation,
    viewContainers,
    viewers: customEditors(c.customEditors),
    agentTools: tools.map((t) => t.id),
    terminalProfiles: parseTerminalProfiles(obj(c.terminal).profiles),
    notebooks: notebookTypes(c.notebooks),
    // VS Code's key is `notebookRenderer` (the IDE's own manifests say `notebookRenderers`).
    notebookRenderers: renderers([...arr(c.notebookRenderer), ...arr(c.notebookRenderers)]),
    // VS Code's shapes already; a type the IDE has itself is dropped.
    ...parseWorkbenchContributions(c, []),
    contextKeys: [...contextKeys].slice(0, 200),
    contextNamespaces: [...contextNamespaces].filter((n) => {
      if (!/^[A-Za-z][\w-]{1,60}$/.test(n)) return false;
      if (!reserved(n)) return true;
      warnings.push(
        `Context keys under "${n}." are the IDE's: the extension's code can't set them (setContext is refused).`,
      );
      return false;
    }),
  };
}

/**
 * The settings VS Code treats as restricted for the extension in an untrusted folder
 * (`capabilities.untrustedWorkspaces.restrictedConfigurations`).
 */
export function restrictedConfigurations(m: Record<string, unknown>): string[] {
  return arr(obj(obj(m.capabilities).untrustedWorkspaces).restrictedConfigurations)
    .filter((k): k is string => typeof k === "string")
    .slice(0, 500);
}

/**
 * A VS Code package while its code isn't allowed (D256): what it had before the shim, its themes,
 * icon themes, grammars, languages, snippets and settings, without code or what needs it
 * (commands, keys, views, menus, editors, notebooks, debuggers, tasks) and without asking.
 */
export function declarativeOnly(manifest: ThirdPartyManifest): ThirdPartyManifest {
  const { main: _main, host: _host, contextNamespaces: _ns, ...rest } = manifest;
  return {
    ...rest,
    permissions: [],
    activation: [],
    contributes: {
      ...manifest.contributes,
      commands: [],
      keybindings: [],
      views: [],
      menus: [],
      viewers: [],
      notebooks: [],
      notebookRenderers: [],
      taskDefinitions: [],
      debuggers: [],
    },
  };
}
