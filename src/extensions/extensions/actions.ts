// What VS Code offers on an extension (D258), as commands for its menu and page: Set Color Theme /
// Set File Icon Theme for one that brings themes, Enable / Disable in this workspace, Auto update,
// Install Specific Version, Download VSIX, Copy, Copy Link, and Add to Workspace Recommendations.
// The Open VSX ones work for VS Code packages (their id is publisher.name there).

import { isNewerVersion, storePageUrl, storeVersions } from "../../core/extensions/openVsx";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { clipboardIpc, dialogIpc } from "../../core/ipc/system";
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { setJsoncProperty } from "../../core/settings/jsoncEdit";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExtensionManager, ExtensionRecord } from "./manager";
import { storeUpdates } from "./store";

type Register = WorkbenchServices["dispatcher"]["register"];

const AUTO_UPDATE_DELAY_MS = 60_000;

/** `namespace.name` → its parts. */
function split(id: string): { namespace: string; name: string } {
  const at = id.indexOf(".");
  if (at <= 0) throw new Error(`"${id}" isn't publisher.name.`);
  return { namespace: id.slice(0, at), name: id.slice(at + 1) };
}

/** A VS Code package installed (not a development copy): Open VSX may have it. */
/** Extensions with a Go Live of their own: the browser's steps aside for them (D284). */
const LIVE_SERVER_EXTENSIONS = [
  "ritwickdey.liveserver",
  "ms-vscode.live-server",
  "yandeu.five-server",
];

export function fromStore(r: ExtensionRecord): boolean {
  return !r.dev && r.manifest?.format === "vscode";
}

export function registerExtensionActions(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
  register: Register,
): void {
  const { dispatcher, quickInput, notifications } = services;
  const record = (id: string) => {
    const r = manager.get(id);
    if (!r?.manifest) throw new Error(`No extension ${id}.`);
    return r as ExtensionRecord & { manifest: NonNullable<ExtensionRecord["manifest"]> };
  };
  const id = s.string().describe("Extension id (publisher.name)");

  // A minute after start (D258, D265): extensions that update by themselves are updated; the
  // others' newer versions are a notice and a number on the Extensions icon (VS Code's
  // extensions.autoCheckUpdates), never installed unasked. Only with extensions from Open VSX.
  // Extensions with a Go Live of their own (D284): while one is on, the browser's Go Live leaves
  // the status bar to it (browser/live.ts reads the context key).
  sub.add(
    effect(() => {
      const on = manager.records.value.some(
        (r) =>
          LIVE_SERVER_EXTENSIONS.includes(r.id.toLowerCase()) &&
          r.status !== "disabled" &&
          r.status !== "invalid",
      );
      services.context.set("liveServerExtensionEnabled", on);
      return undefined;
    }),
  );
  const timer = window.setTimeout(() => void checkAtStart(), AUTO_UPDATE_DELAY_MS);
  sub.add(toDisposable(() => window.clearTimeout(timer)));
  sub.add(
    effect(() => {
      const n = storeUpdates.value.length;
      services.views.setBadge(
        "extensions.view",
        n,
        n === 1 ? "1 extension update" : `${n} extension updates`,
      );
      return undefined;
    }),
  );
  const checkAtStart = async () => {
    if (services.settings.peek<boolean>("extensions.store.enabled") === false) return;
    const installed = manager.records.peek().filter(fromStore);
    const wanted = installed.filter((r) => manager.autoUpdates(r.id));
    const notify = services.settings.peek<boolean>("extensions.autoCheckUpdates") !== false;
    if (!wanted.length && !(notify && installed.length)) return;
    const found = (await dispatcher
      .execute("extensions.checkStoreUpdates", {})
      .catch(() => null)) as { updates?: { id: string; latest: string }[] } | null;
    const left: string[] = [];
    for (const u of found?.updates ?? []) {
      if (!wanted.some((r) => r.id === u.id)) {
        left.push(u.id);
        continue;
      }
      await dispatcher
        .execute("extensions.installFromStore", { id: u.id, version: u.latest })
        .catch(() => {});
    }
    if (notify && left.length) notifyUpdates(left);
  };
  const notifyUpdates = (ids: string[]) => {
    const name = (id: string) => manager.get(id)?.manifest?.displayName ?? id;
    notifications.show(
      "info",
      ids.length === 1
        ? `An update is available for ${name(ids[0] ?? "")}.`
        : `Updates are available for ${ids.length} extensions.`,
      {
        actions: [
          {
            label: ids.length === 1 ? "Update" : "Update all",
            run: () => void dispatcher.execute("extensions.updateFromStore", {}).catch(() => {}),
          },
          {
            label: "Show",
            run: () => void dispatcher.execute("extensions.show", {}).catch(() => {}),
          },
        ],
      },
    );
  };

  register({
    id: "extensions.setColorTheme",
    title: "Set color theme",
    description:
      "Uses a color theme an extension brings (VS Code's Set Color Theme on its page): its only one, or a pick of them.",
    input: s.object({ id }),
    effects: [],
    agent: "discoverable",
    run: async ({ id: extId }) => {
      const themes = record(extId).manifest.contributes.themes;
      if (!themes.length) throw new Error(`${extId} brings no color theme.`);
      let label = themes[0]?.label;
      if (themes.length > 1) {
        const picked = await quickInput.pick(
          themes.map((t) => ({
            id: t.label,
            label: t.label,
            description: t.uiTheme.includes("light") ? "light" : "dark",
          })),
          { placeholder: "Color theme" },
        );
        if (!picked) return { theme: null };
        label = picked.id;
      }
      await dispatcher.execute("ui.selectColorTheme", { label });
      return { theme: label };
    },
  });

  register({
    id: "extensions.setFileIconTheme",
    title: "Set file icon theme",
    description:
      "Uses a file icon theme an extension brings (VS Code's Set File Icon Theme): its only one, or a pick of them.",
    input: s.object({ id }),
    effects: [],
    agent: "discoverable",
    run: async ({ id: extId }) => {
      const themes = record(extId).manifest.contributes.iconThemes;
      if (!themes.length) throw new Error(`${extId} brings no file icon theme.`);
      let themeId = themes[0]?.id;
      if (themes.length > 1) {
        const picked = await quickInput.pick(
          themes.map((t) => ({ id: t.id, label: t.label })),
          { placeholder: "File icon theme" },
        );
        if (!picked) return { theme: null };
        themeId = picked.id;
      }
      await dispatcher.execute("ui.selectFileIconTheme", { id: themeId });
      return { theme: themeId };
    },
  });

  register({
    id: "extensions.disableWorkspace",
    title: "Disable in this workspace",
    description:
      "Turns an extension off for the open workspace only (VS Code's Disable (Workspace)); it stays on elsewhere.",
    input: s.object({ id }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id: extId }) => {
      await manager.setEnabledHere(extId, false);
      return { disabled: true };
    },
  });

  register({
    id: "extensions.enableWorkspace",
    title: "Enable in this workspace",
    description: "Turns an extension back on in the open workspace (VS Code's Enable (Workspace)).",
    input: s.object({ id }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id: extId }) => {
      await manager.setEnabledHere(extId, true);
      return { enabled: true };
    },
  });

  register({
    id: "extensions.setAutoUpdate",
    title: "Auto update",
    description:
      "Whether an extension from Open VSX updates by itself (VS Code's Auto Update): `on` true or false, or null to follow extensions.autoUpdate; without `on`, toggles it.",
    input: s.object({ id, on: s.boolean().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id: extId, on }) => {
      const next = on ?? !manager.autoUpdates(extId);
      await manager.setAutoUpdate(extId, next);
      return { autoUpdate: next };
    },
  });

  register({
    id: "extensions.installSpecificVersion",
    title: "Install specific version…",
    description:
      "Installs another version of an extension from Open VSX (VS Code's Install Specific Version): `version`, or a pick of the versions Open VSX has.",
    input: s.object({ id, version: s.string().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id: extId, version }) => {
      let chosen = version;
      if (!chosen) {
        const { namespace, name } = split(extId);
        const versions = storeVersions(await extIpc.storeDetails(namespace, name));
        if (!versions.length) throw new Error(`Open VSX has no versions of ${extId}.`);
        const installed = manager.get(extId)?.manifest?.version;
        const picked = await quickInput.pick(
          versions.map((v) => ({
            id: v,
            label: v,
            ...(v === installed && { description: "installed" }),
            ...(installed && isNewerVersion(v, installed) && { description: "newer" }),
          })),
          { placeholder: `Version of ${extId} to install` },
        );
        if (!picked) return { installed: null };
        chosen = picked.id;
      }
      // A pinned version doesn't update itself away (VS Code's).
      await manager.setAutoUpdate(extId, false).catch(() => {});
      return dispatcher.execute("extensions.installFromStore", { id: extId, version: chosen });
    },
  });

  register({
    id: "extensions.downloadVsix",
    title: "Download VSIX…",
    description:
      "Saves an extension's .vsix from Open VSX where you choose (VS Code's Download VSIX): its latest version or `version` (`pickVersion` asks).",
    input: s.object({ id, version: s.string().optional(), pickVersion: s.boolean().optional() }),
    effects: ["write", "network"],
    agent: "discoverable",
    run: async ({ id: extId, version, pickVersion }) => {
      const { namespace, name } = split(extId);
      let chosen = version;
      if (!chosen && pickVersion) {
        const versions = storeVersions(await extIpc.storeDetails(namespace, name));
        const picked = await quickInput.pick(
          versions.map((v) => ({ id: v, label: v })),
          { placeholder: `Version of ${extId} to download` },
        );
        if (!picked) return { saved: null };
        chosen = picked.id;
      }
      const got = await extIpc.storeDownload(namespace, name, chosen);
      try {
        const target = await dialogIpc.pickSavePath(
          "Save VSIX",
          `${namespace}.${name}-${got.version}.vsix`,
        );
        if (!target) return { saved: null };
        await fsIpc.write(target, await fsIpc.read(got.file), "user");
        notifications.show("info", `Saved ${target}.`);
        return { saved: target, version: got.version };
      } finally {
        void extIpc.discardDownload(got.file).catch(() => {});
      }
    },
  });

  register({
    id: "extensions.copyInfo",
    title: "Copy",
    description:
      "Copies an extension's name, id, description, version, publisher and Open VSX link (VS Code's Copy).",
    input: s.object({ id }),
    effects: [],
    agent: "hidden",
    run: async ({ id: extId }) => {
      const r = record(extId);
      const m = r.manifest;
      const { namespace, name } = split(extId);
      const lines = [
        `Name: ${m.displayName}`,
        `Id: ${m.id}`,
        `Description: ${m.description}`,
        `Version: ${m.version}`,
        `Publisher: ${m.publisher}`,
        ...(fromStore(r) ? [`Open VSX Link: ${storePageUrl({ namespace, name })}`] : []),
      ];
      await clipboardIpc.writeText(lines.join("\n"));
      return { copied: true };
    },
  });

  register({
    id: "extensions.copyLink",
    title: "Copy link",
    description: "Copies the address of an extension's page on Open VSX (VS Code's Copy Link).",
    input: s.object({ id }),
    effects: [],
    agent: "hidden",
    run: async ({ id: extId }) => {
      const link = storePageUrl(split(extId));
      await clipboardIpc.writeText(link);
      return { link };
    },
  });

  register({
    id: "extensions.openStorePage",
    title: "Open on Open VSX",
    description:
      "Opens an extension's page on the Open VSX website in the browser; `reviews` opens its ratings and reviews (VS Code: clicking the stars).",
    input: s.object({ id, reviews: s.boolean().optional() }),
    effects: [],
    agent: "hidden",
    run: async ({ id: extId, reviews }) => {
      const url = `${storePageUrl(split(extId))}${reviews ? "/reviews" : ""}`;
      await dispatcher.execute("ui.openLink", { url });
      return { url };
    },
  });

  register({
    id: "extensions.addToRecommendations",
    title: "Add to workspace recommendations",
    description:
      "Adds an extension to the open folder's .vscode/extensions.json `recommendations` (VS Code's Add to Workspace Recommendations), so others who open it are offered it.",
    input: s.object({ id }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id: extId }) => {
      const root = services.workspace.root.peek();
      if (!root) throw new Error("Open a folder first.");
      const path = joinPath(joinPath(root, ".vscode"), "extensions.json");
      const old = await fsIpc
        .read(path)
        .then((b) => new TextDecoder().decode(b))
        .catch(() => "");
      const result = parseJsonc(old || "{}");
      const parsed = (result.ok ? (result.value ?? {}) : {}) as { recommendations?: unknown };
      const list = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
      if (list.some((x) => typeof x === "string" && x.toLowerCase() === extId.toLowerCase()))
        return { added: false, path };
      // Comments elsewhere in the file stay (only the list is written again).
      const text = old.trim()
        ? setJsoncProperty(old, "recommendations", [...list, extId])
        : `${JSON.stringify({ recommendations: [extId] }, null, 2)}\n`;
      await fsIpc.write(path, new TextEncoder().encode(text), "user");
      services.events.emit("files.didChange", { path });
      return { added: true, path };
    },
  });
}
