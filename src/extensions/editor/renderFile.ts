// A file's first lines as the editor colors them, and its icon from the file icon theme, as
// self-contained markup (D184): for extension pages (the canvas's file cards) that can't load the
// editor or the theme's stylesheets. Colors are resolved here into inline `color` styles; every
// piece of text is escaped here, whatever the engine produced.

import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { fileIcon, icon } from "../../ui/Icon";
import type { WorkbenchServices } from "../../workbench/services";
import { languageForPath } from "./languages";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 400;
const MAX_SHOWN = 24 * 1024;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only colors and simple font styles pass (the values come from getComputedStyle). */
const SAFE_COLOR = /^(rgba?\([\d.,\s%]+\)|#[0-9a-f]{3,8})$/i;

/** The engine's colored HTML → spans with inline colors (resolved in this document). */
export function inlineColors(html: string): string {
  const host = document.createElement("div");
  host.className = "monaco-editor";
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  // Parsed inert first, then rebuilt here from text and the engine's token classes only (the
  // live copy is needed to read the theme's colors).
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const rebuild = (from: Node, to: HTMLElement) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) to.append(child.textContent ?? "");
      else if ((child as Element).tagName === "BR") to.append(document.createElement("br"));
      else if ((child as Element).tagName === "SPAN" || (child as Element).tagName === "DIV") {
        const el = document.createElement((child as Element).tagName === "SPAN" ? "span" : "div");
        const classes = ((child as Element).getAttribute("class") ?? "")
          .split(/\s+/)
          .filter((c) => /^mtk[a-z0-9]+$/i.test(c));
        if (classes.length) el.className = classes.join(" ");
        rebuild(child, el);
        to.append(el);
      }
    }
  };
  rebuild(parsed.body, host);
  document.body.append(host);
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escapeHtml(child.textContent ?? "");
      } else if (child instanceof HTMLBRElement) {
        out += "\n";
      } else if (child instanceof HTMLElement) {
        if (child.tagName === "SPAN" && child.childElementCount === 0) {
          const style = getComputedStyle(child);
          const parts: string[] = [];
          if (SAFE_COLOR.test(style.color)) parts.push(`color:${style.color}`);
          if (style.fontStyle === "italic") parts.push("font-style:italic");
          if (Number(style.fontWeight) >= 600) parts.push("font-weight:600");
          out += `<span style="${parts.join(";")}">${escapeHtml(child.textContent ?? "")}</span>`;
        } else {
          walk(child);
          // The engine puts each line in a block of its own.
          if (child.tagName === "DIV" && !out.endsWith("\n")) out += "\n";
        }
      }
    }
  };
  walk(host);
  host.remove();
  return out.replace(/\n+$/, "");
}

/** An image the icon theme points at (the IDE's own assets), as a data: URL; null if not. */
async function inlineImage(href: string): Promise<string | null> {
  if (href.startsWith("data:image/")) return href;
  try {
    const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
    if (!bytes.length || bytes.length > 256 * 1024) return null;
    // Theme files come without a type: told apart by their first bytes.
    const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
    const type =
      bytes[0] === 0x89 && bytes[1] === 0x50
        ? "image/png"
        : head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!--")
          ? "image/svg+xml"
          : null;
    if (!type) return rasterize(href);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return rasterize(href);
  }
}

/** Fallback when the asset can't be fetched as bytes: drawn at 32 px and taken as a PNG. */
function rasterize(href: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        canvas.getContext("2d")?.drawImage(img, 0, 0, 32, 32);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}

/** The theme's icon for a file name, as standalone SVG markup with its color resolved. */
async function iconMarkup(name: string): Promise<string> {
  const svg = icon(fileIcon(name));
  svg.style.position = "fixed";
  svg.style.left = "-10000px";
  document.body.append(svg);
  // A theme's picture may still be on its way (its URL resolves asynchronously).
  for (let i = 0; i < 20 && svg.querySelector("image:not([href])"); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const color = getComputedStyle(svg).color;
  // Font-glyph themes: the page can't load the theme's font, so the glyph is drawn here.
  const glyph = svg.querySelector("text");
  if (glyph?.textContent) {
    const style = getComputedStyle(glyph);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = style.fill && style.fill !== "none" ? style.fill : color;
      ctx.font = `28px ${style.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph.textContent, 16, 17);
      svg.remove();
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><image width="16" height="16" href="${canvas.toDataURL("image/png")}"/></svg>`;
    }
  }
  const out = svg.cloneNode(true) as SVGSVGElement;
  svg.remove();
  // A sprite reference (`<use href="#i-…">`) is replaced by the symbol's own drawing.
  const use = out.querySelector("use");
  const ref = use?.getAttribute("href");
  if (use && ref?.startsWith("#")) {
    const symbol = document.getElementById(ref.slice(1));
    if (symbol) {
      out.setAttribute("viewBox", symbol.getAttribute("viewBox") ?? "0 0 24 24");
      out.setAttribute("fill", "none");
      out.setAttribute("stroke", "currentColor");
      out.setAttribute("stroke-width", "2");
      out.setAttribute("stroke-linecap", "round");
      out.setAttribute("stroke-linejoin", "round");
      use.replaceWith(...Array.from(symbol.childNodes).map((c) => c.cloneNode(true)));
    }
  }
  out.removeAttribute("class");
  out.removeAttribute("data-themed-icon");
  out.style.cssText = SAFE_COLOR.test(color) ? `color:${color}` : "";
  out.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // Image-based themes draw with <image href="…">: the picture goes in as data.
  for (const image of Array.from(out.querySelectorAll("image"))) {
    const href = image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
    const data = href ? await inlineImage(href) : null;
    if (data) image.setAttribute("href", data);
    else image.remove();
  }
  // Nothing that runs or loads: scripts, event handlers, outside links.
  for (const el of Array.from(out.querySelectorAll("*"))) {
    if (el.tagName.toLowerCase() === "script" || el.tagName.toLowerCase() === "foreignobject") {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes))
      if (
        attr.name.startsWith("on") ||
        (/href$/i.test(attr.name) && !/^(#|data:image\/)/i.test(attr.value))
      )
        el.removeAttribute(attr.name);
  }
  return out.outerHTML;
}

export function registerRenderFile(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.dispatcher.register({
      id: "editor.renderFile",
      title: "Render a file for a page",
      category: "Editor",
      description:
        "A project file's first lines colored as the editor colors them, and its icon from the file icon theme, as self-contained markup (spans with inline colors, an SVG) for extension pages such as the canvas. `iconOnly` skips the text. Returns { icon, html?, language, lines, totalLines, binary? }.",
      input: s.object({
        path: s.string().describe("A file in the open folder"),
        maxLines: s.integer({ min: 1, max: 400 }).optional(),
        iconOnly: s.boolean().optional(),
      }),
      effects: ["read"],
      palette: false,
      run: async ({ path, maxLines, iconOnly }) => {
        const { workspace } = services;
        if (!workspace.root.peek()) throw new Error("No folder is open.");
        const full = workspace.resolve(path);
        // Pages only see the project's own files (any of the workspace's folders, D251).
        if (!workspace.contains(full))
          throw new Error(
            workspace.isMultiRoot()
              ? `${path} is outside the workspace's folders.`
              : `${path} is outside the open folder.`,
          );
        const language = languageForPath(full);
        const iconSvg = await iconMarkup(basename(full));
        if (iconOnly) return { icon: iconSvg, language };
        const stat = await fsIpc.stat(full);
        if (stat.size > MAX_BYTES) return { icon: iconSvg, language, tooLarge: true };
        const text =
          services.documents.text(full) ?? new TextDecoder().decode(await fsIpc.read(full));
        if (text.slice(0, 8000).includes("\u0000"))
          return { icon: iconSvg, language, binary: true };
        const all = text.split(/\r?\n/);
        // Capped per line and in all: a minified file's one huge line would stall the colorizer.
        let budget = MAX_SHOWN;
        const shown = all
          .slice(0, maxLines ?? 80)
          .map((l) => {
            const cut = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l;
            const kept = cut.slice(0, Math.max(0, budget));
            budget -= kept.length + 1;
            return kept;
          })
          .join("\n");
        const colored = await services.documents.highlight(shown, language).catch(() => null);
        return {
          icon: iconSvg,
          language,
          html: colored ? inlineColors(colored) : escapeHtml(shown),
          lines: Math.min(all.length, maxLines ?? 80),
          totalLines: all.length,
        };
      },
    }),
  );
}
