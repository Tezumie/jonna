// A cell's outputs drawn (D188): streams and errors with their ANSI colors, then each rich
// output in the richest form the IDE shows safely — images (PNG, JPEG, GIF, SVG as a picture),
// Markdown, LaTeX, HTML through the Markdown renderer's allowlist (tables, pandas frames; no
// scripts), JSON, plain text. Outputs that run code (widgets, Plotly, Bokeh, scripted HTML) go
// to a sandboxed frame when the host gives one (D189, outputFrame.ts).
import { h } from "../../../core/dom/index";
import { markdownNodes, sanitizeHtml } from "../../../ui/markdown/render";
import { mathElement } from "../../../ui/markdown/visuals";
import { ansiNodes } from "./ansi";
import { type NbOutput, resolveCarriageReturns } from "./model";

export interface OutputHost {
  openLink(href: string): void;
  copy(text: string): void;
  /** Long outputs scroll inside a box instead of growing the cell. */
  scrollable: boolean;
  /** A sandboxed frame for an output that runs code (D189), or null to draw it here. */
  frame?(o: NbOutput): { element: HTMLElement; dispose(): void } | null;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Richest first (what Jupyter Lab and VS Code prefer). */
const ORDER = [
  "application/vnd.jupyter.widget-view+json",
  "text/html",
  "image/svg+xml",
  ...IMAGE_TYPES,
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
];

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.join("") : JSON.stringify(v, null, 2);

/** Text shown at most (the end of it): the file keeps all of it. */
const MAX_SHOWN = 200_000;

function textBlock(text: string, className: string): HTMLElement {
  const pre = h("pre", { class: `nb-out-text ${className}` });
  if (text.length > MAX_SHOWN) {
    const cut = text.length - MAX_SHOWN;
    pre.append(
      h(
        "span",
        { class: "nb-out-note" },
        `… ${cut.toLocaleString()} earlier characters not shown\n`,
      ),
    );
    text = text.slice(cut);
  }
  pre.append(...ansiNodes(resolveCarriageReturns(text)));
  return pre;
}

/** Whether HTML needs scripts to show anything (plotly, bokeh, widgets' fallbacks). */
const scripted = (html: string) =>
  /<script\b/i.test(html) &&
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim().length < 20;

function richOutput(o: NbOutput, host: OutputHost): HTMLElement {
  const data = o.data ?? {};
  const mime = ORDER.find((m) => m in data) ?? Object.keys(data)[0];
  const value = mime ? data[mime] : undefined;
  if (!mime || value === undefined) return h("div", { class: "nb-out-note" }, "(empty output)");
  if (mime === "application/vnd.jupyter.widget-view+json") {
    // A widget's own fallback when the kernel sent a richer one than its text.
    const rest = { ...data };
    delete rest["application/vnd.jupyter.widget-view+json"];
    if (Object.keys(rest).some((k) => k !== "text/plain"))
      return richOutput({ ...o, data: rest }, host);
    return h(
      "div",
      { class: "nb-out-note" },
      `An interactive widget (${asText(data["text/plain"]) || "ipywidgets"}): run the cell to use it.`,
    );
  }
  if (mime === "text/html") {
    const html = asText(value);
    if (scripted(html) && data["text/plain"] !== undefined && !IMAGE_TYPES.some((t) => t in data))
      return h(
        "div",
        { class: "nb-out-rich" },
        h(
          "div",
          { class: "nb-out-note" },
          "This output needs scripts to show (shown as text; they run once the folder is trusted):",
        ),
        textBlock(asText(data["text/plain"]), ""),
      );
    if (scripted(html)) {
      const img = IMAGE_TYPES.find((t) => t in data);
      if (img) return image(img, data[img]);
    }
    return h(
      "div",
      { class: "nb-out-html md md-document" },
      ...sanitizeHtml(html, { openLink: host.openLink, copy: host.copy }),
    );
  }
  if (mime === "image/svg+xml")
    return h("img", {
      class: "nb-out-image",
      alt: "SVG output",
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asText(value))}`,
    });
  if (IMAGE_TYPES.includes(mime)) return image(mime, value, o.metadata?.[mime]);
  if (mime === "text/markdown")
    return h(
      "div",
      { class: "nb-out-md md md-document" },
      ...markdownNodes(asText(value), {
        openLink: host.openLink,
        copy: host.copy,
        headingShift: 0,
        softBreaks: "space",
      }),
    );
  if (mime === "text/latex") {
    const tex = asText(value)
      .trim()
      .replace(/^\$\$?|\$\$?$/g, "");
    return h("div", { class: "nb-out-math" }, mathElement(tex, true));
  }
  if (mime === "application/json")
    return h("pre", { class: "nb-out-text nb-out-json" }, JSON.stringify(value, null, 2));
  return textBlock(asText(value), "");
}

function image(mime: string, value: unknown, meta?: unknown): HTMLElement {
  const img = h("img", {
    class: "nb-out-image",
    alt: "Image output",
    src: `data:${mime};base64,${asText(value).replace(/\s/g, "")}`,
  }) as HTMLImageElement;
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  if (typeof m.width === "number") img.style.width = `${m.width}px`;
  if (typeof m.height === "number") img.style.height = `${m.height}px`;
  return img;
}

/** One output's element. */
export function outputElement(o: NbOutput, host: OutputHost): HTMLElement {
  if (o.output_type === "stream")
    return textBlock(o.text ?? "", o.name === "stderr" ? "is-stderr" : "");
  if (o.output_type === "error") {
    const tb = (o.traceback ?? []).join("\n");
    return textBlock(tb || `${o.ename ?? "Error"}: ${o.evalue ?? ""}`, "is-error");
  }
  return richOutput(o, host);
}
