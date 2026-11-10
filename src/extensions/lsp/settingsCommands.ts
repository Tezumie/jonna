// Language server settings as commands (D204): read a server's known settings with their values,
// set one, or replace its settings / initialization options as JSON. They write the user's
// `lsp.servers` (user scope only, like the rest of it); a settings change reaches the running
// server with workspace/didChangeConfiguration, an initialization options change restarts it.
// The "Language server settings" tab (settingsView.ts) is built on them. State: ide://lsp/settings.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { LspManager } from "./manager";
import {
  fieldFor,
  fieldKey,
  fieldsFor,
  getPath,
  type ServerSettingTarget,
  userOverrides,
  withServerJson,
  withServerSetting,
} from "./serverSettings";
import { serverSettingsViewDescriptor } from "./settingsView";

export interface ServerSettingValue {
  key: string;
  target: ServerSettingTarget;
  type: string;
  enum?: readonly string[];
  description: string;
  /** What the server gets (the user's, else the server definition's, else the default). */
  value: unknown;
  /** Set in the user's lsp.servers. */
  modified: boolean;
}

export interface ServerSettingsInfo {
  server: string;
  title: string;
  running: boolean;
  /** Known settings (a built-in list for common servers; empty for the others). */
  fields: ServerSettingValue[];
  /** The user's overrides, as written in lsp.servers. */
  settings: Record<string, unknown> | null;
  initializationOptions: unknown;
}

export function registerServerSettings(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: LspManager,
): void {
  const { dispatcher, settings, dock, state } = services;
  const userServers = () => settings.model.inspect("lsp.servers", "user");
  const configFor = (server: string) => {
    const config = manager.configs().find((c) => c.name === server);
    if (!config) throw new Error(`No language server named ${server}. See lsp.list.`);
    return config;
  };

  const info = (server: string): ServerSettingsInfo => {
    const config = configFor(server);
    const mine = userOverrides(userServers(), server);
    const fields = fieldsFor(server).map((f) => {
      const own = getPath(mine[f.target], f.path);
      const effective = getPath(config[f.target], f.path);
      return {
        key: fieldKey(f),
        target: f.target,
        type: f.type,
        ...(f.enum && { enum: f.enum }),
        description: f.description,
        value: effective !== undefined ? effective : (f.default ?? null),
        modified: own !== undefined,
      };
    });
    return {
      server,
      title: config.title ?? server,
      running: manager.statuses.peek().some((st) => st.name === server && st.state === "running"),
      fields,
      settings: (mine.settings as Record<string, unknown> | undefined) ?? null,
      initializationOptions: mine.initializationOptions ?? null,
    };
  };
  const write = (next: unknown) => settings.update("lsp.servers", next, "user");

  sub.add(
    dock.views.register(serverSettingsViewDescriptor(services, info, () => manager.configs())),
  );

  sub.add(
    dispatcher.register({
      id: "lsp.openServerSettings",
      title: "Language server settings",
      category: "Language servers",
      description:
        "Opens the settings page of a language server (`server`, default: the first one): its known settings as controls, plus its settings and initialization options as JSON.",
      input: s.object({ server: s.string().describe("Server name, as lsp.list shows").optional() }),
      effects: [],
      agent: "hidden",
      run: ({ server }) => {
        const name = server ?? manager.configs()[0]?.name;
        if (name) configFor(name);
        const tabId = dock.openView(
          "lspServerSettings",
          name ? { server: name } : null,
          "main",
          true,
        );
        return { tabId, server: name ?? null };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "lsp.serverSettings",
      title: "Read language server settings",
      category: "Language servers",
      description:
        "A language server's known settings (key, type, value, whether the user changed it) and the user's settings / initializationOptions overrides from lsp.servers.",
      input: s.object({ server: s.string().describe("Server name") }),
      effects: ["read"],
      agent: "discoverable",
      palette: false,
      run: ({ server }) => info(server),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "lsp.setServerSetting",
      title: "Set a language server setting",
      category: "Language servers",
      description:
        "Sets one setting of a language server in the user's lsp.servers.<server>.settings (or .initializationOptions with `target`), e.g. server 'pyright', key 'python.analysis.typeCheckingMode', value 'strict'. Omit `value` to go back to the server's own. A settings change is sent to the running server (workspace/didChangeConfiguration); an initialization option restarts it.",
      input: s.object({
        server: s.string().describe("Server name"),
        key: s.string().describe("Dotted key, as lsp.serverSettings lists it"),
        value: s.unknown().describe("New value (JSON); omit to reset").optional(),
        target: s
          .enum(["settings", "initializationOptions"])
          .describe("Default: where the key is known to live, else settings")
          .optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      palette: false,
      run: async ({ server, key, value, target }) => {
        configFor(server);
        const field = fieldFor(server, key, target);
        if (!field.path.length) throw new Error("Give the setting's key.");
        await write(withServerSetting(userServers(), server, field, value));
        return { server, key, target: field.target, value: value ?? null };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "lsp.setServerSettingsJson",
      title: "Set language server settings (JSON)",
      category: "Language servers",
      description:
        "Replaces a language server's `settings` and/or `initializationOptions` overrides in the user's lsp.servers.<server> (objects merged over the server's own; null or {} removes them).",
      input: s.object({
        server: s.string().describe("Server name"),
        settings: s.unknown().describe("Object, or null to remove").optional(),
        initializationOptions: s.unknown().describe("Value, or null to remove").optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      palette: false,
      run: async (input) => {
        configFor(input.server);
        const values: {
          settings?: Record<string, unknown> | null;
          initializationOptions?: unknown;
        } = {};
        if ("settings" in input) {
          const v = input.settings;
          if (v !== null && v !== undefined && (typeof v !== "object" || Array.isArray(v)))
            throw new Error('settings must be an object (sections such as { "python": {…} }).');
          values.settings = (v as Record<string, unknown> | null | undefined) ?? null;
        }
        if ("initializationOptions" in input)
          values.initializationOptions = input.initializationOptions ?? null;
        await write(withServerJson(userServers(), input.server, values));
        return info(input.server);
      },
    }),
  );
  sub.add(
    state.register("ide://lsp/settings", {
      description:
        "Per language server: its known settings with values and whether the user changed them, and the user's settings / initializationOptions overrides (lsp.servers).",
      get: () => ({ servers: manager.configs().map((c) => info(c.name)) }),
    }),
  );
}
