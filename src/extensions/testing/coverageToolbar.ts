// VS Code's floating coverage toolbar (D233): while a coverage report is loaded and the active tab
// is an editor of a file in it, a small bar over the editor's bottom right shows that file's
// coverage (a click opens the Test coverage tab), which test's coverage is shown (with per-test
// data: the "All tests ▾" picker), Covered by (the tests that ran the cursor's line), previous /
// next uncovered line, inline coverage on / off, and a close button
// (testing.coverageToolbarEnabled). It floats in the page, positioned over the editor's element,
// so the editor itself isn't changed. Every button runs a command.
import { h, on } from "../../core/dom/index";
import { type DisposableStore, MutableDisposable, toDisposable } from "../../core/lifecycle/index";
import { effect, type Signal } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { TestController } from "./controller";
import { combinedPercent, fileTotals, hasPerTestCoverage } from "./coverage";

/** Distance from the editor's bottom right corner (clear of its scrollbar). */
const INSET = 20;

export function registerCoverageToolbar(
  sub: DisposableStore,
  services: WorkbenchServices,
  tests: TestController,
  inline: Signal<boolean>,
): void {
  const { dock, settings, workspace, dispatcher } = services;
  const run = (command: string, input: unknown = {}) =>
    void dispatcher.execute(command, input).catch((err: unknown) => {
      services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  const button = (glyph: IconName, title: string, command: string, input?: unknown) => {
    const b = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": title },
      icon(glyph),
    );
    setTooltip(b, title, command);
    sub.add(on(b, "click", () => run(command, input)));
    return b;
  };
  const summary = h("button", { class: "coverage-float-summary", type: "button" });
  setTooltip(summary, "Open the Test coverage tab", "tests.showCoverage");
  sub.add(on(summary, "click", () => run("tests.showCoverage")));
  const filterLabel = h("span", { class: "coverage-float-label" });
  const filter = h(
    "button",
    { class: "coverage-float-filter", type: "button" },
    filterLabel,
    icon("chevron-down"),
  );
  setTooltip(filter, "Show coverage for one test, or all of them", "tests.showCoverageForTest");
  sub.add(on(filter, "click", () => run("tests.showCoverageForTest")));
  const coveredBy = button("users", "Covered by: the tests that ran this line", "tests.coveredBy");
  const toggle = button("eye", "Hide inline coverage", "tests.toggleInlineCoverage");
  const bar = h(
    "div",
    { class: "coverage-float", role: "toolbar", "aria-label": "Test coverage", hidden: true },
    summary,
    filter,
    coveredBy,
    button("arrow-up", "Go to previous uncovered line", "tests.goToPreviousUncoveredLine"),
    button("arrow-down", "Go to next uncovered line", "tests.goToNextUncoveredLine"),
    toggle,
    button("x", "Hide this toolbar", "tests.toggleCoverageToolbar", { on: false }),
  );
  document.body.append(bar);
  sub.add(toDisposable(() => bar.remove()));

  /** The editor element the bar sits over (watched for size changes). */
  let target: HTMLElement | null = null;
  const watch = sub.add(new MutableDisposable());
  const place = () => {
    if (!target || bar.hidden) return;
    const r = target.getBoundingClientRect();
    // Too small to hold it (a squeezed group): out of the way.
    if (r.width < bar.offsetWidth + 2 * INSET || r.height < bar.offsetHeight + 2 * INSET) {
      bar.style.visibility = "hidden";
      return;
    }
    bar.style.visibility = "";
    bar.style.left = `${Math.round(r.right - bar.offsetWidth - INSET)}px`;
    bar.style.top = `${Math.round(r.bottom - bar.offsetHeight - INSET)}px`;
  };
  sub.add(on(window, "resize", place));

  sub.add(
    effect(() => {
      settings.version.value;
      dock.root.value;
      dock.focusedGroupId.value;
      const shown = tests.shownCoverage.value;
      const report = tests.coverage.value;
      const test = tests.coverageTest.value;
      const inlineOn = inline.value;
      const enabled = settings.peek<boolean>("testing.coverageToolbarEnabled") !== false;
      const tab = dock.activeTab();
      const path = tab?.viewType === "editor" ? stateField(tab.viewState, "path") : undefined;
      // As reports name files: with several folders, the folder's name first (D251).
      const file =
        typeof path === "string" && workspace.root.peek() && workspace.contains(path)
          ? workspace.relative(path)
          : "";
      const inReport = !!file && !!report?.files.some((f) => f.file === file);
      const element = tab && inReport ? dock.liveView(tab.id)?.element : undefined;
      // Over the main window's editors only (one in a window of its own has its own page).
      const show = enabled && !!element && element.ownerDocument === document;
      bar.hidden = !show;
      if (!show || !element) {
        target = null;
        watch.clear();
        return undefined;
      }
      const fc = shown?.files.find((f) => f.file === file);
      const p = fc ? combinedPercent(fileTotals(fc)) : null;
      summary.textContent = fc
        ? `${p === null ? "–" : `${p}%`} covered`
        : test
          ? "Not run by this test"
          : "Not in the report";
      const perTest = hasPerTestCoverage(report?.files ?? []);
      filter.hidden = !perTest;
      coveredBy.hidden = !perTest;
      filterLabel.textContent = test ? test.label : "All tests";
      toggle.replaceChildren(icon(inlineOn ? "eye" : "eye-off"));
      const toggleTitle = inlineOn ? "Hide inline coverage" : "Show inline coverage";
      toggle.setAttribute("aria-label", toggleTitle);
      setTooltip(toggle, toggleTitle, "tests.toggleInlineCoverage");
      if (target !== element) {
        target = element;
        const observer = new ResizeObserver(() => place());
        observer.observe(element);
        watch.value = toDisposable(() => observer.disconnect());
      }
      // After this task: the dock lays the new tab out first.
      requestAnimationFrame(place);
      return undefined;
    }),
  );
}
