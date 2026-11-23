// The plain requests of an extension's worker, apart from runtime.ts (which starts and stops the
// extension) because they're the API's everyday part and read as one list: reading `ide://`
// state, files in the workspace, the active editor, notifications, quick pick and input, and
// `net.fetch`. Each is checked against the permissions the user granted.
import type { Caller } from "../../core/dispatcher/types";
import { missingBundledProgram } from "../../core/extensions/missingProgram";
import { canReadSetting, settingsStateForExtension } from "../../core/extensions/settingsAccess";
import {
  networkAllows,
  ownsStatePath,
  type ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { dirname } from "../../core/paths/index";
import { showDismissible } from "../../workbench/notices";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { findText } from "./runtimeEnv";
import { safeIcon } from "./treeView";
import type { LogLine } from "./workerHost";

/** `ide://` paths an extension may read, by the permission they need ("" = none). */
const STATE_PERMISSIONS: [prefix: string, permission: string][] = [
  ["ide://agent", "agent"],
  ["ide://browser", "browser"],
  ["ide://git", "git"],
  ["ide://terminals", "terminal"],
  ["ide://editors", "fs.read"],
  // Breakpoints and sessions for ide.debug (D255).
  ["ide://debug", "fs.read"],
  ["ide://diagnostics", "fs.read"],
  ["ide://history", "fs.read"],
  ["ide://search", "fs.read"],
  ["ide://workspace", "fs.read"],
  ["ide://layout", ""],
  ["ide://settings", ""],
  ["ide://keybindings", ""],
  ["ide://notifications", ""],
  ["ide://lsp", ""],
  ["ide://mcp", ""],
  ["ide://extensions", ""],
];

const LSP_SETTINGS = "ide://lsp/settings";

export interface BasicsDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** The extension's folder. */
  root: string;
  caller: Caller;
  /** The runtime's store: an unanswered notification resolves when the extension goes. */
  store: DisposableStore;
  need(permission: string, what: string): void;
  granted(): readonly string[];
  workspacePath(path: unknown): string;
  writablePath(path: unknown): string;
  log(line: LogLine): void;
  /** A quick pick with a checkbox per row (runtimeHooks.ts answers it). */
  pickMany(method: string, p: Record<string, unknown>): unknown;
}

/** The requests answered here. */
const REQUESTS: ReadonlySet<string> = new Set([
  "state.get",
  "fs.read",
  "fs.readBase64",
  "fs.writeBase64",
  "fs.write",
  "fs.stat",
  "fs.list",
  "fs.findText",
  "editor.active",
  "editor.insert",
  "ui.notify",
  "ui.showQuickPick",
  "ui.showInput",
  "net.fetch",
]);

export class ExtensionBasicsHost {
  constructor(private readonly deps: BasicsDeps) {}

  /** One of the requests above, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    return REQUESTS.has(method) ? this.answer(method, p) : UNHANDLED;
  }

  /**
   * Whether it may read setting `key` (D202). Its own are those it registered (or shares), not
   * those its manifest names: a key the IDE declared first stays the IDE's.
   */
  private readableSetting(key: string): boolean {
    const { manifest, services } = this.deps;
    const own = services.settings.registry.owners(key).includes(manifest.id) ? [key] : [];
    return canReadSetting(own, manifest.readsSettings, key);
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { services } = this.deps;
    switch (method) {
      case "state.get": {
        const path = String(p.path);
        const rule = STATE_PERMISSIONS.find(
          ([prefix]) => path === prefix || path.startsWith(`${prefix}/`),
        );
        // Its own state paths (what its code registered, D202).
        if (!rule && ownsStatePath(this.deps.manifest.id, path.split("?")[0] ?? path))
          return (await services.state.get(path)).value;
        if (!rule) throw new Error(`${path} isn't available to extensions.`);
        // Language servers' settings are lsp.servers by another name (commands, env with keys):
        // an area extensions never read (D202).
        const bare = path.split("?")[0] ?? path;
        if (bare === LSP_SETTINGS || bare.startsWith(`${LSP_SETTINGS}/`))
          throw new Error(`${path} isn't available to extensions.`);
        if (rule[1]) this.deps.need(rule[1], `read ${path}`);
        const value = (await services.state.get(path)).value;
        // Every setting's value is in there: only what `settings.get` would give it (D202).
        return rule[0] === "ide://settings"
          ? settingsStateForExtension(value, (key) => this.readableSetting(key))
          : value;
      }
      case "fs.read":
        this.deps.need("fs.read", "read files");
        return new TextDecoder().decode(await fsIpc.read(this.deps.workspacePath(p.path)));
      case "fs.readBase64": {
        this.deps.need("fs.read", "read files");
        const full = this.deps.workspacePath(p.path);
        // Checked before reading: a huge file never crosses into the page.
        if ((await fsIpc.stat(full)).size > 8 * 1024 * 1024)
          throw new Error(`${String(p.path)} is over 8 MB: too large to read this way.`);
        const bytes = await fsIpc.read(full);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      }
      case "fs.writeBase64": {
        this.deps.need("fs.write", "change files");
        const path = this.deps.writablePath(p.path);
        const text = String(p.data ?? "");
        if (text.length > 22 * 1024 * 1024) throw new Error("Too large to write this way (16 MB).");
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await fsIpc.write(path, bytes, "extension");
        services.events.emit("files.didChange", { path });
        return undefined;
      }
      case "fs.write": {
        this.deps.need("fs.write", "change files");
        const path = this.deps.writablePath(p.path);
        const existed = await fsIpc.stat(path).then(
          () => true,
          () => false,
        );
        await fsIpc.write(path, new TextEncoder().encode(String(p.text ?? "")), "extension");
        // A new file (and maybe its folders) shows in the explorer at once (D189).
        if (existed) services.events.emit("files.didChange", { path });
        else services.events.emit("files.didCreate", { path, kind: "file" });
        return undefined;
      }
      case "fs.stat":
        this.deps.need("fs.read", "read files");
        return fsIpc.stat(this.deps.workspacePath(p.path));
      case "fs.list":
        this.deps.need("fs.read", "read files");
        return (await fsIpc.listDir(this.deps.workspacePath(p.path))).map((e) => ({
          name: e.name,
          path: e.path,
          kind: e.kind,
        }));
      case "fs.findText":
        this.deps.need("fs.read", "search files");
        return findText(this.deps.services, p);
      case "editor.active": {
        this.deps.need("fs.read", "see the active editor");
        if (!services.state.has("ide://editors/active")) return null;
        const v = (await services.state.get("ide://editors/active")).value as {
          path?: string;
          absolutePath?: string | null;
          language?: string;
          cursor?: { line: number; column: number };
          selectedText?: string;
          selections?: {
            start: { line: number; column: number };
            end: { line: number; column: number };
          }[];
        } | null;
        if (!v?.absolutePath) return null;
        const cursor = v.cursor ?? { line: 1, column: 1 };
        const sel = v.selections?.[0];
        return {
          path: v.absolutePath,
          language: v.language ?? "",
          cursor,
          selectedText: v.selectedText ?? "",
          // The first selection (D208): a line range for line-based tools (line history).
          selection: sel
            ? {
                startLine: sel.start.line,
                startColumn: sel.start.column,
                endLine: sel.end.line,
                endColumn: sel.end.column,
              }
            : {
                startLine: cursor.line,
                startColumn: cursor.column,
                endLine: cursor.line,
                endColumn: cursor.column,
              },
        };
      }
      case "editor.insert":
        this.deps.need("fs.write", "type into the editor");
        await services.dispatcher.execute(
          "editor.insertText",
          { text: String(p.text ?? "") },
          this.deps.caller,
        );
        return undefined;
      case "ui.notify":
        return this.notify(p);
      case "ui.showQuickPick": {
        if (p.canPickMany === true) return this.deps.pickMany(method, p);
        const items = Array.isArray(p.items)
          ? (p.items as {
              label?: unknown;
              description?: unknown;
              icon?: unknown;
              detail?: unknown;
              separator?: unknown;
            }[])
          : [];
        const picked = await services.quickInput.pick(
          items.slice(0, 5000).map((item, i) => ({
            id: String(i),
            label: String(item?.label ?? ""),
            ...(typeof item?.separator === "string" && { separator: item.separator.slice(0, 80) }),
            ...(typeof item?.description === "string" && { description: item.description }),
            ...(typeof item?.icon === "string" && { icon: safeIcon(item.icon, "circle-dot") }),
            ...(typeof item?.detail === "string" && { detail: item.detail.slice(0, 1000) }),
          })),
          {
            placeholder: typeof p.placeholder === "string" ? p.placeholder : "",
            ...(typeof p.activeIndex === "number" &&
              p.activeIndex > 0 && { activeIndex: Math.floor(p.activeIndex) }),
            // VS Code's matchOnDescription (D234).
            ...(p.matchOnDescription === true && {
              matchOn: (item) => `${item.label} ${item.description ?? ""}`,
            }),
          },
        );
        return picked ? Number(picked.id) : null;
      }
      case "ui.showInput":
        return (
          (await services.quickInput.prompt({
            prompt: typeof p.prompt === "string" ? p.prompt : "",
            ...(typeof p.value === "string" && { value: p.value }),
            ...(typeof p.placeholder === "string" && { placeholder: p.placeholder }),
            ...(p.password === true && { password: true }),
            ...(typeof p.error === "string" && p.error && { error: p.error.slice(0, 500) }),
          })) ?? null
        );
      case "net.fetch": {
        const headers =
          p.headers && typeof p.headers === "object"
            ? Object.entries(p.headers as Record<string, unknown>).map(
                ([k, v]) => [k, String(v)] as [string, string],
              )
            : [];
        // Redirects are followed here, each new address checked against the permission (Rust
        // doesn't follow them: D203 audit). A 303, or a 301/302 after a POST, becomes a GET.
        let url = String(p.url);
        let method = typeof p.method === "string" ? p.method : "GET";
        let body = typeof p.body === "string" ? p.body : undefined;
        for (let hop = 0; ; hop++) {
          if (!networkAllows(this.deps.granted(), url))
            throw new Error(
              `${this.deps.manifest.displayName} may not connect to ${safeHost(url)}.`,
            );
          const r = await extIpc.fetch({
            url,
            method,
            headers,
            ...(body !== undefined && { body }),
          });
          const location = r.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
          if (r.status < 300 || r.status >= 400 || r.status === 304 || !location) return r;
          if (hop >= 5) throw new Error("Too many redirects.");
          url = new URL(location, url).toString();
          if (r.status === 303 || ((r.status === 301 || r.status === 302) && method !== "GET")) {
            method = "GET";
            body = undefined;
          }
        }
      }
      default:
        throw new Error(`Unknown request ${method}.`);
    }
  }

  private notify(p: Record<string, unknown>): Promise<string | null> {
    const kind = ["info", "success", "warning", "error"].includes(p.kind as string)
      ? (p.kind as "info" | "success" | "warning" | "error")
      : "info";
    const labels = Array.isArray(p.actions)
      ? p.actions.filter((a): a is string => typeof a === "string").slice(0, 3)
      : [];
    // A program its Open VSX build doesn't carry: one plain notice the user can turn off, not
    // an error on every start (D362).
    const missing = missingBundledProgram(String(p.message ?? ""), dirname(this.deps.root));
    if (missing) {
      this.deps.log({ time: Date.now(), level: "warn", text: String(p.message) });
      showDismissible(
        this.deps.services,
        `missing-program.${missing.extensionFolder}.${missing.program}`.toLowerCase(),
        "info",
        `${this.deps.manifest.displayName} couldn't start ${missing.program}: the Open VSX build of ${missing.extensionFolder} doesn't include it. What needs it won't work; the rest does.`,
      );
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let done = false;
      // Unanswered notifications resolve when the extension stops; an answered one leaves the
      // store (D261: one entry per message otherwise, for the extension's whole life).
      const pending = toDisposable(() => finish(null));
      const finish = (v: string | null) => {
        if (!done) {
          done = true;
          this.deps.store.delete(pending);
          resolve(v);
        }
      };
      this.deps.services.notifications.show(kind, String(p.message ?? "").slice(0, 2000), {
        title: this.deps.manifest.displayName,
        actions: labels.map((label) => ({ label, run: () => finish(label) })),
        onClose: () => finish(null),
      });
      if (!labels.length) finish(null);
      else this.deps.store.add(pending);
    });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.slice(0, 80);
  }
}
