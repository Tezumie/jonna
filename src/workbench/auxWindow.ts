// Auxiliary windows (D101), VS Code style: `window.open("about:blank")` from the main webview
// (the native side builds a related webview), then this code fills the new document itself — the
// app's stylesheets and theme attributes are mirrored into it, keys go through the same keyboard
// service, menus and tooltips work there. A view moved into one keeps running in the main
// window's JavaScript, so commands, agents and state paths reach it exactly as before.
import { Emitter, type Event } from "../core/events/index";
import { call, isTauri } from "../core/ipc/invoke";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { installIconSprite } from "../ui/Icon";
import { registerMenuDocument } from "../ui/Menu";
import { installSelectMenus } from "../ui/SelectMenu";
import { Tooltips } from "../ui/Tooltip";
import { suppressBrowserDefaults } from "./browserDefaults";
import type { KeyboardService } from "./keyboard";

export interface AuxWindow extends Disposable {
  readonly window: Window;
  /** Where content goes (fills the window). */
  readonly host: HTMLElement;
  /** Native window label (screenshots), when known. */
  readonly label: string | null;
  /** The user closed the window (or it was disposed). */
  readonly onDidClose: Event<void>;
  setTitle(title: string): void;
  focus(): void;
}

let counter = 0;

export class AuxWindowService implements Disposable {
  private readonly open = new Set<AuxWindow>();

  constructor(private readonly keyboard: KeyboardService) {}

  /** The native label of the auxiliary window `win` (screenshots), if it is one. */
  labelOf(win: Window): string | null {
    for (const aux of this.open) if (aux.window === win) return aux.label;
    return null;
  }

  async create(options: { title: string; width?: number; height?: number }): Promise<AuxWindow> {
    const width = Math.round(options.width ?? 1000);
    const height = Math.round(options.height ?? 720);
    const left = Math.round(window.screenX + 60);
    const top = Math.round(window.screenY + 60);
    const name = `ide-aux-${++counter}`;
    const win = window.open(
      "about:blank",
      name,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
    if (!win) throw new Error("Couldn't open a window (the system refused it).");
    // The native side may need a moment before the document is scriptable.
    for (let i = 0; i < 50 && !win.document?.body; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = win.document;
    if (!doc?.body) throw new Error("The new window didn't open.");
    const label = isTauri()
      ? await call<string | null>("aux_window_label").catch(() => null)
      : null;

    const store = new DisposableStore();
    const closed = store.add(new Emitter<void>());
    doc.title = options.title;
    // Theme, density and panel attributes follow the main window.
    const syncRoot = () => {
      for (const attr of Array.from(document.documentElement.attributes))
        doc.documentElement.setAttribute(attr.name, attr.value);
    };
    syncRoot();
    const rootObserver = new MutationObserver(syncRoot);
    rootObserver.observe(document.documentElement, { attributes: true });
    store.add(toDisposable(() => rootObserver.disconnect()));
    // Stylesheets: the app's, plus any added later (editor widgets, themes, extensions' decoration
    // types). Each copy is paired with its original, not by position: the editor engine removes
    // its own <style>s as editors close, and a sheet that comes and goes (decoration types) would
    // otherwise leave its text updates landing on another copy (decorations unstyled here).
    const copies = new Map<Node, Node>();
    const mirror = (node: Node) => {
      if (copies.has(node)) return;
      if (
        node instanceof HTMLStyleElement ||
        (node instanceof HTMLLinkElement && node.rel === "stylesheet")
      ) {
        const copy = node.cloneNode(true);
        copies.set(node, copy);
        doc.head.append(copy);
      }
    };
    const unmirror = (node: Node) => {
      const copy = copies.get(node);
      if (!copy) return;
      copies.delete(node);
      copy.parentNode?.removeChild(copy);
    };
    for (const node of Array.from(document.head.children)) mirror(node);
    const headObserver = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.removedNodes)) unmirror(n);
        for (const n of Array.from(r.addedNodes)) if (n.parentNode === document.head) mirror(n);
      }
    });
    headObserver.observe(document.head, { childList: true });
    store.add(toDisposable(() => headObserver.disconnect()));
    // An inline <style> changed later (theme overrides, decoration types): copy its text too.
    const styleObserver = new MutationObserver((records) => {
      const changed = new Set<HTMLStyleElement>();
      for (const r of records) {
        const target = r.target instanceof Text ? r.target.parentNode : r.target;
        if (target instanceof HTMLStyleElement) changed.add(target);
      }
      for (const s of changed) {
        const copy = copies.get(s);
        if (copy && copy.textContent !== s.textContent) copy.textContent = s.textContent;
      }
    });
    styleObserver.observe(document.head, { characterData: true, subtree: true, childList: true });
    store.add(toDisposable(() => styleObserver.disconnect()));

    doc.body.className = "aux-window";
    installIconSprite(doc);
    const host = doc.createElement("div");
    host.className = "aux-window-host";
    doc.body.append(host);

    store.add(this.keyboard.attachDisposable(win));
    store.add(suppressBrowserDefaults(win));
    store.add(registerMenuDocument(doc));
    store.add(installSelectMenus(doc));
    store.add(new Tooltips((command) => this.keyboard.labelFor(command), doc));

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      closed.fire();
    };
    win.addEventListener("pagehide", finish);
    win.addEventListener("beforeunload", finish);
    const poll = window.setInterval(() => {
      if (win.closed) finish();
    }, 500);
    store.add(toDisposable(() => clearInterval(poll)));

    const aux: AuxWindow = {
      window: win,
      host,
      label,
      onDidClose: closed.event,
      setTitle: (title) => {
        doc.title = title;
      },
      focus: () => win.focus(),
      dispose: () => {
        this.open.delete(aux);
        finish();
        store.dispose();
        if (!win.closed) win.close();
        if (label) void call("aux_window_close", { label }).catch(() => {});
      },
    };
    this.open.add(aux);
    return aux;
  }

  dispose(): void {
    for (const aux of Array.from(this.open)) aux.dispose();
  }
}
