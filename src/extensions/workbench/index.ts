// Built-in "workbench" extension: layout commands (layoutCommands.ts), appearance (appearance.ts),
// window commands, the welcome and agent views, dock persistence per workspace, `ide://layout`
// and the startup timings report.

import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc, clipboardIpc, openerIpc, windowIpc } from "../../core/ipc/system";
import { perf } from "../../core/perf";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import { applyBaseLayout, chosenStartLayout } from "../../workbench/baseLayout";
import { EventFeed, FEED_SIZE } from "../../workbench/eventFeed";
import {
  base64,
  captureRect,
  captureWindow,
  MODEL_MAX_SIDE,
  nextPaint,
  saveShot,
} from "../../workbench/screenshot";
import { scrollMemory } from "../../workbench/scrollMemory";
import type { WorkbenchServices } from "../../workbench/services";
import type { SectionState } from "../../workbench/views";
import type { Workbench } from "../../workbench/workbench";
import { registerAppearance } from "./appearance";
import { registerAuxCommands } from "./auxCommands";
import manifest from "./extension.json";
import {
  registerCloseDeleted,
  registerCloseRemovedFolders,
  registerFollowRenames,
} from "./followRenames";
import { registerIconThemes } from "./iconThemes";
import { registerLayoutCommands } from "./layoutCommands";
import { layoutTree } from "./layoutState";
import { registerManageMenu } from "./manageMenu";
import { registerMenus } from "./menus";
import { registerNotificationCommands } from "./notificationCommands";
import { registerProductIconThemes } from "./productIconThemes";
import { registerCommandProgress } from "./progress";
import { registerRegionCommands } from "./regionCommands";
import { registerShikiThemes } from "./shikiThemes";
import { registerStatusBarCommands } from "./statusBarCommands";
import { registerTabCommands } from "./tabCommands";
import { registerTabOptions } from "./tabOptions";
import { registerTrustCommands } from "./trustCommands";
import { registerUpdates } from "./updates";
import { welcomeViewDescriptor } from "./views";

/** The workbench is passed in because these commands drive the shell directly. */
export function createWorkbenchExtension(
  workbench: Workbench,
): BuiltinExtension<WorkbenchServices> {
  return {
    manifest,
    activate({ subscriptions: sub, services }) {
      registerCommandProgress(sub, services);
      const { dispatcher, layout, persistence, workspace, dock, notifications } = services;
      sub.add(dock.views.register(welcomeViewDescriptor(services)));
      registerLayoutCommands(sub, services);
      registerFollowRenames(sub, services);
      registerCloseDeleted(sub, services);
      registerCloseRemovedFolders(sub, services);
      // The whole status bar or single items hidden (D179, D383).
      registerStatusBarCommands(sub, services);
      // Centered layout (D192, VS Code's): text editors keep a readable width on wide screens.
      sub.add(
        effect(() => {
          services.settings.version.value;
          const on = services.settings.peek<boolean>("workbench.editor.centeredLayout") === true;
          document.querySelector(".workbench")?.classList.toggle("is-centered-layout", on);
          return undefined;
        }),
      );
      sub.add(
        dispatcher.register({
          id: "layout.toggleCenteredLayout",
          title: "Toggle centered layout",
          category: "View",
          description:
            "Keeps text editors at a readable width in the middle of wide editor groups (workbench.editor.centeredLayout), or lets them fill the group again.",
          input: s.empty(),
          effects: ["write"],
          run: async () => {
            const key = "workbench.editor.centeredLayout";
            const on = services.settings.peek<boolean>(key) === true;
            const scope =
              services.settings.model.inspect(key, "workspace") !== undefined
                ? "workspace"
                : "user";
            await services.settings.update(key, !on, scope);
            return { centered: !on };
          },
        }),
      );
      // The welcome page's "Coming from VS Code?" link, hidden for good by its × (D194).
      sub.add(
        dispatcher.register({
          id: "workbench.hideImportLink",
          title: "Hide the welcome page's import link",
          category: "View",
          description:
            'Hides the welcome page\'s "Coming from VS Code?" link for good (Help → Import from VS Code… stays).',
          input: s.empty(),
          effects: [],
          agent: "hidden",
          palette: false,
          run: async () => {
            for (const el of document.querySelectorAll<HTMLElement>(".welcome-import"))
              el.hidden = true;
            await services.persistence.saveGlobal({ hideImportLink: true });
            return { hidden: true };
          },
        }),
      );
      registerTabCommands(sub, services);
      registerTabOptions(sub, services);
      registerRegionCommands(sub, services, workbench);
      registerAppearance(sub, services);
      registerIconThemes(sub, services);
      registerProductIconThemes(sub, services);
      registerManageMenu(sub, services);
      registerShikiThemes(sub, services);
      registerMenus(sub, services);
      registerNotificationCommands(sub, services);
      registerAuxCommands(sub, services);
      registerTrustCommands(sub, services);
      registerUpdates(sub, services);
      /** What a region screenshot shows: a dock tab's view, a side bar view or a selector's match. */
      const regionOf = (view: string | undefined, selector: string | undefined): HTMLElement => {
        if (selector) {
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) throw new Error(`Nothing matches ${selector}.`);
          return el;
        }
        const want = view ?? "";
        const tab =
          dock.findTab(want)?.group.tabs.find((t) => t.id === want) ??
          dock.tabs(want).find((t) => dock.liveView(t.id)?.element.isConnected);
        const fromDock = tab ? dock.liveView(tab.id)?.element : undefined;
        const el =
          fromDock ?? document.querySelector<HTMLElement>(`[data-view="${CSS.escape(want)}"]`);
        if (!el || el.getClientRects().length === 0)
          throw new Error(`${want} isn't on screen: show it first (layout.openView or view.show).`);
        // A tab moved into a window of its own: this picture is of the main window only.
        if (el.ownerDocument !== document)
          throw new Error(`${want} is in a window of its own: move it back to take its picture.`);
        return el;
      };
      sub.add(
        dispatcher.register({
          id: "workbench.screenshot",
          title: "Take screenshot of the IDE",
          category: "Window",
          description:
            "A PNG of the IDE window as it is on screen (editors, terminals, browser tabs, panels). `save` writes it under the workspace's IDE folder (screenshots/) and `open` shows it; `inline` returns it as base64 `png` (scaled to at most 1568 px) for agents.",
          input: s.object({
            save: s.boolean().describe("Save it as a file (default true unless inline)").optional(),
            open: s
              .boolean()
              .describe("Open the saved file in a tab (default true when saved by the user)")
              .optional(),
            inline: s.boolean().describe("Return the image as base64").optional(),
            view: s
              .string()
              .describe(
                "Only this part (D191): a dock tab id, a view type (editor, terminal, agent… or an extension's view id), or a side bar view id (explorer.view)",
              )
              .optional(),
            selector: s.string().describe("Only the element matching this CSS selector").optional(),
          }),
          effects: ["read"],
          run: async ({ save, open, inline, view, selector }, ctx) => {
            // Menus and the palette close first, so they aren't in the picture.
            await nextPaint();
            const max = inline ? MODEL_MAX_SIDE : undefined;
            const region = view || selector ? regionOf(view, selector) : null;
            const shot = region
              ? await captureRect(region.getBoundingClientRect(), max)
              : await captureWindow(undefined, max);
            const root = workspace.root.peek();
            let path: string | null = null;
            if ((save ?? !inline) && root) {
              path = await saveShot(root, "ide", shot);
              if (open ?? ctx.caller.kind === "user")
                void dispatcher.execute("editor.openFile", { path }).catch(() => {});
            }
            return {
              width: shot.width,
              height: shot.height,
              path,
              ...(inline && { png: base64(shot.png) }),
            };
          },
        }),
      );

      // ---- Window ---------------------------------------------------------------------
      const closeWindow = async (): Promise<boolean> => {
        if (!(await workspace.confirmClose("window"))) return false;
        await persistence.flush();
        return true;
      };
      const windowCommand = (
        id: string,
        title: string,
        description: string,
        run: () => Promise<unknown>,
      ) =>
        sub.add(
          dispatcher.register({
            id,
            title,
            category: "Window",
            description,
            input: s.empty(),
            effects: [],
            run,
          }),
        );
      windowCommand("window.minimize", "Minimize window", "Minimizes the IDE window.", () =>
        windowIpc.minimize(),
      );
      windowCommand(
        "window.toggleMaximize",
        "Toggle maximize window",
        "Maximizes or restores the IDE window.",
        () => windowIpc.toggleMaximize(),
      );
      sub.add(
        services.dispatcher.register({
          id: "ui.copyText",
          title: "Copy text",
          category: "Edit",
          description: "Puts text on the system clipboard.",
          input: s.object({ text: s.string() }),
          effects: [],
          agent: "hidden",
          palette: false,
          run: ({ text }) => clipboardIpc.writeText(text),
        }),
      );
      sub.add(
        services.dispatcher.register({
          id: "ui.openLink",
          title: "Open link",
          category: "Help",
          description: "Opens an http(s) or mailto link in the system browser or mail app.",
          input: s.object({ url: s.string() }),
          effects: [],
          agent: "hidden",
          palette: false,
          run: ({ url }) => {
            if (!/^(https?|mailto):/i.test(url))
              throw new Error("Only http(s) and mailto links open.");
            return openerIpc.openUrl(url);
          },
        }),
      );
      windowCommand(
        "window.toggleFullscreen",
        "Toggle full screen",
        "Enters or leaves full screen (F11, Ctrl+Cmd+F on macOS; while debugging is paused F11 is Step Into, as in VS Code). Returns whether the window is full screen now.",
        async () => ({ fullscreen: await windowIpc.toggleFullscreen() }),
      );
      // UI zoom (VS Code's window.zoomLevel: each step is 20 %), kept in user settings.
      const zoomLevel = () => {
        const v = services.settings.peek<number>("window.zoomLevel");
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      };
      const setZoom = async (level: number) => {
        const next = Math.max(-5, Math.min(8, Math.round(level * 2) / 2));
        await services.settings.update("window.zoomLevel", next === 0 ? undefined : next, "user");
        return { zoomLevel: next, percent: Math.round(1.2 ** next * 100) };
      };
      windowCommand("window.zoomIn", "Zoom in", "Makes the whole UI bigger (20 % per step).", () =>
        setZoom(zoomLevel() + 1),
      );
      windowCommand("window.zoomOut", "Zoom out", "Makes the whole UI smaller.", () =>
        setZoom(zoomLevel() - 1),
      );
      windowCommand("window.zoomReset", "Reset zoom", "Back to 100 %.", () => setZoom(0));
      sub.add(
        effect(() => {
          services.settings.version.value;
          const scale = 1.2 ** zoomLevel();
          void windowIpc.setZoom(scale).catch(() => {});
          return undefined;
        }),
      );
      // Header buttons always visible (D169; on by default since D196): off, they show on hover
      // or focus.
      sub.add(
        effect(() => {
          services.settings.version.value;
          const always = services.settings.peek<boolean>("workbench.view.alwaysShowHeaderActions");
          document.documentElement.toggleAttribute("data-header-actions", always !== false);
          return undefined;
        }),
      );
      sub.add({
        dispose: () => document.documentElement.removeAttribute("data-header-actions"),
      });
      windowCommand(
        "workbench.about",
        "About",
        "Shows the product name, version and platform.",
        async () => {
          // Our own dialog: the system message box needs a permission the window doesn't have,
          // so About used to do nothing (D133).
          const info = await appIpc.info();
          const ua = navigator.userAgent;
          const engine =
            /Edg\/([\d.]+)/.exec(ua)?.[1] !== undefined
              ? `WebView2 ${/Edg\/([\d.]+)/.exec(ua)?.[1]}`
              : /Chrome\/([\d.]+)/.exec(ua)
                ? `Chromium ${/Chrome\/([\d.]+)/.exec(ua)?.[1]}`
                : `WebKit ${/AppleWebKit\/([\d.]+)/.exec(ua)?.[1] ?? ""}`;
          const channel =
            services.settings.peek<string>("update.channel") === "beta" ? "beta" : "stable";
          const text = [
            `Version: ${product.version}${info.debugBuild ? " (debug build)" : ""}`,
            `Update channel: ${channel}`,
            `OS: ${info.os} ${info.arch}${info.osBuild ? ` (build ${info.osBuild})` : ""}`,
            `Webview: ${engine.trim()}`,
            `Data: ${info.dataDir}`,
          ].join("\n");
          const copy = await showDialog({
            title: product.nameLong,
            message: text,
            actions: [
              { label: "Copy", value: true },
              { label: "OK", value: false, variant: "primary" },
            ],
            cancelValue: false,
            defaultValue: false,
          });
          if (copy) await clipboardIpc.writeText(`${product.nameLong}\n${text}`);
        },
      );
      windowCommand(
        "window.close",
        "Close window",
        "Closes the IDE window. Asks about unsaved files first.",
        async () => {
          if (await closeWindow()) await windowIpc.destroy();
        },
      );
      // OS-initiated close (Alt+F4, Cmd+Q, dock) goes through the same checks.
      void windowIpc
        .onCloseRequested(closeWindow)
        .then((d) => sub.add(d))
        .catch((err) => console.warn("close handler unavailable", err));

      // ---- Startup timings (all builds; PLAN §13 budgets) --------------------------------
      sub.add(
        dispatcher.register({
          id: "workbench.startupTimings",
          title: "Show startup timings",
          category: "Help",
          description:
            "Startup phases in ms since the native process started (and since the webview started): shell visible, extensions active, folder restored, editor ready. Also at ide://perf.",
          input: s.empty(),
          effects: [],
          run: () => {
            const phases = perf.phases();
            const text = phases
              .filter((p) => p.mark !== "navigationStart" || p.sinceProcessStartMs !== null)
              .map((p) => `${p.label} ${p.sinceProcessStartMs ?? p.sinceNavigationMs} ms`)
              .join(" → ");
            notifications.show("info", text || "No timings recorded yet.", {
              title: phases.some((p) => p.sinceProcessStartMs !== null)
                ? "Startup (since process start)"
                : "Startup (since webview start)",
            });
            return { phases };
          },
        }),
      );
      // What changed since an agent last looked (D191).
      const feed = sub.add(new EventFeed());
      feed.attach(services);
      sub.add(
        services.state.register("ide://events", {
          description:
            "What changed in the IDE (files created, changed, saved, renamed, deleted; documents opened; tabs opened and closed; commands the user ran), numbered: ?since=<n> returns the events after n and `next`, the number to pass the next time. Without since: the latest 20 and `next`.",
          get: ({ params }) => {
            const since = Number(params.since);
            if (Number.isFinite(since) && params.since !== undefined)
              return feed.since(since, Number(params.limit) || 100);
            const all = feed.since(0, FEED_SIZE);
            return { next: all.next, events: all.events.slice(-20) };
          },
        }),
      );
      sub.add(
        services.state.register("ide://perf", {
          description:
            "Startup phases in ms since process start and since webview start (shell visible, editor ready…).",
          get: () => ({ phases: perf.phases() }),
        }),
      );

      // ---- Persistence --------------------------------------------------------------------
      sub.add(
        persistence.register("layout", {
          save: () => layout.snapshot(),
          restore: (d) => layout.restore(d),
        }),
      );
      // The sidebar view the folder had (Channels, Source control…), as VS Code keeps it per
      // workspace; a folder with none saved opens on the Explorer.
      let sidebarRestored = false;
      sub.add(
        persistence.register("sidebarView", {
          save: () => services.views.active.peek(),
          restore: (d) => {
            sidebarRestored = typeof d === "string" && !!services.views.get(d);
            if (sidebarRestored) services.views.active.value = d as string;
          },
        }),
      );
      // Sections docked under a sidebar view (Outline under the Explorer): collapsed, height.
      sub.add(
        persistence.register("viewSections", {
          save: () => Object.fromEntries(services.views.sections.peek()),
          restore: (d) => {
            if (typeof d !== "object" || d === null) return;
            const next = new Map<string, SectionState>();
            for (const [id, v] of Object.entries(d as Record<string, unknown>)) {
              const st = v as Partial<SectionState> | null;
              if (typeof st?.collapsed === "boolean" && typeof st.height === "number")
                next.set(id, { collapsed: st.collapsed, height: st.height });
            }
            services.views.sections.value = next;
          },
        }),
      );
      // Scroll offsets of views (D190), loaded before the dock creates them.
      // (Saved a while after scrolling stops: not a state write per wheel turn.)
      let scrollSave: ReturnType<typeof setTimeout> | undefined;
      scrollMemory.onChange = () => {
        clearTimeout(scrollSave);
        scrollSave = setTimeout(() => persistence.scheduleSave(), 2000);
      };
      sub.add({ dispose: () => clearTimeout(scrollSave) });
      sub.add(
        persistence.register("scrollPositions", {
          save: () => scrollMemory.save(),
          restore: (d) => scrollMemory.load(d),
        }),
      );
      let dockRestored = false;
      sub.add(
        persistence.register("dock", {
          save: () => dock.serialize(),
          restore: (d) => {
            dockRestored = dock.restore(d);
          },
        }),
      );
      // Folder switch: views belong to the old folder (terminals, documents).
      sub.add(
        workspace.onDidClose(() => {
          dock.closeAllLive();
          scrollMemory.load(null);
          dockRestored = false;
        }),
      );
      // A folder being opened (D169): a moving line under the title bar until it's ready, so a
      // big folder's pause doesn't look like nothing happened.
      let openingLine: HTMLElement | null = null;
      sub.add(
        effect(() => {
          const opening = workspace.opening.value !== null;
          if (opening && !openingLine) {
            openingLine = document.createElement("div");
            openingLine.className = "progress-line workspace-opening";
            openingLine.setAttribute("role", "progressbar");
            openingLine.setAttribute("aria-label", "Opening folder");
            document.querySelector(".titlebar")?.append(openingLine);
          } else if (!opening && openingLine) {
            openingLine.remove();
            openingLine = null;
          }
          return undefined;
        }),
      );
      sub.add({ dispose: () => openingLine?.remove() });
      sub.add(
        workspace.onDidOpen((root) => {
          // The default tree (docs/dock.md §3): welcome, the agent on the right (no terminal, D424).
          // Chats filled the sidebar while no folder was open (D164): the folder's files now.
          // (Not in the agent layout, D424: its sidebar stays on Chats.)
          if (
            services.views.active.peek() === "agent.chats" &&
            !sidebarRestored &&
            chosenStartLayout(services.settings, true).sidebar !== "agent.chats"
          )
            services.views.active.value = "explorer.view";
          sidebarRestored = false;
          if (dockRestored) return;
          // The base layout's widths (D163).
          const plan = applyBaseLayout(services, {
            folder: true,
            // Without focus: a palette or editor opened meanwhile keeps it.
            showSidebar: (view) => (services.views.active.value = view),
          });
          // A folder opened for the first time: its README, like VS Code's "readme" start page.
          if (
            plan.readme &&
            services.settings.peek<boolean>("workbench.openReadme") !== false &&
            !services.context.get("testRun")
          )
            void openReadme(root).catch(() => {});
        }),
      );
      const openReadme = async (root: string) => {
        const entries = await fsIpc.listDir(root);
        const readme = entries.find(
          (e) => e.kind === "file" && /^readme\.(md|markdown)$/i.test(e.name),
        );
        if (!readme || workspace.root.peek() !== root) return;
        await dispatcher.execute("viewer.openPreview", { path: readme.path });
      };
      sub.add(
        effect(() => {
          void [
            layout.sidebarVisible.value,
            layout.sidebarSize.value,
            dock.root.value,
            dock.focusedGroupId.value,
            services.views.sections.value,
          ];
          persistence.scheduleSave();
          return undefined;
        }),
      );

      sub.add(
        services.state.register("ide://layout", {
          description:
            "The dock: split tree, groups (id, tabs with id/viewType/title/dirty, active tab, focused, hidden, size in px), focused and maximized group, bottom/right region groups; plus the sidebar (visible, width, active view).",
          get: () => layoutTree(services, workbench.dockSize()),
        }),
      );
    },
  };
}
