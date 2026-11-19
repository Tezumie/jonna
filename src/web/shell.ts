// What a browser tab offers in place of the app's own window (`core/ipc/shell.ts`): the IDE's
// dialogs for confirmations, a picker of its own that browses the host's folders (and makes
// and renames them, as a file manager does) where the
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
import { showContextMenu } from "../ui/Menu";
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

/** The computer the page is connected to, as the picker names it. */
export interface HostPlace {
  /** Its name: the address it was reached at, or what the account service calls it. */
  name: string;
  /** A machine in the cloud (the account's own), not a computer somewhere. */
  cloud: boolean;
}

interface PickOptions {
  title: string;
  /** What is chosen: a folder, an existing file, or a name to save as. */
  kind: "folder" | "file" | "save";
  start?: string;
  where: HostPlace;
}

/**
 * Asks for a path on the host, as a file manager would: the computer's name and its places at
 * the side (the home folder, its usual folders, the drives), a path bar whose steps are
 * folders to go to, the folder's entries (a click chooses one; a double click, a second click
 * or Enter goes into a folder), a menu on the entries and on the space under them (new
 * folder, rename, copy the path), and a field with the path, where a typed or pasted path
 * works as well. Null when cancelled or left empty.
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
  const iconButton = (glyph: Parameters<typeof icon>[0], text: string) => {
    const button = h("button", {
      class: "icon-button",
      type: "button",
      title: text,
      "aria-label": text,
    });
    button.append(icon(glyph));
    return button;
  };
  const up = iconButton("arrow-up", "Up one folder");
  const newFolder = iconButton("folder-plus", "New folder");
  const hidden = h("input", { type: "checkbox" });
  const list = h("div", {
    class: "web-path-list",
    role: "listbox",
    "aria-label": "Folders and files",
  });
  const note = h("p", { class: "web-path-note", role: "status" });
  const computer = h(
    "div",
    { class: "web-path-computer", title: options.where.name },
    icon(options.where.cloud ? "cloud" : "server"),
    h("span", null, options.where.name),
  );
  const content = h(
    "div",
    { class: "web-path" },
    h("div", { class: "web-path-bar" }, up, crumbs, newFolder),
    h(
      "div",
      { class: "web-path-body" },
      h("div", { class: "web-path-side" }, computer, places),
      list,
    ),
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
  /** The row whose name is being typed (a new folder, a rename), if any. */
  let editing: { input: HTMLInputElement; commit(): void; cancel(): void } | null = null;
  const windows = () => {
    const os = backendOs();
    return os === null ? /^[A-Za-z]:|^\\\\/.test(shown?.path ?? "") : os === "windows";
  };
  const say = (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    // The host's words carry the whole path; the name is on screen already.
    note.textContent = /already exists/i.test(text) ? "That name is already taken here." : text;
  };
  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => {});
  };
  /**
   * A row with a field in place of the name, as a file manager renames: Enter or leaving the
   * field takes the name, Escape drops it. `done` gets the name when one was typed.
   */
  const nameRow = (
    glyph: Parameters<typeof icon>[0],
    start: string,
    done: (name: string) => Promise<void>,
  ): HTMLElement => {
    const field = h("input", {
      class: "input web-path-name",
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Name",
    });
    field.value = start;
    const line = h("div", { class: "web-path-row is-editing" }, icon(glyph), field);
    let over = false;
    const end = (take: boolean) => {
      if (over) return;
      over = true;
      editing = null;
      const name = field.value.trim();
      if (take && name && name !== start) void done(name).catch(say).finally(draw);
      else draw();
    };
    field.addEventListener("blur", () => end(true));
    editing = { input: field, commit: () => end(true), cancel: () => end(false) };
    setTimeout(() => {
      field.focus();
      // The name without its ending, as a file manager selects it.
      const dot = start.lastIndexOf(".");
      field.setSelectionRange(0, dot > 0 ? dot : start.length);
    }, 0);
    return line;
  };
  const startNewFolder = (): void => {
    const folder = shown;
    if (!folder || editing) return;
    note.textContent = "";
    list.querySelector(".web-path-empty")?.remove();
    const line = nameRow("folder", "New folder", async (name) => {
      const made = await fsIpc.pickerCreateFolder(folder.path, name);
      await show(folder.path, true);
      select(made);
    });
    list.prepend(line);
    list.scrollTop = 0;
  };
  const startRename = (button: HTMLElement, name: string, path: string, dir: boolean): void => {
    const folder = shown;
    if (!folder || editing) return;
    note.textContent = "";
    button.replaceWith(
      nameRow(dir ? "folder" : "file", name, async (next) => {
        const made = await fsIpc.pickerRename(path, next);
        await show(folder.path, true);
        select(made);
      }),
    );
  };
  /** Marks the row of `path` as chosen and puts the path in the field. */
  const select = (path: string): void => {
    for (const row of list.querySelectorAll<HTMLElement>(".web-path-row")) {
      const mine = row.dataset.path === path;
      row.classList.toggle("is-selected", mine);
      if (row.getAttribute("role") === "option") row.setAttribute("aria-selected", String(mine));
      if (mine) row.scrollIntoView({ block: "nearest" });
    }
    input.value = path;
  };
  const row = (text: string, glyph: Parameters<typeof icon>[0], path: string, dir: boolean) => {
    const button = h("button", { class: "web-path-row", type: "button", role: "option" });
    button.dataset.path = path;
    button.append(icon(glyph), h("span", null, text));
    button.addEventListener("click", () => {
      // A folder already chosen is gone into: a double click, or two taps on a touch screen.
      if (dir && button.classList.contains("is-selected")) void show(path);
      else select(path);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && dir) {
        event.preventDefault();
        event.stopPropagation();
        void show(path);
      } else if (event.key === "F2") {
        event.preventDefault();
        startRename(button, text, path, dir);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // Up and down the entries, as in a list.
        const next =
          event.key === "ArrowDown" ? button.nextElementSibling : button.previousElementSibling;
        if (!(next instanceof HTMLButtonElement)) return;
        event.preventDefault();
        next.focus();
        next.click();
      }
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      select(path);
      showContextMenu(event.clientX, event.clientY, [
        ...(dir
          ? [{ label: "Open", icon: "folder-open" as const, run: () => void show(path) }]
          : []),
        {
          label: "Rename…",
          icon: "pencil",
          keybinding: "F2",
          run: () => startRename(button, text, path, dir),
        },
        { label: "Copy path", icon: "copy", run: () => copyPath(path) },
        { label: "New folder", icon: "folder-plus", separatorBefore: true, run: startNewFolder },
      ]);
    });
    return button;
  };
  // The space under the entries: what a file manager offers on a folder's background.
  list.addEventListener("contextmenu", (event) => {
    if (event.target !== list && !(event.target as Element).classList.contains("web-path-empty"))
      return;
    event.preventDefault();
    const folder = shown;
    if (!folder) return;
    showContextMenu(event.clientX, event.clientY, [
      { label: "New folder", icon: "folder-plus", run: startNewFolder },
      { label: "Refresh", icon: "refresh-cw", run: () => void show(folder.path, true) },
      { label: "Copy path", icon: "copy", run: () => copyPath(folder.path) },
      {
        label: "Hidden items",
        checked: hidden.checked,
        separatorBefore: true,
        run: () => {
          hidden.checked = !hidden.checked;
          draw();
        },
      },
    ]);
  });
  const draw = (): void => {
    const folder = shown;
    if (!folder) return;
    editing = null;
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
    for (const mark of places.querySelectorAll<HTMLElement>(".web-path-place"))
      mark.classList.toggle("is-current", mark.dataset.path === folder.path);
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
              options.kind === "folder"
                ? "This folder has no folders in it."
                : "This folder is empty.",
            ),
          ]),
    );
    // What the field names stays marked across a redraw (a folder just made or renamed).
    const chosen = input.value.trim();
    for (const line of rows) {
      if (line.dataset.path !== chosen) continue;
      line.classList.add("is-selected");
      line.setAttribute("aria-selected", "true");
    }
  };
  const show = async (path?: string, keepField = false): Promise<void> => {
    const mine = ++asked;
    let folder: BrowsedFolder;
    try {
      folder = await fsIpc.pickerBrowse(path);
    } catch (err) {
      if (mine !== asked) return;
      // A path being typed is often not a folder yet: say so only for a folder that was clicked.
      if (!keepField) say(err);
      return;
    }
    if (mine !== asked) return;
    const moved = shown?.path !== folder.path;
    shown = folder;
    note.textContent = folder.truncated ? "This folder holds more than is shown." : "";
    if (!keepField) input.value = folder.path;
    draw();
    if (moved) list.scrollTop = 0;
  };
  up.addEventListener("click", () => {
    const parent = shown?.parent;
    if (parent !== null && parent !== undefined) void show(parent);
  });
  newFolder.addEventListener("click", startNewFolder);
  hidden.addEventListener("change", draw);
  // The places: the home folder (what the host lists when asked for nothing), the folders in
  // it people keep work in, and the drives. Read once; the picker works without them.
  const place = (text: string, glyph: Parameters<typeof icon>[0], path: string) => {
    const button = h("button", { class: "web-path-place", type: "button", title: path });
    button.dataset.path = path;
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
        ...home.roots.map((root) => place(root, "server", root)),
      );
      draw();
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
  // Heard at the window, before the dialog's own key handling: a name being typed takes
  // Enter and Escape for itself, and Enter in the path field answers as the primary button.
  const onKey = (event: KeyboardEvent) => {
    if (editing && event.target === editing.input) {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") editing.commit();
      else editing.cancel();
      return;
    }
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
    // Said plainly: the browser's own picker would show this device, and this one doesn't.
    message: options.where.cloud
      ? "On your cloud workspace, not on this device."
      : `On ${options.where.name}, the computer this page is connected to.`,
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

/** `where`: the computer the page is connected to, named in the picker. */
export function createWebShell(where: HostPlace = { name: "the host", cloud: false }): Shell {
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
        pickPath({ title, kind: "folder", where, ...(start !== undefined && { start }) }),
      pickFile: (title, start) =>
        pickPath({ title, kind: "file", where, ...(start !== undefined && { start }) }),
      pickSavePath: (title, start) =>
        pickPath({ title, kind: "save", where, ...(start !== undefined && { start }) }),
      pickPaths: async (options: PickPathsOptions) => {
        const path = await pickPath({
          title: options.title ?? (options.directory ? "Choose a folder" : "Choose a file"),
          kind: options.directory ? "folder" : "file",
          where,
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
