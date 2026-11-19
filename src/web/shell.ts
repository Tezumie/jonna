// What a browser tab offers in place of the app's own window (`core/ipc/shell.ts`): the IDE's
// dialogs for confirmations, a picker of its own that browses the host's folders where the
// desktop opens a native one (the files are on the host, and the browser's own picker sees this
// computer's), the browser's clipboard, links in a new tab, full screen. Window controls do
// nothing: the tab is the browser's.
import { h } from "../core/dom/index";
import { type BrowsedFolder, fsIpc } from "../core/ipc/fs";
import { backendOs } from "../core/ipc/invoke";
import { createWindowlessShell, type PickPathsOptions, type Shell } from "../core/ipc/shell";
import { toDisposable } from "../core/lifecycle/index";
import { confirmAction, showDialog } from "../ui/Dialog";
import { icon } from "../ui/Icon";
import { HOME_PLACES, pathCrumbs } from "./pathCrumbs";

/**
 * `name` inside `folder`, with the separator the host's paths use. `os`: the host's system
 * when known; a backslash is a letter of a name anywhere but on Windows.
 */
export function childPath(folder: string, name: string, os: string | null = backendOs()): string {
  const windows =
    os === null ? folder.includes("\\") || /^[A-Za-z]:/.test(folder) : os === "windows";
  const separator = windows ? "\\" : "/";
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

interface PickOptions {
  title: string;
  /** What is chosen: a folder, an existing file, or a name to save as. */
  kind: "folder" | "file" | "save";
  start?: string;
}

/**
 * Asks for a path on the host, as a file manager would: places at the side (the home folder,
 * its usual folders, the drives), a path bar whose steps are folders to go to, the folder's
 * entries (a click chooses one, a second click or Enter goes into a folder), and a field with
 * the path, where a typed or pasted path works as well. Null when cancelled or left empty.
 */
async function pickPath(options: PickOptions): Promise<string | null> {
  const label = options.kind === "folder" ? "Folder" : options.kind === "file" ? "File" : "Save as";
  const input = h("input", {
    class: "input web-path-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": label,
  });
  input.value = options.start ?? "";
  const places = h("nav", { class: "web-path-places", "aria-label": "Places" });
  const crumbs = h("div", { class: "web-path-crumbs", "aria-label": "Path" });
  const up = h("button", {
    class: "icon-button",
    type: "button",
    title: "Up one folder",
    "aria-label": "Up one folder",
  });
  up.append(icon("arrow-up"));
  const hidden = h("input", { type: "checkbox" });
  const list = h("div", {
    class: "web-path-list",
    role: "listbox",
    "aria-label": "Folders and files",
  });
  const note = h("p", { class: "web-path-note" });
  const content = h(
    "div",
    { class: "web-path" },
    h("div", { class: "web-path-bar" }, up, crumbs),
    h("div", { class: "web-path-body" }, places, list),
    note,
    h(
      "div",
      { class: "web-path-foot" },
      h("label", { class: "web-path-field" }, h("span", null, label), input),
      h("label", { class: "web-path-hidden" }, hidden, h("span", null, "Hidden items")),
    ),
  );
  /** The newest listing asked for: an answer to an older one is dropped. */
  let asked = 0;
  /** The folder listed now. */
  let shown: BrowsedFolder | null = null;
  const windows = () => {
    const os = backendOs();
    return os === null ? /^[A-Za-z]:|^\\\\/.test(shown?.path ?? "") : os === "windows";
  };
  const row = (text: string, glyph: Parameters<typeof icon>[0], path: string, dir: boolean) => {
    const button = h("button", { class: "web-path-row", type: "button", role: "option" });
    button.append(icon(glyph), h("span", null, text));
    const choose = () => {
      for (const other of list.querySelectorAll(".is-selected")) {
        other.classList.remove("is-selected");
        other.setAttribute("aria-selected", "false");
      }
      button.classList.add("is-selected");
      button.setAttribute("aria-selected", "true");
      input.value = path;
    };
    button.addEventListener("click", () => {
      // A folder already chosen is gone into: a double click, or two taps on a touch screen.
      if (dir && button.classList.contains("is-selected")) void show(path);
      else choose();
    });
    if (dir)
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        void show(path);
      });
    return button;
  };
  const draw = (): void => {
    const folder = shown;
    if (!folder) return;
    up.disabled = folder.parent === null;
    crumbs.replaceChildren(
      ...pathCrumbs(folder.path, windows()).flatMap((crumb, index, all) => {
        const step = h("button", { class: "web-path-crumb", type: "button" }, crumb.label);
        if (index === all.length - 1) step.setAttribute("aria-current", "location");
        step.addEventListener("click", () => void show(crumb.path));
        return index === 0 ? [step] : [icon("chevron-right"), step];
      }),
    );
    crumbs.scrollLeft = crumbs.scrollWidth;
    const rows: HTMLElement[] = [];
    for (const entry of folder.entries) {
      if (!hidden.checked && entry.name.startsWith(".")) continue;
      const path = childPath(folder.path, entry.name);
      if (entry.dir) rows.push(row(entry.name, "folder", path, true));
      else if (options.kind !== "folder") rows.push(row(entry.name, "file", path, false));
    }
    list.replaceChildren(
      ...(rows.length
        ? rows
        : [
            h(
              "p",
              { class: "web-path-empty" },
              options.kind === "folder" ? "No folders in here." : "Nothing in here.",
            ),
          ]),
    );
    list.scrollTop = 0;
  };
  const show = async (path?: string, keepField = false): Promise<void> => {
    const mine = ++asked;
    let folder: BrowsedFolder;
    try {
      folder = await fsIpc.pickerBrowse(path);
    } catch (err) {
      if (mine !== asked) return;
      // A path being typed is often not a folder yet: say so only for a folder that was clicked.
      if (!keepField) note.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    if (mine !== asked) return;
    shown = folder;
    note.textContent = folder.truncated ? "This folder holds more than is shown." : "";
    if (!keepField) input.value = folder.path;
    draw();
  };
  up.addEventListener("click", () => {
    const parent = shown?.parent;
    if (parent !== null && parent !== undefined) void show(parent);
  });
  hidden.addEventListener("change", draw);
  // The places: the home folder (what the host lists when asked for nothing), the folders in
  // it people keep work in, and the drives. Read once; the picker works without them.
  const place = (text: string, glyph: Parameters<typeof icon>[0], path: string) => {
    const button = h("button", { class: "web-path-place", type: "button" });
    button.append(icon(glyph), h("span", null, text));
    button.addEventListener("click", () => void show(path));
    return button;
  };
  void fsIpc.pickerBrowse().then(
    (home) => {
      const inHome = home.entries.filter((e) => e.dir && HOME_PLACES.includes(e.name));
      places.replaceChildren(
        place("Home", "folder-open", home.path),
        ...inHome.map((e) => place(e.name, "folder", childPath(home.path, e.name))),
        ...home.roots.map((root) => place(root, "folder", root)),
      );
    },
    () => {},
  );
  // A typed or pasted path that is a folder is listed as it is typed.
  let typing: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const typed = input.value.trim();
      // A network path names a server and a share first: asking for less would have the host
      // look for a machine by every few letters typed.
      if (typed.startsWith("\\\\") && !/^\\\\[^\\]+\\[^\\]+\\/.test(typed)) return;
      void show(typed || undefined, true);
    }, 250);
  });
  // Enter in the field answers as the primary button does. Heard at the window, before the
  // dialog's own key handling.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.target !== input) return;
    event.preventDefault();
    event.stopPropagation();
    let around: HTMLElement | null = input.parentElement;
    while (around && !around.querySelector(".button-primary")) around = around.parentElement;
    around?.querySelector<HTMLButtonElement>(".button-primary")?.click();
  };
  window.addEventListener("keydown", onKey, true);
  // After the dialog has focused its default button.
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  // A file's or a new name's folder is what is listed.
  const first = options.start?.trim();
  void show(first || undefined)
    .then(() => {
      if (shown || !first) return;
      // Not a folder: a file, or a name that isn't there yet. Its folder, then.
      const cut = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
      if (cut > 0) return show(first.slice(0, cut + 1), true);
    })
    .then(() => {
      if (!shown && first) void show(undefined, true);
    });
  const ok = await showDialog<boolean>({
    title: options.title,
    message: "On the computer you're connected to.",
    content,
    size: "lg",
    actions: [
      { label: "Cancel", value: false },
      { label: options.kind === "save" ? "Save" : "Open", value: true, variant: "primary" },
    ],
    cancelValue: false,
  }).finally(() => {
    window.removeEventListener("keydown", onKey, true);
    clearTimeout(typing);
    asked++;
  });
  const path = input.value.trim();
  return ok && path ? path : null;
}

export function createWebShell(): Shell {
  const base = createWindowlessShell();
  return {
    ...base,
    window: {
      ...base.window,
      isFullscreen: () => Promise.resolve(document.fullscreenElement !== null),
      toggleFullscreen: async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        return document.fullscreenElement !== null;
      },
      onResized: (handler) => {
        window.addEventListener("resize", handler);
        return Promise.resolve(toDisposable(() => window.removeEventListener("resize", handler)));
      },
    },
    dialog: {
      pickFolder: (title, start) =>
        pickPath({ title, kind: "folder", ...(start !== undefined && { start }) }),
      pickFile: (title, start) =>
        pickPath({ title, kind: "file", ...(start !== undefined && { start }) }),
      pickSavePath: (title, start) =>
        pickPath({ title, kind: "save", ...(start !== undefined && { start }) }),
      pickPaths: async (options: PickPathsOptions) => {
        const path = await pickPath({
          title: options.title ?? (options.directory ? "Choose a folder" : "Choose a file"),
          kind: options.directory ? "folder" : "file",
          ...(options.defaultPath !== undefined && { start: options.defaultPath }),
        });
        return path ? [path] : null;
      },
      confirm: (text, title, okLabel) => confirmAction(title, text, okLabel ?? "OK"),
      ask: (text, title) => confirmAction(title, text, "Yes"),
      error: async (text, title) => {
        await showDialog<null>({
          title,
          message: text,
          actions: [{ label: "OK", value: null, variant: "primary" }],
          cancelValue: null,
        });
      },
    },
  };
}
