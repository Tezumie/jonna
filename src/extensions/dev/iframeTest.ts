// Dev-only "iframe-test" dock view: proves the iframe layer (docs/dock.md §6). The iframe lives in
// the layer outside the dock and is positioned over this view's slot, so moving the tab between
// groups does not reload it: the load counter stays at 1 and text typed into the frame survives.
import { h } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

const FRAME_DOC = `<!doctype html><meta charset="utf-8">
<style>
  html { color-scheme: dark light; }
  body { margin: 0; padding: 16px; font: 13px/20px system-ui, sans-serif; background: Canvas; color: CanvasText; }
  input { font: inherit; padding: 4px 8px; width: 16em; }
</style>
<p>This text field lives inside an iframe. Type something, then drag the tab to another group:
the text stays because the frame never reloads.</p>
<input aria-label="Test input" placeholder="Type here">`;

export function registerIframeTest(sub: DisposableStore, services: WorkbenchServices): void {
  const { dock, dispatcher, iframes } = services;
  const loads = new Map<string, number>();
  sub.add(
    dock.views.register({
      type: "iframe-test",
      title: () => "Iframe test",
      icon: () => "globe",
      create: (_state, ctx): DockView => {
        const store = new DisposableStore();
        const counter = h("span", { class: "iframe-test-loads" }, "Loads: 0");
        const slot = h("div", { class: "iframe-test-slot" });
        const element = h(
          "div",
          { class: "iframe-test-view" },
          h("div", { class: "iframe-test-bar" }, counter),
          slot,
        );
        const frame = document.createElement("iframe");
        frame.title = "Iframe test";
        frame.setAttribute("sandbox", "");
        frame.srcdoc = FRAME_DOC;
        frame.addEventListener("load", () => {
          const n = (loads.get(ctx.tabId) ?? 0) + 1;
          loads.set(ctx.tabId, n);
          counter.textContent = `Loads: ${n}`;
        });
        store.add(iframes.attach(slot, frame));
        store.add({ dispose: () => loads.delete(ctx.tabId) });
        return {
          element,
          serialize: () => null,
          persist: () => false,
          dispose: () => store.dispose(),
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "dev.openIframeTest",
      title: "Open iframe test view",
      category: "Developer",
      description:
        "Opens a tab hosting an iframe through the iframe layer. ide://dev/iframes reports how often each loaded (1 = never reloaded).",
      input: s.empty(),
      effects: [],
      run: () => ({ tabId: dock.openView("iframe-test", null, "main", true) }),
    }),
  );
  sub.add(
    services.state.register("ide://dev/iframes", {
      description: "Dev only: iframe-test tabs and how many times each iframe has loaded.",
      get: () => Object.fromEntries(loads),
    }),
  );
}
