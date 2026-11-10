// An extension's pictures (D190): its icon (an image file or an icon of the IDE's set) and its
// screenshots, shown on its page. A development copy can change them from its menu or page, and
// the agent can too (it draws SVG icons well, and can take screenshots of the IDE).
import { h } from "../../core/dom/index";
import type { ExtensionScreenshot } from "../../core/extensions/thirdParty";
import { MAX_SCREENSHOTS } from "../../core/extensions/thirdParty";
import { fsIpc } from "../../core/ipc/fs";
import { dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, isAbsolute as isAbsolutePath, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { captureWindow } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import type { ImageUrls } from "./detailsTabs";
import type { ExtensionManager, ExtensionRecord } from "./manager";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/** The extension's screenshots as a strip of thumbnails (click: shown large), or null. */
export function screenshotGallery(
  services: WorkbenchServices,
  r: ExtensionRecord,
  images: ImageUrls,
): HTMLElement | null {
  const shots = r.manifest?.screenshots ?? [];
  if (!shots.length && !r.dev) return null;
  const strip = h("div", { class: "ext-shots", role: "list" });
  for (const shot of shots) {
    const img = h("img", { alt: shot.caption ?? basename(shot.path), loading: "lazy" });
    const tile = h(
      "button",
      { class: "ext-shot", type: "button", role: "listitem" },
      img,
      shot.caption ? h("span", { class: "ext-shot-caption" }, shot.caption) : null,
    );
    void images.url(r, shot.path)?.then((url) => {
      if (url) img.src = url;
    });
    tile.addEventListener("click", () => showLarge(img.src, shot));
    if (r.dev)
      tile.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        void services.dispatcher
          .execute("extensions.removeScreenshot", { id: r.id, path: shot.path })
          .catch((err: unknown) => services.notifications.show("error", String(err)));
      });
    if (r.dev) setTooltip(tile, `${shot.caption ?? basename(shot.path)} · right-click to remove`);
    strip.append(tile);
  }
  // A development copy: add one (a picture of the IDE as it is, or an image file).
  if (r.dev && shots.length < MAX_SCREENSHOTS) {
    const add = h(
      "button",
      { class: "ext-shot is-add", type: "button" },
      icon("camera"),
      h("span", null, "Add screenshot"),
    );
    setTooltip(add, "A picture of the IDE as it is now (Shift+click: an image file…)");
    add.addEventListener("click", (e) => {
      void services.dispatcher
        .execute("extensions.addScreenshot", {
          id: r.id,
          ...(e.shiftKey && { from: "file" }),
        })
        .catch((err: unknown) =>
          services.notifications.show("error", err instanceof Error ? err.message : String(err)),
        );
    });
    strip.append(add);
  }
  return h("section", { class: "ext-shots-section", "aria-label": "Screenshots" }, strip);
}

/** A screenshot at full size over the page; a click or Escape closes it. */
function showLarge(src: string, shot: ExtensionScreenshot): void {
  if (!src) return;
  const overlay = h(
    "div",
    {
      class: "ext-shot-overlay",
      role: "dialog",
      tabindex: "-1",
      "aria-label": shot.caption ?? "Screenshot",
    },
    h("img", { src, alt: shot.caption ?? "" }),
    shot.caption ? h("div", { class: "ext-shot-overlay-caption" }, shot.caption) : null,
  );
  // Its listeners are its own: they go with it.
  const close = () => overlay.remove();
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  overlay.addEventListener("click", close);
  overlay.addEventListener("focusout", (e) => {
    if (!overlay.contains(e.relatedTarget as Node | null)) close();
  });
  document.body.append(overlay);
  overlay.focus();
}

/** The manifest as JSON, changed by `edit`, written back. */
async function editManifest(
  r: ExtensionRecord,
  edit: (json: Record<string, unknown>) => void,
): Promise<void> {
  const path = joinPath(r.root, r.manifestFile);
  const json = JSON.parse(new TextDecoder().decode(await fsIpc.read(path))) as Record<
    string,
    unknown
  >;
  edit(json);
  await fsIpc.write(path, new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`), "user");
}

async function exists(path: string): Promise<boolean> {
  return fsIpc.stat(path).then(
    () => true,
    () => false,
  );
}

export function registerMediaCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
): void {
  const register: typeof services.dispatcher.register = (c) =>
    sub.add(services.dispatcher.register({ category: "Extensions", ...c }));
  /** A development copy (its files are the user's to change), or an error saying how to get one. */
  const editable = (id: string, caller: string): ExtensionRecord => {
    if (caller === "ext" || caller === "mcp")
      throw new Error("Only the user or the agent can change an extension's pictures.");
    const r = manager.require(id);
    if (!r.dev || !r.manifest)
      throw new Error(
        `${r.manifest?.displayName ?? id} is installed: copy it for development first (extensions.copyForDevelopment), change the copy, then install it.`,
      );
    // Its files are written through the open folder's file scope.
    // Any of the workspace's folders (D251).
    if (!services.workspace.contains(r.root))
      throw new Error(
        `${r.manifest.displayName} is outside the open folder: open its folder (or copy it into this folder's extensions) to change its pictures.`,
      );
    return r;
  };
  /** Bytes of an image file the user picked or the agent named (inside the folder or the extension). */
  const readImage = async (file: string, r: ExtensionRecord, user: boolean) => {
    if (!IMAGE_EXT.test(file)) throw new Error("Use a PNG, JPEG, GIF, WebP or SVG file.");
    const root = services.workspace.root.peek();
    // Relative: as the workspace resolves it (D251: it may start with a folder's name).
    const abs = isAbsolutePath(file)
      ? file
      : root
        ? services.workspace.resolve(file)
        : joinPath(r.root, file);
    if (user) await fsIpc.allowFile(abs).catch(() => {});
    const bytes = await fsIpc.read(abs);
    if (bytes.length > 5 * 1024 * 1024) throw new Error("The image is larger than 5 MB.");
    return bytes;
  };

  register({
    id: "extensions.setIcon",
    title: "Change extension icon…",
    description:
      'Sets a development extension\'s icon (D190): `file` is a PNG/JPEG/GIF/WebP/SVG (absolute, or relative to the open folder) copied into the extension as icon.<ext>; `name` is an icon of the IDE\'s set instead ("rocket"); neither asks the user for a file. An agent can write an SVG file first and pass it. Writes "icon" in the manifest.',
    input: s.object({
      id: s.string(),
      file: s.string().optional(),
      name: s.string().optional(),
    }),
    effects: ["write"],
    run: async ({ id, file, name }, ctx) => {
      const r = editable(id, ctx.caller.kind);
      const user = ctx.caller.kind === "user" || ctx.caller.kind === "test";
      if (name) {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Not an icon name: ${name}`);
        await editManifest(r, (json) => {
          json.icon = name;
        });
        await manager.refresh();
        return { icon: name };
      }
      const picked = file ?? (user ? await dialogIpc.pickFile("Choose an icon image") : null);
      if (!picked) return { icon: null };
      const bytes = await readImage(picked, r, user);
      const ext = (picked.match(IMAGE_EXT)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
      const rel = `icon.${ext}`;
      await fsIpc.write(joinPath(r.root, rel), bytes, "user");
      await editManifest(r, (json) => {
        json.icon = rel;
      });
      await manager.refresh();
      return { icon: rel };
    },
  });

  register({
    id: "extensions.addScreenshot",
    title: "Add extension screenshot",
    description:
      "Adds a screenshot to a development extension's page (D190): by default a picture of the IDE as it is now (open the extension's view first so it's in the picture); `from: \"file\"` with `file` (or none: the user picks one) copies an image. Saved as screenshots/<n>.<ext> in the extension and listed in the manifest's \"screenshots\" with an optional `caption`.",
    input: s.object({
      id: s.string(),
      from: s.enum(["ide", "file"]).optional(),
      file: s.string().optional(),
      caption: s.string().optional(),
    }),
    effects: ["write"],
    run: async ({ id, from, file, caption }, ctx) => {
      const r = editable(id, ctx.caller.kind);
      const user = ctx.caller.kind === "user" || ctx.caller.kind === "test";
      const list = r.manifest?.screenshots ?? [];
      if (list.length >= MAX_SCREENSHOTS)
        throw new Error(`An extension shows at most ${MAX_SCREENSHOTS} screenshots.`);
      let bytes: Uint8Array;
      let ext = "png";
      if (from === "file" || file) {
        const picked = file ?? (user ? await dialogIpc.pickFile("Choose a screenshot") : null);
        if (!picked) return { added: null };
        bytes = await readImage(picked, r, user);
        ext = (picked.match(IMAGE_EXT)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
      } else {
        // Menus close first, so they aren't in the picture.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        bytes = (await captureWindow()).png;
      }
      let n = list.length + 1;
      while (await exists(joinPath(r.root, `screenshots/${n}.${ext}`))) n++;
      const rel = `screenshots/${n}.${ext}`;
      await fsIpc.write(joinPath(joinPath(r.root, "screenshots"), `${n}.${ext}`), bytes, "user");
      await editManifest(r, (json) => {
        const current = Array.isArray(json.screenshots) ? json.screenshots : [];
        json.screenshots = [...current, caption ? { path: rel, caption } : rel];
      });
      await manager.refresh();
      return { added: rel };
    },
  });

  register({
    id: "extensions.removeScreenshot",
    title: "Remove extension screenshot",
    description:
      "Takes a screenshot off a development extension's page (its manifest's list); the file stays in the folder.",
    input: s.object({ id: s.string(), path: s.string() }),
    effects: ["write"],
    palette: false,
    run: async ({ id, path }, ctx) => {
      const r = editable(id, ctx.caller.kind);
      const want = path.replace(/^\.\//, "");
      await editManifest(r, (json) => {
        const current = Array.isArray(json.screenshots) ? json.screenshots : [];
        json.screenshots = current.filter((item: unknown) => {
          const p = typeof item === "string" ? item : (item as { path?: unknown })?.path;
          return typeof p !== "string" || p.replace(/^\.\//, "") !== want;
        });
      });
      await manager.refresh();
      return { removed: want };
    },
  });
}
