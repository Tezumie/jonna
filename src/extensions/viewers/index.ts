// Viewers (PLAN §12): special views for file types beside the text editor. Images open in the
// image viewer; Markdown and SVG open as text with "Open preview" / "Open preview to the side"
// (Ctrl/Cmd+Shift+V, Ctrl/Cmd+K V) like VS Code; "Reopen with…" switches between the text editor
// and every viewer of a file. New viewers: register a dock view type taking `{ path }` and a
// `services.viewers` entry.
import type { BuiltinExtension } from "../../core/extensions/index";
import { samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { IMAGE_EXTENSIONS } from "./image";
import {
  AUDIO_EXTENSIONS,
  BINARY_EXTENSIONS,
  CSV_EXTENSIONS,
  moreViewerDescriptors,
  VIDEO_EXTENSIONS,
} from "./more";
import { registerPreviewFind } from "./previewFindCommands";
import { ARCHIVE_EXTENSIONS, FONT_EXTENSIONS, richViewerDescriptors } from "./rich";
import { viewerDescriptors, type Zoomable } from "./views";

export const viewersExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dock, dispatcher, viewers, workspace, quickInput } = services;
    for (const d of [
      ...viewerDescriptors(services),
      ...moreViewerDescriptors(services),
      ...richViewerDescriptors(services),
    ])
      sub.add(dock.views.register(d));
    // VS Code's markdown.preview.fontFamily / fontSize / lineHeight (D279), as variables the
    // preview's document reads.
    sub.add(
      effect(() => {
        const root = document.documentElement.style;
        const family = services.settings.get<string>("markdown.preview.fontFamily")?.trim();
        const size = services.settings.get<number>("markdown.preview.fontSize");
        const height = services.settings.get<number>("markdown.preview.lineHeight");
        if (family) root.setProperty("--md-preview-font-family", family);
        else root.removeProperty("--md-preview-font-family");
        root.setProperty(
          "--md-preview-font-size",
          `${typeof size === "number" && size >= 8 && size <= 40 ? size : 14}px`,
        );
        root.setProperty(
          "--md-preview-line-height",
          String(typeof height === "number" && height >= 1 && height <= 3 ? height : 1.6),
        );
        return undefined;
      }),
    );
    sub.add({
      dispose: () => {
        for (const name of [
          "--md-preview-font-family",
          "--md-preview-font-size",
          "--md-preview-line-height",
        ])
          document.documentElement.style.removeProperty(name);
      },
    });
    // D118: binary files as hex, audio/video in a player, CSV/TSV as a table.
    sub.add(
      viewers.register({
        id: "hex",
        label: "Hex viewer",
        viewType: "hexView",
        extensions: BINARY_EXTENSIONS,
        kind: "default",
      }),
    );
    sub.add(
      viewers.register({
        id: "media",
        label: "Media player",
        viewType: "media",
        extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS],
        kind: "default",
      }),
    );
    // D120: fonts, archives (notebooks: each notebook type registers its viewer, D202).
    for (const v of [
      { id: "font", label: "Font preview", viewType: "fontPreview", extensions: FONT_EXTENSIONS },
      {
        id: "archive",
        label: "Archive contents",
        viewType: "archive",
        extensions: ARCHIVE_EXTENSIONS,
      },
    ])
      sub.add(viewers.register({ ...v, kind: "default" }));
    sub.add(
      viewers.register({
        id: "csv",
        label: "Table preview",
        viewType: "csvPreview",
        extensions: CSV_EXTENSIONS,
        kind: "preview",
        icon: "rows-2",
      }),
    );
    sub.add(
      viewers.register({
        id: "image",
        label: "Image preview",
        viewType: "image",
        extensions: IMAGE_EXTENSIONS,
        kind: "default",
      }),
    );
    sub.add(
      viewers.register({
        id: "markdown",
        label: "Markdown preview",
        viewType: "markdownPreview",
        extensions: [".md", ".markdown", ".mdx"],
        kind: "preview",
      }),
    );
    sub.add(
      viewers.register({
        id: "svg",
        label: "SVG preview",
        viewType: "svgPreview",
        extensions: [".svg"],
        kind: "preview",
      }),
    );

    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "View", ...c }));
    // `activePreview`: the active tab is a file preview (Ctrl+Shift+V switches back from it).
    const previewTypes = () =>
      new Set(["markdownPreview", "svgPreview", "csvPreview"].filter((t) => dock.views.get(t)));
    sub.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        const tab = dock.activeTab();
        services.context.set("activePreview", !!tab && previewTypes().has(tab.viewType));
        return undefined;
      }),
    );
    const resolve = (path: string) => workspace.resolve(path);
    // Find in the Markdown preview (D210).
    for (const d of registerPreviewFind(services, resolve)) sub.add(d);
    /** The file of the active tab (editor, preview, diff…), if it shows one. */
    const activePath = (): string | undefined => {
      const tab = dock.activeTab();
      const p = tab ? stateField(tab.viewState, "path") : undefined;
      return typeof p === "string" && !p.startsWith("virtual:") ? p : undefined;
    };

    /** Opens `viewType` for `path`: reuses its tab, else beside the source (toSide) or here. */
    const open = (
      viewType: string,
      path: string,
      o: { toSide?: boolean; focus?: boolean; preview?: boolean },
    ): string => {
      const existing = dock
        .tabs(viewType)
        .find((t) => samePath(String(stateField(t.viewState, "path") ?? ""), path));
      if (existing) {
        dock.activateTab(existing.id, o.focus ?? true);
        return existing.id;
      }
      const group = dock.focusedGroup();
      let placement: Parameters<typeof dock.openView>[2] = "main";
      if (o.toSide && group) {
        // VS Code: the group to the right if there is one, else a new split.
        // Only an editor group counts: the right region (agent, …) is not "the side".
        const right = dock.neighbor(group.id, "right");
        const rightGroup = right ? dock.findGroup(right) : undefined;
        const editorSide =
          rightGroup && (rightGroup.tabs.length === 0 || rightGroup.tabs.some(dock.isEditorLike));
        placement =
          right && editorSide ? { groupId: right } : { groupId: group.id, split: "right" };
      } else if (group?.tabs.some(dock.isEditorLike)) placement = { groupId: group.id };
      return dock.openView(viewType, { path }, placement, o.focus ?? true, {
        preview: o.preview ?? false,
      });
    };

    register({
      id: "viewer.open",
      title: "Open in viewer",
      description:
        "Opens a file in one of its viewers (image, Markdown or SVG preview). `viewer` defaults to the file's default viewer, else its preview.",
      input: s.object({
        path: s.string().describe("File path, absolute or relative to the workspace root"),
        viewer: s.string().describe("Viewer id: image, markdown, svg").optional(),
        toSide: s.boolean().describe("Open beside the current group").optional(),
        preserveFocus: s.boolean().optional(),
        preview: s.boolean().describe("Open as a preview tab").optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: ({ path, viewer, toSide, preserveFocus, preview }) => {
        const target = resolve(path);
        const v = viewer
          ? viewers.get(viewer)
          : (viewers.defaultFor(target) ?? viewers.previewFor(target));
        if (!v) throw new Error(`No viewer for ${path}.`);
        const tabId = open(v.viewType, target, {
          ...(toSide !== undefined && { toSide }),
          focus: !preserveFocus,
          ...(preview !== undefined && { preview }),
        });
        return { path: target, viewer: v.id, tabId };
      },
    });

    register({
      id: "viewer.openPreview",
      title: "Open preview",
      description:
        "Opens the rendered preview of a Markdown or SVG file (default: the active editor's), in this group or beside it (`toSide`). Updates live as the file is edited.",
      input: s.object({
        path: s.string().optional(),
        toSide: s.boolean().optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: ({ path, toSide }) => {
        const target = path ? resolve(path) : activePath();
        if (!target) throw new Error("No file to preview.");
        const v = viewers.previewFor(target);
        if (!v) throw new Error(`${target} has no preview (Markdown and SVG files do).`);
        // A preview opened from its own preview tab is that tab.
        return { tabId: open(v.viewType, target, { toSide: toSide ?? false }) };
      },
    });
    /**
     * Shows `viewType` (or the text editor) for `path` in place of tab `fromId`: same group, same
     * position. A tab with unsaved changes stays, the new one opens next to it.
     */
    const swap = async (fromId: string, viewType: string, path: string): Promise<string> => {
      const ref = dock.findTab(fromId);
      if (!ref) throw new Error("That tab isn't open.");
      const placement = { groupId: ref.group.id, index: ref.index + 1 };
      const id =
        viewType === "editor"
          ? dock.openView("editor", { path }, placement, true)
          : dock.openView(viewType, { path }, placement, true);
      const fresh = dock.findTab(id);
      const tab = fresh?.group.tabs[fresh.index];
      if (tab) dock.view(tab); // the editor's document is retained before the old tab goes
      const old = dock.findTab(fromId);
      const oldTab = old?.group.tabs[old.index];
      if (oldTab && !dock.isDirty(oldTab))
        await dispatcher.execute("layout.closeTab", { tabId: fromId }).catch(() => {});
      return id;
    };
    /** Tabs showing `path`: its text editors and its preview. */
    const tabsFor = (viewType: string, path: string) =>
      dock
        .tabs(viewType)
        .filter((t) => samePath(String(stateField(t.viewState, "path") ?? ""), path));

    register({
      id: "viewer.togglePreview",
      title: "Toggle preview",
      description:
        "Switches a Markdown, SVG or CSV file between its text and its rendered preview in the same tab (Ctrl/Cmd+Shift+V). From a preview whose source is open elsewhere (side by side), focuses that editor instead.",
      input: s.object({
        path: s.string().optional(),
        tabId: s.string().describe("The tab to switch (default: the active one)").optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ path, tabId }) => {
        const ref = tabId ? dock.findTab(tabId) : undefined;
        const tab = ref ? ref.group.tabs[ref.index] : dock.activeTab();
        const p = tab ? stateField(tab.viewState, "path") : undefined;
        const target = path ? resolve(path) : typeof p === "string" ? p : activePath();
        if (!tab || !target) throw new Error("No file to preview.");
        const v = viewers.previewFor(target);
        if (!v) throw new Error(`${target} has no preview (Markdown, SVG and CSV files do).`);
        if (tab.viewType === v.viewType) {
          // Back to the source: an editor already open (beside it) gets the focus.
          const open = tabsFor("editor", target)[0];
          if (open) {
            dock.activateTab(open.id, true);
            return { tabId: open.id, showing: "source" };
          }
          return { tabId: await swap(tab.id, "editor", target), showing: "source" };
        }
        // To the preview: one already open is reused (beside it: focus stays with the preview).
        const existing = tabsFor(v.viewType, target)[0];
        if (existing) {
          dock.activateTab(existing.id, true);
          return { tabId: existing.id, showing: "preview" };
        }
        return { tabId: await swap(tab.id, v.viewType, target), showing: "preview" };
      },
    });

    register({
      id: "viewer.openPreviewToSide",
      title: "Open preview to the side",
      description: "Opens the rendered preview of the active Markdown or SVG file beside it.",
      input: s.empty(),
      effects: ["read"],
      run: () => dispatcher.execute("viewer.openPreview", { toSide: true }),
    });

    register({
      id: "editor.reopenWith",
      title: "Reopen editor with…",
      category: "File",
      description:
        "Reopens a file's tab in another way to view it: the text editor or one of its viewers (image, preview). Without `with`, asks.",
      input: s.object({
        path: s.string().optional(),
        with: s.string().describe('"text" or a viewer id (image, markdown, svg)').optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ path, with: choice }) => {
        const target = path ? resolve(path) : activePath();
        if (!target) throw new Error("No file to reopen.");
        const options = [
          { id: "text", label: "Text editor", description: "Edit the file's text" },
          ...viewers.for(target).map((v) => ({ id: v.id, label: v.label, description: "" })),
        ];
        // Any file can be looked at as bytes (VS Code's Hex Editor).
        if (!options.some((o) => o.id === "hex"))
          options.push({ id: "hex", label: "Hex viewer", description: "Bytes, read-only" });
        const picked =
          choice ?? (await quickInput.pick(options, { placeholder: "Reopen with" }))?.id;
        if (!picked) return null;
        const before = dock.activeTab();
        if (picked === "text") {
          // The text editor even where a default viewer exists (an image's bytes as a notice).
          await dispatcher.execute("editor.openFile", { path: target, asText: true });
        } else {
          const v = viewers.get(picked);
          if (!v) throw new Error(`Unknown viewer ${picked}.`);
          open(v.viewType, target, {});
        }
        // Replace the tab it was reopened from (same file, other view).
        const after = dock.activeTab();
        if (
          before &&
          after &&
          before.id !== after.id &&
          samePath(String(stateField(before.viewState, "path") ?? ""), target)
        )
          await dispatcher.execute("layout.closeTab", { tabId: before.id }).catch(() => {});
        return { with: picked };
      },
    });

    register({
      id: "viewer.zoom",
      title: "Zoom image",
      description: "Zooms the active image or SVG preview: in, out, fit to the view, or 100%.",
      input: s.object({ direction: s.enum(["in", "out", "fit", "actual"] as const) }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ direction }) => {
        const tab = dock.activeTab();
        const view = tab ? (dock.liveView(tab.id) as Partial<Zoomable> | undefined) : undefined;
        if (!view?.canvas) throw new Error("The active tab isn't an image.");
        view.canvas.zoom(direction);
        return { zoom: view.canvas.zoomLevel ?? "fit" };
      },
    });
  },
};
