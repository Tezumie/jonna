// Pages an extension's code writes for its webview views and file viewers (D257: VS Code's
// `registerWebviewViewProvider` and custom editors), where a declared view or viewer has no HTML
// file of its own. Like a webview panel's (runtimeWebviewPanels.ts), each page is served by the
// extension folder's proxy at `/__webview-<name>.html` under a new name per change; until the
// code sets one, a frame shows an empty page. A key is a view's id, or a viewer's open tab.
import { extIpc } from "../../core/ipc/extensions";
import type { Disposable } from "../../core/lifecycle/index";
import type { WebviewFrame } from "./webview";

/** A page's HTML (the proxy refuses more than 8 MB). */
const MAX_HTML = 8 * 1024 * 1024;
// The frame's own color scheme (an iframe prefers its element's), so it isn't a white sheet in a
// dark theme while it waits (D260).
const BLANK =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body></body></html>';

export function codePagePath(name: string): string {
  return `__webview-${name}.html`;
}

export class CodePages implements Disposable {
  private readonly stamp = Date.now().toString(36);
  private seq = 0;
  private disposed = false;
  private readonly current = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private blank: Promise<void> | null = null;
  /** Each key's page being served, so a message sent meanwhile reaches the new page (D261). */
  private readonly serving = new Map<string, Promise<void>>();

  /** Resolves once `key`'s latest page is served (and its frames are loading it). */
  settled(key: string): Promise<void> {
    return (this.serving.get(key) ?? Promise.resolve()).catch(() => {});
  }

  constructor(private readonly root: string) {}

  /** Writes the empty page frames start on (once). */
  ready(): Promise<void> {
    this.blank ??= extIpc.webviewPage(this.root, `${this.stamp}-blank`, BLANK).catch(() => {});
    return this.blank;
  }

  /** The page a new frame of `key` shows: its HTML when the code set it, else the empty page. */
  path(key: string): string {
    return codePagePath(this.current.get(key) ?? `${this.stamp}-blank`);
  }

  /**
   * Serves `html` for `key` and shows it in the key's frames; a newer call overtakes an older one.
   * The frames are asked for once the page is served (D260): one that opened meanwhile started on
   * the empty page and would otherwise stay there.
   */
  set(key: string, html: string, frames: () => readonly WebviewFrame[]): Promise<void> {
    const serving = this.serve(key, html, frames);
    this.serving.set(key, serving);
    void serving
      .catch(() => {})
      .then(() => {
        if (this.serving.get(key) === serving) this.serving.delete(key);
      });
    return serving;
  }

  private async serve(
    key: string,
    html: string,
    frames: () => readonly WebviewFrame[],
  ): Promise<void> {
    if (html.length > MAX_HTML) throw new Error("A page's HTML is limited to 8 MB.");
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    const name = `${this.stamp}-c${++this.seq}`;
    await extIpc.webviewPage(this.root, name, html);
    if (this.disposed || this.versions.get(key) !== version) {
      void extIpc.webviewPage(this.root, name, null).catch(() => {});
      return;
    }
    const old = this.current.get(key);
    this.current.set(key, name);
    for (const frame of frames()) frame.navigate(codePagePath(name));
    if (old) void extIpc.webviewPage(this.root, old, null).catch(() => {});
  }

  /** A viewer's tab closed: its page goes. */
  drop(key: string): void {
    const name = this.current.get(key);
    this.current.delete(key);
    this.versions.delete(key);
    if (name) void extIpc.webviewPage(this.root, name, null).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of this.current.values())
      void extIpc.webviewPage(this.root, name, null).catch(() => {});
    this.current.clear();
    if (this.blank) void extIpc.webviewPage(this.root, `${this.stamp}-blank`, null).catch(() => {});
  }
}
