// The "Report a problem" tab (D204): a title and description, the parts of the report with a
// checkbox each (expand one to see exactly what it holds), the full text that will be used, and
// the ways out: open a new issue in the browser, copy the report, save it as a zip. Nothing is
// uploaded by the IDE. Buttons and checkboxes run the help.report* commands.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { ReportDraft } from "./reportModel";

export function reportViewDescriptor(
  services: WorkbenchServices,
  draft: ReportDraft,
): DockViewDescriptor {
  return {
    type: "report",
    title: () => "Report a problem",
    icon: () => "message-circle-question",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: () => new ReportView(services, draft),
  };
}

export class ReportView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();

  constructor(services: WorkbenchServices, draft: ReportDraft) {
    const run = (id: string, input: unknown = {}) =>
      void services.dispatcher.execute(id, input).catch(() => {});

    const title = h("input", {
      class: "input report-title",
      type: "text",
      placeholder: "A short summary",
      "aria-label": "Title",
    }) as HTMLInputElement;
    const description = h("textarea", {
      class: "input report-description",
      rows: "5",
      placeholder: "What did you do, what did you expect, and what happened instead?",
      "aria-label": "What happened",
    }) as HTMLTextAreaElement;
    title.value = draft.title.peek();
    description.value = draft.description.peek();
    this.store.add(on(title, "input", () => (draft.title.value = title.value)));
    this.store.add(on(description, "input", () => (draft.description.value = description.value)));

    const parts = h("div", { class: "report-parts" });
    const preview = h("pre", { class: "report-preview", tabindex: "0" });
    const hasTracker = product.issuesUrl !== "";
    const openIssue = h(
      "button",
      {
        class: "button button-primary",
        type: "button",
        "data-action": "open-issue",
        disabled: !hasTracker,
        title: hasTracker ? "" : "This build has no issue tracker set (product.json issuesUrl)",
      },
      "Open issue in browser",
    );
    const copy = h(
      "button",
      { class: "button button-secondary", type: "button", "data-action": "copy" },
      "Copy report",
    );
    const zip = h(
      "button",
      { class: "button button-secondary", type: "button", "data-action": "zip" },
      "Save as zip…",
    );
    this.store.add(on(openIssue, "click", () => run("help.reportOpenIssue")));
    this.store.add(on(copy, "click", () => run("help.reportCopy")));
    this.store.add(on(zip, "click", () => run("help.reportSaveZip")));

    this.element = h(
      "div",
      { class: "report-view", tabindex: "-1" },
      h(
        "div",
        { class: "report-page" },
        h("h1", { class: "report-heading" }, "Report a problem"),
        h(
          "p",
          { class: "report-lead" },
          "Nothing is sent from here. Open a new issue in your browser with this report filled in, or save it as a zip to attach yourself. Keys, tokens, your home folder and file contents are taken out; untick anything else you'd rather not share.",
        ),
        h("label", { class: "report-label" }, "Title", title),
        h("label", { class: "report-label" }, "What happened", description),
        h("h2", { class: "report-subheading" }, "Included"),
        parts,
        h("h2", { class: "report-subheading" }, "The report"),
        preview,
        h(
          "div",
          { class: "report-actions" },
          openIssue,
          copy,
          zip,
          hasTracker
            ? null
            : h("span", { class: "report-note" }, "No issue tracker is set for this build."),
        ),
      ),
    );

    // The parts: rebuilt when the list or a checkbox changes (open details are kept).
    let shotUrl: string | null = null;
    this.store.add(toDisposable(() => shotUrl && URL.revokeObjectURL(shotUrl)));
    const open = new Set<string>();
    const rowListeners = this.store.add(new DisposableStore());
    this.store.add(
      effect(() => {
        rowListeners.clear();
        const sections = draft.sections.value;
        const shot = draft.screenshot.value;
        const shotIncluded = draft.includeScreenshot.value;
        const rows: HTMLElement[] = sections.map((s) => {
          const box = h("input", {
            type: "checkbox",
            class: "report-check",
            checked: s.included,
            "aria-label": `Include ${s.title}`,
            "data-section": s.id,
          }) as HTMLInputElement;
          rowListeners.add(
            on(box, "change", () =>
              run("help.reportInclude", { section: s.id, included: box.checked }),
            ),
          );
          const details = h(
            "details",
            { class: "report-part", open: open.has(s.id) },
            h(
              "summary",
              { class: "report-part-head" },
              box,
              h("span", { class: "report-part-title" }, s.title),
              h(
                "span",
                { class: "report-part-size" },
                s.text ? `${s.text.length.toLocaleString()} characters` : "empty",
              ),
            ),
            h("pre", { class: "report-part-text" }, s.text || "(nothing)"),
          );
          rowListeners.add(
            on(details, "toggle", () => {
              if (details.open) open.add(s.id);
              else open.delete(s.id);
            }),
          );
          // A click on the checkbox toggles it, not the details.
          rowListeners.add(on(box, "click", (e) => e.stopPropagation()));
          return details;
        });
        if (shot) {
          if (!shotUrl)
            shotUrl = URL.createObjectURL(new Blob([shot.png as BlobPart], { type: "image/png" }));
          const box = h("input", {
            type: "checkbox",
            class: "report-check",
            checked: shotIncluded,
            "aria-label": "Include the screenshot",
            "data-section": "screenshot",
          }) as HTMLInputElement;
          rowListeners.add(
            on(box, "change", () =>
              run("help.reportInclude", { section: "screenshot", included: box.checked }),
            ),
          );
          rows.push(
            h(
              "div",
              { class: "report-part report-shot" },
              h(
                "label",
                { class: "report-part-head" },
                box,
                h("span", { class: "report-part-title" }, "Screenshot of the window"),
                h("span", { class: "report-part-size" }, `${shot.width}×${shot.height}`),
              ),
              h("img", { class: "report-shot-image", src: shotUrl, alt: "Screenshot" }),
            ),
          );
        }
        parts.replaceChildren(...rows);
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        draft.sections.value;
        draft.description.value;
        draft.includeScreenshot.value;
        preview.textContent = draft.body();
        return undefined;
      }),
    );
  }

  focus(): void {
    this.element.querySelector<HTMLElement>(".report-title")?.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    // The draft outlives the tab; the next "Report a problem" gathers again.
    this.store.dispose();
  }
}
