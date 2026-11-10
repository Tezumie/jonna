// Built-in Settings: the "settings" dock tab (DESIGN.md §12.16), commands to open it, change and
// reset values, open a scope's settings.json, and `ide://settings`. Values and files live in
// SettingsService (workbench/settings.ts); this extension is its UI and command surface. In a
// multi-root workspace (D251) the workspace scope is the workspace file's settings and the
// "folder" scope one folder's own settings.json (folderScope.ts).
import type { Caller } from "../../core/dispatcher/types";
import type { BuiltinExtension } from "../../core/extensions/index";
import { extensionMayWriteSetting } from "../../core/extensions/thirdParty";
import { fsIpc } from "../../core/ipc/fs";
import { settingsIpc } from "../../core/ipc/system";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import {
  isLanguageOverrideKey,
  normalizeLanguageId,
  validBlock,
} from "../../core/settings/languageOverrides";
import type { SettingsScope } from "../../core/settings/model";
import { isValid } from "../../core/settings/schema";
import { translateVscodeSettings } from "../../core/settings/vscode";
import type { WorkbenchServices } from "../../workbench/services";
import { ensureWorkspaceFolder } from "../../workbench/workspaceFolder";
import { chooseFolder } from "../editor/folderChoice";
import { registerEditorImport } from "./editorImport";
import manifest from "./extension.json";
import { type EditScope, inspectFolder } from "./folderScope";
import { registerProfileCommands } from "./profile";
import { settingsViewDescriptor } from "./view";

const languageInput = s
  .string()
  .describe(
    "A language id (python, typescript, markdown…): the value goes in the scope's \"[language]\": {…} block and applies to that language's files only",
  )
  .optional();

const scopeInput = s
  .enum(["user", "workspace", "folder"])
  .describe(
    "user (all folders), workspace (this folder's settings.json; in a multi-root workspace, the workspace file's settings) or folder (a multi-root workspace folder's own settings.json, see `folder`; with one folder, the same as workspace); default user",
  )
  .optional();

const folderInput = s
  .string()
  .describe(
    "With scope folder: the workspace folder (its path or name); default: the active file's folder, else asks",
  )
  .optional();

/**
 * Settings that decide what the agent may do without asking. D379: also the commands that run on
 * their own (hooks, the status line), where data goes (the notify webhook), the command sandbox,
 * and desktop control's lasting grants: an agent setting them gave itself what the user hadn't.
 */
const AGENT_GUARDED =
  /^agent\.(runCommands|allowedCommands|deniedCommands|mcpServers|externalAgents|providers|ideControl|deleteProtection|browserProtection|mcpProtection|closeOpenedOnStop|autoApprove|mcp\.(sampling|disabledServers|disabledTools)|worktree\.(setupScript|copyFiles)|webFetch\.(enabled|autoApprove)|webSearch\.(provider|searxngUrl)|hooks|statusLine|notify\.webhook|sandbox(\.(allowHosts|allowWrite|denyRead|projects))?|computerUse\.(enabled|allowedApps))$|^mcp\.claudeCode\.enabled$/;

/**
 * Agents (ours and ACP ones), extensions and MCP clients can't change what the agent may do: an
 * extension with fs.write setting agent.runCommands to "full" would undo every ask (D176).
 */
const notUser = (kind: string) =>
  kind === "agent" || kind === "acp" || kind === "ext" || kind === "mcp";

export const settingsExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, dock, settings, state, workspace } = services;
    sub.add(dock.views.register(settingsViewDescriptor(services)));
    registerProfileCommands(sub, services);
    registerEditorImport(sub, services);

    const checkScope = (scope: SettingsScope) => {
      if (scope === "workspace" && !settings.filePath("workspace"))
        throw new Error("Open a folder to change workspace settings.");
    };
    /**
     * Where a scope's values go: a folder of a multi-root workspace for "folder" (D251), else a
     * plain scope ("folder" with one folder is its workspace settings, as in VS Code).
     */
    const place = async (
      scope: EditScope,
      folder: string | undefined,
    ): Promise<{ scope: SettingsScope; folder: null } | { scope: "folder"; folder: string }> => {
      if (scope !== "folder" || !workspace.isMultiRoot()) {
        const plain = scope === "folder" ? "workspace" : scope;
        checkScope(plain);
        return { scope: plain, folder: null };
      }
      const chosen = await chooseFolder(services, folder, "Settings of which folder?");
      if (!chosen) throw new Error("No folder chosen.");
      return { scope: "folder", folder: chosen.path };
    };
    const folderName = (path: string) => workspace.folderOf(path)?.name ?? path;
    const checkKey = (key: string) => {
      if (!settings.registry.get(key)) throw new Error(`Unknown setting: ${key}`);
    };
    /** An extension (with "fs.write") can't change user-only settings: they start programs. */
    const checkExtension = (caller: Caller, keys: readonly string[]) => {
      if (caller.kind !== "ext") return;
      for (const key of keys)
        if (
          // Its own, or one it shares with the extension that declared it first (a VS Code
          // package's settings don't start with its id, D256).
          !settings.registry.owners(key).includes(caller.id) &&
          !extensionMayWriteSetting(
            caller.id,
            key,
            // A restricted one starts programs too: only the user changes it (D209).
            settings.registry.get(key)?.restricted ? "user" : settings.registry.get(key)?.scope,
            settings.registry.owners(key),
          )
        )
          throw new Error(`${key} can only be changed by you, not by an extension.`);
    };

    sub.add(
      dispatcher.register({
        id: "settings.importVscode",
        title: "Import VS Code settings",
        category: "Preferences",
        description:
          "Copies the settings the IDE understands from VS Code's (or Cursor's, VSCodium's) user settings.json into the IDE's user settings. A folder's .vscode/settings.json is read automatically.",
        input: s.object({
          app: s.string().describe("VS Code, VS Code Insiders, Cursor or VSCodium").optional(),
        }),
        effects: ["write"],
        agent: "hidden",
        run: async ({ app }) => {
          const found = await settingsIpc.vscodeUser();
          if (!found.length)
            throw new Error("No VS Code, Cursor or VSCodium user settings found on this machine.");
          const chosen =
            (app ? found.find((f) => f.app === app) : undefined) ??
            (found.length === 1
              ? found[0]
              : await services.quickInput
                  .pick(
                    found.map((f) => ({ id: f.app, label: f.app, description: f.path })),
                    { placeholder: "Import settings from" },
                  )
                  .then((p) => found.find((f) => f.app === p?.id)));
          if (!chosen) return { imported: 0 };
          const parsed = parseJsonc(chosen.text);
          if (!parsed.ok || !parsed.value || typeof parsed.value !== "object")
            throw new Error(`${chosen.path} isn't valid JSON.`);
          const { values, skipped } = translateVscodeSettings(
            parsed.value as Record<string, unknown>,
            (k) => !!settings.registry.get(k),
          );
          const applies = (k: string, v: unknown) => {
            const schema = settings.registry.get(k);
            return !!schema && isValid(schema, v);
          };
          // Language blocks (`[python]`) keep what applies here, merged into the user's block.
          for (const k of Object.keys(values)) {
            if (!isLanguageOverrideKey(k)) continue;
            const block = validBlock(values[k], applies);
            const mine = settings.model.inspect(k, "user");
            values[k] = block && {
              ...(mine && typeof mine === "object" && !Array.isArray(mine) ? mine : {}),
              ...block,
            };
          }
          const keys = Object.keys(values).filter((k) =>
            isLanguageOverrideKey(k) ? values[k] !== undefined : applies(k, values[k]),
          );
          if (!keys.length) {
            services.notifications.show(
              "info",
              `Nothing to import: none of ${chosen.app}'s settings apply here.`,
            );
            return { imported: 0, skipped: skipped.length };
          }
          for (const k of keys) await settings.update(k, values[k], "user");
          services.notifications.show(
            "success",
            `Imported ${keys.length} setting${keys.length === 1 ? "" : "s"} from ${chosen.app} (${skipped.length} don't apply to the IDE).`,
          );
          return { imported: keys, skipped };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "settings.open",
        title: "Open settings",
        category: "Preferences",
        description:
          "Opens the settings editor tab, optionally on a scope, a category page (e.g. `Agent`) or with a search query (e.g. `terminal`). The query takes VS Code's filters: `@modified`, `@id:editor.fontSize,editor.tabSize`, `@ext:builtin.terminal`, `@tag:ai`, `@lang:python`.",
        input: s.object({
          scope: scopeInput,
          query: s.string().describe("Search text").optional(),
          category: s.string().describe("Category page, e.g. Agent, Editor").optional(),
          folder: folderInput,
        }),
        effects: [],
        // Not hidden (D183): an extension's "settings" button opens its page. Agents running it
        // are asked first: settings.* changes the IDE (D176).
        agent: "discoverable",
        run: ({ scope, query, category, folder }) => {
          const tabId = dock.openView(
            "settings",
            { scope: scope ?? "user", ...(folder && { folder }) },
            "main",
            true,
          );
          const ref = dock.findTab(tabId);
          const tab = ref?.group.tabs[ref.index];
          const view = tab ? dock.view(tab) : undefined;
          if (view && "configure" in view && typeof view.configure === "function")
            view.configure(scope, query, category, folder);
          return { tabId };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "settings.openJson",
        title: "Open settings (JSON)",
        category: "Preferences",
        description:
          "Opens a scope's settings.json in an editor tab (creating an empty one if needed): with scope folder, that folder's own. Returns its path.",
        input: s.object({ scope: scopeInput, folder: folderInput }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ scope: asked = "user", folder }, ctx) => {
          const where = await place(asked, folder);
          if (where.scope === "folder") {
            const path = settings.folderSettingsPath(where.folder);
            const exists = await fsIpc.stat(path).then(
              () => true,
              () => false,
            );
            if (!exists) {
              await ensureWorkspaceFolder(where.folder);
              await fsIpc.write(path, new TextEncoder().encode("{\n}\n"));
            }
            await ctx.execute("editor.openFile", { path });
            return { path, folder: folderName(where.folder) };
          }
          const scope = where.scope;
          const path = settings.filePath(scope);
          if (!path) throw new Error("Settings files are only available in the desktop app.");
          const exists = await fsIpc.stat(path).then(
            () => true,
            () => false,
          );
          if (!exists) await fsIpc.write(path, new TextEncoder().encode("{\n}\n"));
          await ctx.execute("editor.openFile", { path });
          return { path };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "settings.set",
        title: "Change setting",
        category: "Preferences",
        description:
          "Writes one setting to user or workspace settings.json (comments in the file are kept). The value must fit the setting's schema (see ide://settings). With `language`, it's that language's value (VS Code's `\"[python]\": { … }` block), which wins over the plain one for its files. In a multi-root workspace, scope folder writes one folder's own settings (`folder`).",
        input: s.object({
          key: s.string().describe("Setting key, e.g. editor.fontSize"),
          value: s.unknown().describe("New value"),
          scope: scopeInput,
          language: languageInput,
          folder: folderInput,
        }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ key, value, scope: asked = "user", language, folder }, ctx) => {
          checkKey(key);
          // The agent can't widen its own permissions (D120): those settings are the user's.
          if (notUser(ctx.caller.kind) && AGENT_GUARDED.test(key))
            throw new Error(`${key} can only be changed by you, not by the agent.`);
          checkExtension(ctx.caller, [key]);
          const schema = settings.registry.get(key);
          if (schema && value !== undefined && !isValid(schema, value))
            throw new Error(
              `Invalid value for ${key}: expected ${schema.enum ? `one of ${schema.enum.join(", ")}` : schema.type}`,
            );
          const where = await place(asked, folder);
          if (where.scope === "folder") {
            if (schema?.scope === "user")
              throw new Error(`${key} is a user setting: a folder's settings can't change it.`);
            const id = language ? normalizeLanguageId(language) : undefined;
            await settings.updateAt(key, value, where.folder, id);
            return {
              key,
              value: id
                ? settings.peekForLanguageAt(key, id, where.folder)
                : settings.peekAt(key, where.folder),
              scope: "folder",
              folder: folderName(where.folder),
              ...(id && { language: id }),
            };
          }
          const scope = where.scope;
          if (language) {
            const id = normalizeLanguageId(language);
            await settings.updateForLanguage(id, key, value, scope);
            return { key, value: settings.peekForLanguage(key, id), scope, language: id };
          }
          await settings.update(key, value, scope);
          return { key, value: settings.peek(key), scope };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "settings.reset",
        title: "Reset setting",
        category: "Preferences",
        description:
          "Removes settings from user or workspace settings.json (back to the next layer): one `key`, every setting of a `category` (as the settings editor groups them), or `all`. With `language` and `key` / `keys`, from that language's block instead. In a multi-root workspace, scope folder resets one folder's own settings (`folder`). Returns the keys that were reset.",
        input: s.object({
          key: s.string().describe("Setting key").optional(),
          keys: s.array(s.string()).describe("Several setting keys (a section)").optional(),
          category: s.string().describe("A settings editor section, e.g. Editor").optional(),
          all: s.boolean().describe("Every setting in that scope").optional(),
          except: s
            .array(s.string())
            .describe("Keys left as they are (e.g. agent.providers, D166)")
            .optional(),
          scope: scopeInput,
          language: languageInput,
          folder: folderInput,
        }),
        effects: ["write"],
        agent: "discoverable",
        run: async (
          { key, keys: list, category, all, except = [], scope: asked = "user", language, folder },
          ctx,
        ) => {
          if (
            notUser(ctx.caller.kind) &&
            (all ||
              (category ?? "").toLowerCase() === "agent" ||
              (key && AGENT_GUARDED.test(key)) ||
              list?.some((k) => AGENT_GUARDED.test(k)))
          )
            throw new Error(
              "Agent permission settings can only be reset by you, not by the agent.",
            );
          const where = await place(asked, folder);
          if (where.scope === "folder") {
            const id = language ? normalizeLanguageId(language) : undefined;
            if (id && !key && !list) throw new Error("With `language`, give `key` or `keys`.");
            if (!key && !list && !category && !all)
              throw new Error("Give `key`, `keys`, `category` or `all`.");
            const wanted = key
              ? [key]
              : (list ??
                settings.registry
                  .all()
                  .filter((info) => all || info.category === category)
                  .map((info) => info.key));
            const keys = wanted
              .filter((k) => !except.includes(k))
              .filter((k) => inspectFolder(settings, where.folder, k, id) !== undefined);
            checkExtension(ctx.caller, keys);
            for (const k of keys) await settings.updateAt(k, undefined, where.folder, id);
            return { reset: keys, folder: folderName(where.folder), ...(id && { language: id }) };
          }
          const scope = where.scope;
          if (language) {
            const id = normalizeLanguageId(language);
            const keys = (key ? [key] : (list ?? []))
              .filter((k) => !except.includes(k))
              .filter((k) => settings.model.inspectForLanguage(k, scope, id) !== undefined);
            if (!key && !list) throw new Error("With `language`, give `key` or `keys`.");
            checkExtension(ctx.caller, keys);
            for (const k of keys) await settings.updateForLanguage(id, k, undefined, scope);
            return { reset: keys, language: id };
          }
          if (key) {
            checkKey(key);
            checkExtension(ctx.caller, [key]);
            await settings.update(key, undefined, scope);
            return { reset: [key] };
          }
          if (list) {
            const changed = list
              .filter((k) => !except.includes(k) && settings.registry.get(k))
              .filter((k) => settings.model.inspect(k, scope) !== undefined);
            checkExtension(ctx.caller, changed);
            for (const k of changed) await settings.update(k, undefined, scope);
            return { reset: changed };
          }
          if (!category && !all) throw new Error("Give `key`, `keys`, `category` or `all`.");
          const keys = settings.registry
            .all()
            .filter((info) => all || info.category === category)
            .map((info) => info.key)
            .filter((k) => !except.includes(k))
            .filter((k) => settings.model.inspect(k, scope) !== undefined);
          checkExtension(ctx.caller, keys);
          for (const k of keys) await settings.update(k, undefined, scope);
          return { reset: keys };
        },
      }),
    );

    sub.add(
      state.register("ide://settings", {
        description:
          'Settings: file paths per scope, every registered setting with its effective value, where it comes from, its schema, the values languages set for themselves (`languages`: id → key → value, from `"[python]": {…}` blocks), files.associations, and problems in the files. In a multi-root workspace, `files.workspace` is the workspace file and `folders` lists each folder\'s own settings file and the keys it sets.',
        get: ({ budget }) => {
          const entries = settings.registry.all().map((info) => {
            const { value, source } = settings.model.resolve(info.key);
            return {
              key: info.key,
              value,
              source,
              type: info.type,
              default: info.default,
              ...(info.enum && { enum: info.enum }),
              ...(budget > 4000 && { description: info.description }),
            };
          });
          return {
            files: {
              user: settings.filePath("user"),
              workspace: workspace.root.peek() ? settings.filePath("workspace") : null,
            },
            settings: entries,
            // Languages with their own values (`"[python]": {…}`, D201), each key's value for it.
            languages: Object.fromEntries(
              settings.model.overriddenLanguages().map((id) => {
                const values: Record<string, unknown> = {};
                for (const info of settings.registry.all()) {
                  const r = settings.model.resolveForLanguage(info.key, id);
                  if (r.language) values[info.key] = r.value;
                }
                return [id, values];
              }),
            ),
            associations: settings.peek("files.associations"),
            problems: settings.model.problems(),
            // Each folder's own settings (D251): only in a multi-root workspace.
            ...(workspace.isMultiRoot() && {
              folders: workspace.folders.peek().map((f) => ({
                name: f.name,
                path: f.path,
                settingsFile: settings.folderSettingsPath(f.path),
                set: Object.keys(settings.folderValues(f.path)).sort(),
              })),
            }),
          };
        },
      }),
    );
  },
};
