// Stops webview browser behavior from leaking into the IDE. WebView2 (Windows) handles "browser
// accelerator" keys — Ctrl+P print, Ctrl+F find, Ctrl+R / F5 reload, Ctrl+Shift+I devtools,
// Ctrl+J downloads, Ctrl+H history, Ctrl+U source, Ctrl+G/F3 find next — after the page has seen
// them, unless the page calls preventDefault(). Tauri 2.12 doesn't expose
// `AreBrowserAcceleratorKeysEnabled`, so this bubble-phase listener cancels those keys whenever
// nothing in the IDE (keybindings, Monaco, the terminal) handled them first. Also disables the
// browser's own context menu outside editable fields (we show our own menus).

import { on } from "../core/dom/index";
import { clipboardIpc } from "../core/ipc/system";
import { chordFromEvent } from "../core/keybindings/index";
import { type Disposable, DisposableStore } from "../core/lifecycle/index";
import { type MenuItem, showContextMenu } from "../ui/Menu";

/** Chords (normalized like keybinding rules) that a browser would act on. */
export const BROWSER_ACCELERATORS: ReadonlySet<string> = new Set([
  "ctrl+p",
  "ctrl+shift+p",
  "ctrl+f",
  "ctrl+g",
  "ctrl+shift+g",
  "f3",
  "shift+f3",
  "ctrl+r",
  "ctrl+shift+r",
  "f5",
  "ctrl+f5",
  "shift+f5",
  "ctrl+shift+i",
  "ctrl+shift+j",
  "ctrl+shift+c",
  "f12",
  // A browser's own full screen: F11 is the IDE's (window.toggleFullscreen) when it's bound.
  "f11",
  "ctrl+j",
  "ctrl+h",
  "ctrl+u",
  "ctrl+s",
  "ctrl+o",
  "ctrl+n",
  "ctrl+shift+n",
  "ctrl+t",
  "ctrl+shift+t",
  "ctrl+d",
  "ctrl+shift+delete",
  "ctrl+shift+o",
  "ctrl+shift+b",
  "ctrl+shift+a",
  "ctrl+shift+e",
  "ctrl+shift+k",
  "ctrl+shift+s",
  "ctrl+shift+y",
  "ctrl+shift+m",
  "f7",
  "alt+left",
  "alt+right",
  "alt+home",
  "browserback",
  "browserforward",
]);

export function suppressBrowserDefaults(target: Window = window): Disposable {
  const store = new DisposableStore();
  store.add(
    on(target, "keydown", (e) => {
      if (e.defaultPrevented) return;
      const chord = chordFromEvent(e);
      if (chord && BROWSER_ACCELERATORS.has(chord.replace(/^meta\+/, "ctrl+"))) e.preventDefault();
    }),
  );
  store.add(
    on(target, "contextmenu", (e) => {
      if (e.defaultPrevented) return;
      const el = e.target instanceof Element ? e.target : null;
      // Text fields keep the native cut/copy/paste menu.
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      textMenu(target, el, e.clientX, e.clientY);
    }),
  );
  return store;
}

/** Where read-only text gets the Copy menu (D190): rendered Markdown, the agent's chat. */
const TEXT_AREAS = ".md-document, .md, .agent-log, .nb-outputs-body, .help-doc";

/**
 * Right-click on text that isn't a field: Copy (the selection), Select all, and in the agent's
 * chat Paste into its message box — what VS Code's Markdown preview and chat offer (D190).
 */
function textMenu(win: Window, el: Element | null, x: number, y: number): void {
  if (!el) return;
  const area = el.closest(TEXT_AREAS);
  const selection = win.getSelection();
  const text = selection && !selection.isCollapsed ? selection.toString() : "";
  if (!area && !text) return;
  const agent = el.closest(".agent-view");
  const box = agent?.querySelector<HTMLTextAreaElement | HTMLInputElement>(".agent-input");
  const items: MenuItem[] = [
    {
      label: "Copy",
      icon: "copy",
      keybinding: /Mac/.test(navigator.platform) ? "Cmd+C" : "Ctrl+C",
      disabled: !text,
      run: () => void clipboardIpc.writeText(text).catch(() => {}),
    },
  ];
  if (box)
    items.push({
      label: "Paste",
      icon: "clipboard-paste",
      keybinding: /Mac/.test(navigator.platform) ? "Cmd+V" : "Ctrl+V",
      run: () =>
        void clipboardIpc.readText().then((t) => {
          if (!t) return;
          box.focus();
          box.setRangeText(
            t,
            box.selectionStart ?? box.value.length,
            box.selectionEnd ?? box.value.length,
            "end",
          );
          box.dispatchEvent(new Event("input", { bubbles: true }));
        }),
    });
  if (area)
    items.push({
      label: "Select all",
      icon: "text-select",
      separatorBefore: true,
      run: () => {
        const range = win.document.createRange();
        range.selectNodeContents(area);
        const sel = win.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      },
    });
  showContextMenu(x, y, items);
}
