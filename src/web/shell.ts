// What a browser tab offers in place of the app's own window (`core/ipc/shell.ts`): the IDE's
// dialogs for confirmations, a typed path where the desktop opens a native picker (the files
// are on the host, and the browser's own picker sees this computer's), the browser's clipboard,
// links in a new tab, full screen. Window controls do nothing: the tab is the browser's.
import { h } from "../core/dom/index";
import { createWindowlessShell, type PickPathsOptions, type Shell } from "../core/ipc/shell";
import { toDisposable } from "../core/lifecycle/index";
import { confirmAction, showDialog } from "../ui/Dialog";

/** Asks for a path on the host; null when cancelled or left empty. */
async function askPath(title: string, label: string, start?: string): Promise<string | null> {
  const input = h("input", {
    class: "input web-path-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": label,
  });
  input.value = start ?? "";
  const content = h("label", { class: "web-path" }, h("span", null, label), input);
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
  const ok = await showDialog<boolean>({
    title,
    message: "Enter a path on the computer you're connected to.",
    content,
    actions: [
      { label: "Cancel", value: false },
      { label: "Open", value: true, variant: "primary" },
    ],
    cancelValue: false,
  }).finally(() => window.removeEventListener("keydown", onKey, true));
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
      pickFolder: (title, defaultPath) => askPath(title, "Folder", defaultPath),
      pickFile: (title, defaultPath) => askPath(title, "File", defaultPath),
      pickSavePath: (title, defaultPath) => askPath(title, "Save as", defaultPath),
      pickPaths: async (options: PickPathsOptions) => {
        const path = await askPath(
          options.title ?? (options.directory ? "Choose a folder" : "Choose a file"),
          options.directory ? "Folder" : "File",
          options.defaultPath,
        );
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
