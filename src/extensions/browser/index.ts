// Browser (PLAN §8.5, D89): previews of local dev servers and workspace HTML in a dock tab, other
// sites in the tab (`browser.embedSites`) or their own window, downloads, and commands that let agents see and drive the page through the
// injected bridge (snapshot with element refs, click, type, press, select, scroll, text, wait,
// console, eval). HTML files get "Open preview" (Ctrl/Cmd+Shift+V) like Markdown, and reload on
// save. Rust side: `src-tauri/src/browser` (proxy with WebSocket upgrades, bridge script).

import { evalPlan } from "../../core/agent/browserEval";
import { textMatcher } from "../../core/agent/browserInput";
import type { Json } from "../../core/dock/index";
import type { BuiltinExtension } from "../../core/extensions/index";
import { browserIpc } from "../../core/ipc/browser";
import { samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type Address, displayAddress, parseAddress, rootsOf } from "./address";
import { registerDevtoolsCommands } from "./commands";
import { applyDownload, downloadsSignal, registerDownloads } from "./downloads";
import manifest from "./extension.json";
import {
  EXTERNAL_TAB,
  ExternalBrowser,
  type PageTarget,
  registerExternalCommands,
} from "./external";
import { registerInputCommands } from "./inputCommands";
import { registerLive } from "./live";
import type { PendingForm, PopupLink, TabExtras } from "./opening";
import { problemCounts } from "./page";
import { type InputRequest, runInput } from "./trustedInput";
import { addressFromState, type BrowserHost, BrowserView } from "./view";

const locator = {
  ref: s.string().describe("Element ref from browser.snapshot, e.g. e12").optional(),
  selector: s.string().describe("CSS selector").optional(),
  name: s.string().describe("Accessible name or visible text of the element").optional(),
};
const tabInput = s
  .string()
  .describe("Browser tab id (default: the active or most recent browser tab)")
  .optional();

function sameAddress(a: Address | null, b: Address): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return samePath(a.path, b.path);
  return "url" in a && "url" in b && a.url.replace(/\/$/, "") === b.url.replace(/\/$/, "");
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export const browserExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dock, dispatcher, workspace, viewers, events, state } = services;
    // Forms posted into new tabs, by the token in the new tab's state (taken once).
    const forms = new Map<string, PendingForm>();
    let formSeq = 0;
    const host: BrowserHost = {
      services,
      views: new Map(),
      windows: new Map(),
      run: (command, input = {}) => void dispatcher.execute(command, input).catch(() => {}),
      // A page's new tab opens in the same group as its own (VS Code's integrated browser too).
      openTab: (address, opener, extras) => open(address, false, true, false, opener, extras),
      takeForm: (token) => {
        if (typeof token !== "string") return null;
        const form = forms.get(token) ?? null;
        forms.delete(token);
        return form;
      },
    };
    const downloads = downloadsSignal();
    // The workspace's folder, or its folders (D251: files show with their folder's name).
    const root = () => rootsOf(workspace);

    sub.add(
      dock.views.register({
        type: "browser",
        title: (st) => {
          const a = addressFromState(st, root());
          if (!a) return "Browser";
          return a.kind === "file"
            ? displayAddress(a, root()).split("/").pop() || "Preview"
            : a.url.replace(/^https?:\/\//, "");
        },
        icon: () => "globe",
        resource: (st) => {
          const a = addressFromState(st, root());
          return a?.kind === "file" ? a.path : undefined;
        },
        tooltip: (st) => {
          const a = addressFromState(st, root());
          return a ? displayAddress(a, root()) : "Browser";
        },
        defaultPlacement: "main",
        editorLike: true,
        detachable: true,
        duplicate: (st) => st,
        create: (st, ctx) => new BrowserView(st, ctx, host),
      }),
    );
    sub.add(
      viewers.register({
        id: "browser",
        label: "Browser preview",
        viewType: "browser",
        extensions: [".html", ".htm"],
        kind: "preview",
        icon: "globe",
      }),
    );

    // Live reload of workspace previews, and external windows' reports.
    let servedStatic = false;
    const changed = ({ path }: { path: string }) => {
      if (!workspace.contains(path)) return;
      // Saved: the file on disk is the truth again, and once a static preview has been served,
      // the proxy hears of it so the preview open in an outside browser reloads too (D284).
      if (servedStatic || [...host.views.values()].some((v) => v.current?.kind === "file")) {
        servedStatic = true;
        overlaid.delete(path);
        void browserIpc.overlay(path, null).catch(() => {});
      }
      for (const view of host.views.values()) view.fileChanged(path);
    };
    // Live preview while typing (VS Code's Live Preview): unsaved text is served in place of the
    // file, then the preview reloads (stylesheets swap without a reload).
    const overlaid = new Set<string>();
    const typing = new Map<string, ReturnType<typeof setTimeout>>();
    sub.add(
      services.documents.onDidChange((path) => {
        if (services.settings.peekAt<boolean>("browser.liveReload.onEdit", path) === false) return;
        if (!workspace.contains(path)) return;
        if (![...host.views.values()].some((v) => v.current?.kind === "file")) return;
        clearTimeout(typing.get(path));
        typing.set(
          path,
          setTimeout(() => {
            typing.delete(path);
            const text = services.documents.text(path);
            if (text === null) return;
            overlaid.add(path);
            void browserIpc
              .overlay(path, text)
              .then(() => {
                for (const view of host.views.values()) view.fileChanged(path);
              })
              .catch(() => {});
          }, 300),
        );
      }),
    );
    sub.add({
      dispose: () => {
        for (const t of typing.values()) clearTimeout(t);
      },
    });
    for (const name of [
      "files.didSave",
      "files.didChange",
      "files.didCreate",
      "files.didDelete",
    ] as const)
      sub.add(events.on(name, changed as never));
    void browserIpc
      .subscribe({
        network: (e) => {
          for (const view of host.views.values())
            if (view.proxyOrigin === e.origin) view.networkEvent(e);
        },
        bridge: (label, message) => host.windows.get(label)?.windowMessage(message),
        windowClosed: (label) => {
          const view = host.windows.get(label);
          host.windows.delete(label);
          view?.windowClosed();
        },
        download: (d) => {
          downloads.value = applyDownload(downloads.peek(), d);
        },
      })
      .catch(() => {});

    // The user's own browser (D341): a target of the page commands as "external".
    const external = new ExternalBrowser(services);
    sub.add(external);
    let lastActive: string | undefined;
    // `browserFocus`: the focused group shows a browser tab (its shortcuts apply).
    sub.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        const active = dock.activeTab();
        services.context.set("browserFocus", active?.viewType === "browser");
        // Another browser tab brought forward is what the commands act on again.
        if (active?.viewType === "browser" && active.id !== lastActive) external.deselect();
        lastActive = active?.id;
        return undefined;
      }),
    );

    /** The browser tab a command acts on: `tab`, the active one, else the most recent. */
    const target = (tab?: string): BrowserView => {
      if (tab) {
        const v = host.views.get(tab);
        if (!v) throw new Error(`No browser tab ${tab}.`);
        return v;
      }
      const active = dock.activeTab();
      if (active?.viewType === "browser") {
        const v = host.views.get(active.id);
        if (v) return v;
      }
      const recent = dock.recentTab((t) => t.viewType === "browser");
      const v = recent ? host.views.get(recent.id) : undefined;
      if (!v) throw new Error("No browser tab is open (browser.open).");
      return v;
    };
    /** What page commands act on: `tab`, the external browser while it's chosen, else a tab. */
    const pageTarget = (tab?: string): PageTarget =>
      external.handles(tab) ? external : target(tab);
    /** Page input as a person's (D346): `browser.trustedInput`, on unless turned off. */
    const trustedInputOn = () => services.settings.peek<boolean>("browser.trustedInput") !== false;
    /** How input reaches a page now (D346; ide://browser). */
    const inputKind = (t: PageTarget) =>
      trustedInputOn() && typeof t.inputSink?.() === "object" ? "trusted" : "synthesized";
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Browser", ...c }));

    /** The biggest visible group that holds editors (or nothing): where a page has room. */
    const largestEditorGroup = (): string | undefined => {
      let best: { id: string; area: number } | undefined;
      for (const el of document.querySelectorAll<HTMLElement>(".dock-group[data-group-id]")) {
        const id = el.dataset.groupId ?? "";
        const g = dock.findGroup(id);
        if (!g || g.hidden || (g.tabs.length && !g.tabs.some(dock.isEditorLike))) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 0 && (!best || area > best.area)) best = { id, area };
      }
      return best?.id;
    };

    const open = async (
      address: Address | null,
      toSide: boolean,
      newTab: boolean,
      largest = false,
      /** The tab whose page opened this one. */
      opener?: string,
      extras: TabExtras = {},
    ): Promise<string> => {
      const popup: PopupLink | undefined = extras.popup;
      if (address && !newTab) {
        const views = [...host.views.values()];
        // The same page, else (a dev server) any tab on the same server.
        const existing =
          views.find((v) => sameAddress(v.current, address)) ??
          (address.kind === "local"
            ? views.find(
                (v) => v.current?.kind === "local" && sameOrigin(v.current.url, address.url),
              )
            : undefined);
        if (existing) {
          dock.activateTab(existing.tabId, true);
          // Same server, another page asked for: go there (the server's root just shows the tab).
          if (
            !sameAddress(existing.current, address) &&
            address.kind === "local" &&
            new URL(address.url).pathname !== "/"
          )
            await existing.load(address);
          return existing.tabId;
        }
      }
      const where: { [key: string]: Json } | null = address
        ? address.kind === "file"
          ? { path: address.path }
          : { url: address.url }
        : null;
      let formToken: string | undefined;
      if (extras.form) {
        formToken = `f${++formSeq}`;
        forms.set(formToken, extras.form);
      }
      const st: Json = where && {
        ...where,
        ...(popup && { popup: { ...popup } }),
        ...(extras.name && { name: extras.name }),
        ...(formToken && { formToken }),
      };
      // A page's own new tab goes beside it, in its group.
      const openerGroup = opener ? dock.findTab(opener)?.group.id : undefined;
      if (openerGroup) return dock.openView("browser", st, { groupId: openerGroup }, true);
      const group = dock.focusedGroup();
      let placement: Parameters<typeof dock.openView>[2] = "main";
      const big = largest ? largestEditorGroup() : undefined;
      if (big) placement = { groupId: big };
      else if (toSide && group) {
        const right = dock.neighbor(group.id, "right");
        const rightGroup = right ? dock.findGroup(right) : undefined;
        placement =
          right &&
          rightGroup &&
          (rightGroup.tabs.length === 0 || rightGroup.tabs.some(dock.isEditorLike))
            ? { groupId: right }
            : { groupId: group.id, split: "right" };
      } else if (group?.tabs.some(dock.isEditorLike)) placement = { groupId: group.id };
      return dock.openView("browser", st, placement, true);
    };

    register({
      id: "browser.open",
      title: "Open browser",
      description:
        "Opens a page in a browser tab: a local dev server (`url: http://localhost:5173`), a workspace HTML file (`path`, served with live reload) or another site (`url`, in its own window). Reuses a tab already showing it unless `newTab`. Without input, an empty tab.",
      input: s.object({
        url: s
          .string()
          .describe("Address: http://localhost:3000, localhost:5173, https://…")
          .optional(),
        path: s.string().describe("Workspace file to preview, e.g. index.html").optional(),
        toSide: s.boolean().describe("Open beside the current group").optional(),
        largest: s
          .boolean()
          .describe("Open in the biggest editor group (links from the terminal)")
          .optional(),
        newTab: s.boolean().optional(),
        window: s.boolean().describe("Show it in its own window even if it's local").optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ url, path, toSide, largest, newTab, window: inWindow }) => {
        const address = path
          ? ({ kind: "file", path: workspace.resolve(path) } as const)
          : url
            ? parseAddress(url, root())
            : null;
        if ((url || path) && !address) throw new Error(`"${url ?? path}" isn't an address.`);
        const tabId = await open(
          inWindow ? null : address,
          toSide ?? false,
          (newTab ?? false) || (inWindow ?? false),
          largest ?? false,
        );
        const view = host.views.get(tabId);
        if (inWindow && address && view) await view.load(address, true);
        if (address && view) await view.page.whenReady(10000).catch(() => {});
        return {
          tab: tabId,
          url: view?.page.url.peek() ?? "",
          title: view?.page.title.peek() ?? "",
          connected: view?.page.connected.peek() ?? false,
        };
      },
    });
    register({
      id: "browser.navigate",
      title: "Go to address",
      description:
        "Navigates a browser tab to an address (dev server, workspace file or web address).",
      input: s.object({ url: s.string(), tab: tabInput }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ url, tab }) => {
        if (external.handles(tab)) return external.navigate(url);
        const view = target(tab);
        await view.go(url);
        await view.page.whenReady(10000).catch(() => {});
        return { url: view.page.url.peek(), title: view.page.title.peek() };
      },
    });
    for (const [id, title, method] of [
      ["browser.back", "Back", "back"],
      ["browser.forward", "Forward", "forward"],
    ] as const)
      register({
        id,
        title,
        description: `Goes ${method} in a browser tab's history.`,
        input: s.object({ tab: tabInput }),
        effects: [],
        agent: "discoverable",
        run: async ({ tab }) =>
          external.handles(tab) ? external.history(method) : target(tab).history(method),
      });
    register({
      id: "browser.reload",
      title: "Reload page",
      description: "Reloads the page in a browser tab.",
      input: s.object({ tab: tabInput }),
      effects: [],
      agent: "discoverable",
      run: async ({ tab }) => {
        if (external.handles(tab)) await external.reload();
        else target(tab).reload();
        return { reloading: true };
      },
    });

    register({
      id: "browser.snapshot",
      title: "Page snapshot",
      description:
        "The page as an outline of roles and names (headings, links, buttons, inputs with values, text) with element refs like [ref=e12] for browser.click / browser.type. Pass `ref` to see only part of the page.",
      input: s.object({
        tab: tabInput,
        ref: s.string().describe("Only this element's subtree").optional(),
        maxChars: s.integer({ min: 500, max: 40000 }).optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ tab, ref, maxChars }) =>
        pageTarget(tab).page.call("snapshot", { ...(ref && { ref }), maxChars: maxChars ?? 12000 }),
    });
    const action = (
      id: string,
      title: string,
      method: string,
      description: string,
      extra: Record<string, ReturnType<typeof s.string>> = {},
    ) =>
      register({
        id,
        title,
        description,
        input: s.object({ tab: tabInput, ...locator, ...extra }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ tab, ...params }) => {
          const t = pageTarget(tab as string | undefined);
          const bridge = () => t.page.call(method, params);
          // A person's click, hover or key (D346), else the bridge's.
          const op = ({ click: "click", hover: "hover", press: "key" } as const)[
            method as "click" | "hover" | "press"
          ];
          if (!op) return bridge();
          const request: InputRequest =
            op === "key"
              ? {
                  ...params,
                  op,
                  keys: [{ key: String((params as { key?: unknown }).key || "Enter") }],
                }
              : { ...params, op };
          return runInput(t, request, bridge, trustedInputOn());
        },
      });
    action(
      "browser.click",
      "Click element",
      "click",
      "Clicks an element of the page (by ref from browser.snapshot, CSS selector or accessible name).",
    );
    action(
      "browser.hover",
      "Hover element",
      "hover",
      "Moves the pointer over an element (menus, tooltips).",
    );
    register({
      id: "browser.type",
      title: "Type into element",
      description:
        "Types into an input, text area or editable element (replacing its value unless `clear: false`); `submit` presses Enter after.",
      input: s.object({
        tab: tabInput,
        ...locator,
        text: s.string().describe("Text to type"),
        clear: s.boolean().optional(),
        submit: s.boolean().optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ tab, ...params }) => {
        const t = pageTarget(tab);
        return runInput(
          t,
          { op: "type", ...params },
          () => t.page.call("type", params),
          trustedInputOn(),
        );
      },
    });
    action(
      "browser.press",
      "Press key",
      "press",
      "Presses a key (Enter, Escape, Tab, ArrowDown…) on an element or the focused one.",
      {
        key: s.string().describe("Key name, e.g. Enter"),
      },
    );
    action(
      "browser.select",
      "Select option",
      "select",
      "Chooses an option of a <select> by value or label.",
      {
        value: s.string().describe("Option value or label"),
      },
    );
    register({
      id: "browser.scroll",
      title: "Scroll page",
      description:
        "Scrolls an element into view, the page by `dy` pixels (default: most of a screen), or to the top/bottom.",
      input: s.object({
        tab: tabInput,
        ...locator,
        dy: s.number().optional(),
        to: s.enum(["top", "bottom"] as const).optional(),
      }),
      effects: [],
      agent: "discoverable",
      run: async ({ tab, ...params }) => pageTarget(tab).page.call("scroll", params),
    });
    register({
      id: "browser.text",
      title: "Page text",
      description:
        "The visible text of the page or of one element. `main`: the page's main content (its article or main element, else the whole page), with where it came from.",
      input: s.object({
        tab: tabInput,
        ...locator,
        main: s.boolean().optional(),
        maxChars: s.integer({ min: 100, max: 50000 }).optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ tab, main, ...params }) =>
        main && !params.ref && !params.selector && !params.name
          ? pageTarget(tab).page.call("pageText", { maxChars: params.maxChars ?? 20000 })
          : pageTarget(tab).page.call("text", params),
    });
    register({
      id: "browser.wait",
      title: "Wait for page",
      description:
        "Waits until the page shows `text` or has an element matching `selector` (default: finished loading). Up to 30 s.",
      input: s.object({
        tab: tabInput,
        text: s.string().optional(),
        selector: s.string().optional(),
        timeoutMs: s.integer({ min: 100, max: 30000 }).optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ tab, ...params }) => pageTarget(tab).page.call("waitFor", params),
    });
    register({
      id: "browser.eval",
      title: "Run script in page",
      description:
        "Evaluates JavaScript in the page and returns the result (awaited, as text). `repl`: as a console does (the last expression's value, top-level await) with the result as JSON and its type. Asks first.",
      input: s.object({
        tab: tabInput,
        code: s.string(),
        repl: s.boolean().optional(),
        maxChars: s.integer({ min: 100, max: 100000 }).optional(),
      }),
      effects: ["exec"],
      agent: "discoverable",
      run: async ({ tab, code, repl, maxChars }) =>
        repl
          ? pageTarget(tab).page.call("evalRepl", {
              code,
              ...evalPlan(code),
              maxChars: maxChars ?? 10000,
            })
          : pageTarget(tab).page.call("eval", { code }),
    });
    register({
      id: "browser.console",
      title: "Page console",
      description:
        "The page's console messages and uncaught errors, plus failed network requests (status ≥ 400 or no answer). `level: error` for errors only; `pattern` keeps messages and requests matching it (a regular expression, case-insensitive, else text); `clear` empties it.",
      input: s.object({
        tab: tabInput,
        level: s.enum(["error", "warn", "all"] as const).optional(),
        pattern: s.string().optional(),
        limit: s.integer({ min: 1, max: 300 }).optional(),
        clear: s.boolean().optional(),
      }),
      effects: ["read"],
      // Listed for external agents (MCP: browser_console), the name the IDE's agent has (D365).
      agent: "core",
      run: ({ tab, level, pattern, limit, clear }) => {
        const page = pageTarget(tab).page;
        const keep = (l: string) =>
          level === "error"
            ? l === "error"
            : level === "warn"
              ? l === "error" || l === "warn"
              : true;
        const n = limit ?? 50;
        const matches = textMatcher(pattern);
        const result = {
          url: page.url.peek(),
          console: page.console
            .peek()
            .filter((e) => keep(e.level) && matches(e.text))
            .slice(-n),
          failedRequests: page.network
            .peek()
            .filter((r) => matches(`${r.status} ${r.url} ${r.error ?? ""}`))
            .slice(-n),
        };
        if (clear) page.clearConsole();
        return result;
      },
    });
    register({
      id: "browser.toggleConsole",
      title: "Show page console",
      description: "Opens DevTools on the Console of a browser tab.",
      input: s.object({ tab: tabInput }),
      effects: [],
      agent: "hidden",
      run: ({ tab }) => target(tab).openDevtools("console"),
    });
    registerDevtoolsCommands(register, target, host, pageTarget);
    registerInputCommands(register, pageTarget, host, external, trustedInputOn);
    registerExternalCommands(register, external);
    sub.add(registerLive(register, host));
    sub.add(registerDownloads(register, services, downloads));

    const summary = (v: BrowserView) => {
      const { errors, warnings } = problemCounts(v.page);
      return {
        tab: v.tabId,
        url: v.page.url.peek(),
        title: v.page.title.peek(),
        shownIn: v.shownIn,
        connected: v.page.connected.peek(),
        errors,
        warnings,
        // Where the pane's frame loads from (the local proxy): the debugger attaches to it (D204).
        ...(v.proxyOrigin ? { frameOrigin: v.proxyOrigin } : {}),
      };
    };
    register({
      id: "browser.list",
      title: "List browser tabs",
      description: "Open browser tabs: url, title, whether the page is connected, error counts.",
      input: s.empty(),
      effects: ["read"],
      agent: "discoverable",
      run: () => {
        const outside = external.summary();
        return {
          tabs: [...[...host.views.values()].map(summary), ...(outside ? [outside] : [])],
          ...(outside && external.selected.peek() && { current: EXTERNAL_TAB }),
        };
      },
    });
    sub.add(
      state.register("ide://browser", {
        description:
          "Browser tabs: url, title, frame or window, connected, error and warning counts, the latest errors and failed requests, and whether input reaches the page as trusted or synthesized events. browser.snapshot shows the page itself.",
        get: () => [
          ...[...host.views.values()].map((v) => ({
            ...summary(v),
            recentErrors: v.page.console
              .peek()
              .filter((e) => e.level === "error")
              .slice(-10)
              .map((e) => ({ text: e.text.slice(0, 500), ...(e.source && { source: e.source }) })),
            failedRequests: v.page.network.peek().slice(-10),
            input: inputKind(v),
            ...(v.current?.kind === "file" && workspace.root.peek()
              ? { file: workspace.relative(v.current.path) }
              : {}),
          })),
          // The user's own browser while connected (D341).
          ...[external.summary()]
            .filter((x) => x !== null)
            .map((x) => ({ ...x, input: inputKind(external) })),
        ],
      }),
    );
  },
};
