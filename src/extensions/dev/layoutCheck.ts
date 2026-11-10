// Regression check for M1.6 A1 (layout overflow): opens many tabs in one group, shrinks the window
// to 640×480 and back, and asserts that nothing makes the document larger than the window and the
// window controls stay fully on-screen. `dev.checkLayoutOverflow` runs it in the real app; the
// command-script runner uses the same command.

import { isTauri } from "../../core/ipc/invoke";
import { windowIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

interface Probe {
  at: string;
  scrollWidth: number;
  scrollHeight: number;
  innerWidth: number;
  innerHeight: number;
  closeButtonInside: boolean;
}

function probe(at: string): Probe {
  const root = document.documentElement;
  const close = document.querySelector<HTMLElement>(".window-control.is-close, .window-controls");
  const r = close?.getBoundingClientRect();
  return {
    at,
    scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
    scrollHeight: Math.max(root.scrollHeight, document.body.scrollHeight),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    // macOS has no custom controls; then there is nothing to push off-screen.
    closeButtonInside:
      !r ||
      (r.left >= 0 &&
        r.top >= 0 &&
        r.right <= window.innerWidth + 0.5 &&
        r.bottom <= window.innerHeight + 0.5),
  };
}

const frames = (n = 3) =>
  new Promise<void>((resolve) => {
    const step = (k: number) => (k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerLayoutCheck(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock } = services;
  sub.add(
    dispatcher.register({
      id: "dev.checkLayoutOverflow",
      title: "Check layout overflow",
      category: "Developer",
      description:
        "Opens `tabs` read-only tabs in one group, resizes the window to 640×480 and back, and checks the document never gets wider/taller than the window and the close button stays on-screen. Returns { ok, probes }.",
      input: s.object({
        tabs: s.integer({ min: 1, max: 500 }).describe("How many tabs (default 80)").optional(),
        keepTabs: s.boolean().describe("Leave the tabs open afterwards (screenshots)").optional(),
      }),
      effects: [],
      run: async ({ tabs, keepTabs }) => {
        const count = tabs ?? 80;
        const opened: string[] = [];
        for (let i = 0; i < count; i++) {
          opened.push(dock.openView("layout-check-stub", { n: i }, "main", false));
        }
        await frames();
        const probes = [probe("many tabs")];
        if (isTauri()) {
          const before = await windowIpc.innerSize();
          await windowIpc.unmaximize().catch(() => {});
          await windowIpc.setSize(640, 480);
          await sleep(400);
          await frames();
          probes.push(probe("640×480"));
          await windowIpc.setSize(before.width, before.height);
          await sleep(400);
          await frames();
          probes.push(probe("restored"));
        }
        if (!keepTabs) {
          for (const id of opened) await dock.closeTab(id, true);
          await frames();
          probes.push(probe("tabs closed"));
        }
        const failed = probes.filter(
          (p) =>
            p.scrollWidth > p.innerWidth || p.scrollHeight > p.innerHeight || !p.closeButtonInside,
        );
        const ok = failed.length === 0;
        services.notifications.show(
          ok ? "info" : "error",
          ok
            ? `Layout check passed (${count} tabs, ${probes.length} probes).`
            : `Layout check failed at: ${failed.map((p) => `${p.at} (${p.scrollWidth}×${p.scrollHeight} in ${p.innerWidth}×${p.innerHeight})`).join(", ")}`,
        );
        return { ok, probes };
      },
    }),
  );
  // A minimal tab type for the check: cheap to create, long titles.
  sub.add(
    dock.views.register({
      type: "layout-check-stub",
      title: (state) =>
        `A rather long tab title number ${(state as { n?: number } | null)?.n ?? 0}.ts`,
      icon: () => "file-code",
      create: () => {
        const element = document.createElement("div");
        return {
          element,
          serialize: () => null,
          persist: () => false,
          dispose: () => element.remove(),
        };
      },
    }),
  );
}
