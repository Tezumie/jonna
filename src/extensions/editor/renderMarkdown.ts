// Markdown as the IDE's preview draws it, for extension pages (D187): `editor.renderMarkdown`
// returns self-contained HTML (code colored with inline styles, workspace images as data: URLs,
// nothing that runs) and the preview's own stylesheet with the theme's values filled in, scoped
// to `.ide-md`. So an extension's page (the canvas's note cards) reads like the Markdown preview
// and follows the user's theme, without loading the IDE's files.
import { fsIpc } from "../../core/ipc/fs";
import { remoteImages } from "../../core/ipc/remoteImage";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, resolveInRoot } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { markdownNodes } from "../../ui/markdown/render";
import type { WorkbenchServices } from "../../workbench/services";
import { mimeFor } from "../viewers/image";
import { inlineColors } from "./renderFile";

const MAX_SOURCE = 512 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_IMAGES = 24;
/** Only pictures are read for `![](…)` (a page mustn't get other files as data). */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** Rules of the IDE's stylesheets that style rendered Markdown. */
const MD_SELECTOR = /\.md(?:-[\w-]+)?(?![\w-])/;

function collectRules(list: CSSRuleList, out: string[]): void {
  for (const rule of Array.from(list)) {
    if (rule instanceof CSSStyleRule) {
      if (MD_SELECTOR.test(rule.selectorText)) out.push(rule.cssText);
    } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
      // Layers and @media/@supports: their style rules count (media queries are dropped: a
      // card is narrow anyway).
      collectRules((rule as CSSGroupingRule).cssRules, out);
    }
  }
}

let cssCache: { key: string; css: string } | null = null;

/** The preview's styles with each `var(--token)` it uses resolved to the current theme's value. */
export function markdownCss(): string {
  const root = getComputedStyle(document.documentElement);
  const key = `${document.documentElement.className}|${root.getPropertyValue("--bg-app")}|${root.getPropertyValue("--accent")}`;
  if (cssCache?.key === key) return cssCache.css;
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectRules(sheet.cssRules, rules);
    } catch {
      // A sheet from elsewhere can't be read; the IDE's own can.
    }
  }
  const text = rules.join("\n");
  const vars = new Set(text.match(/--[\w-]+/g) ?? []);
  // Tokens refer to other tokens: resolved values are final.
  const values = [...vars]
    .map((v) => [v, root.getPropertyValue(v).trim()] as const)
    .filter(([, value]) => value && !/[<>{}]/.test(value))
    .map(([v, value]) => `${v}: ${value};`)
    .join(" ");
  const css = `.ide-md { ${values} }\n${text}`;
  cssCache = { key, css };
  return css;
}

/** Strips what a page mustn't get: scripts, handlers, outside links in src, IDE-only buttons. */
function clean(host: HTMLElement): void {
  for (const el of Array.from(host.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (["script", "iframe", "object", "embed", "style", "link", "form"].includes(tag)) {
      el.remove();
      continue;
    }
    // The copy buttons draw IDE icons a page doesn't have.
    if (el.classList.contains("md-copy")) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (
        (name === "href" || name === "src" || name.endsWith(":href")) &&
        /^\s*(javascript|vbscript|data:text)/i.test(attr.value)
      )
        el.removeAttribute(attr.name);
    }
  }
}

export function registerRenderMarkdown(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.dispatcher.register({
      id: "editor.renderMarkdown",
      title: "Render Markdown for a page",
      category: "Editor",
      description:
        "Markdown rendered as the IDE's preview renders it, for extension pages: { html, css }. `html` is self-contained (code colored inline, the open folder's images as data: URLs; nothing that runs), to put inside an element with the classes `md md-document ide-md`; `css` is the preview's stylesheet for the current theme. Input: `text`, or `path` (a .md file in the open folder); `base`: the folder relative links and images are read from (default: the file's).",
      input: s.object({
        text: s.string().optional(),
        path: s.string().describe("A Markdown file in the open folder").optional(),
        base: s.string().describe("Folder for relative images (default: the file's)").optional(),
        css: s.boolean().describe("Also return the stylesheet (default true)").optional(),
      }),
      effects: ["read"],
      palette: false,
      run: async ({ text, path, base, css }) => {
        const { workspace } = services;
        const root = workspace.root.peek();
        let source = text;
        let dir = root ?? "";
        if (path !== undefined) {
          if (!root) throw new Error("No folder is open.");
          // Any of the workspace's folders (D251).
          const full = workspace.resolve(path);
          if (!workspace.contains(full))
            throw new Error(
              workspace.isMultiRoot()
                ? `${path} is outside the workspace's folders.`
                : `${path} is outside the open folder.`,
            );
          if (!/\.(md|markdown|mdx|txt)$/i.test(full))
            throw new Error(`${path} isn't a Markdown file.`);
          source =
            services.documents.text(full) ?? new TextDecoder().decode(await fsIpc.read(full));
          dir = dirname(full);
        }
        if (base !== undefined && root) {
          const b = workspace.resolve(base);
          if (workspace.contains(b)) dir = b;
        }
        if (source === undefined) throw new Error("Give `text` or `path`.");
        if (source.length > MAX_SOURCE)
          source = `${source.slice(0, MAX_SOURCE)}\n\n*(cut at ${MAX_SOURCE / 1024} KB)*`;
        const pending: Promise<unknown>[] = [];
        let images = 0;
        /** data: URL → the path the Markdown gave, kept as `data-src` (dragging it out, D187). */
        const sources = new Map<string, string>();
        const host = document.createElement("div");
        host.append(
          ...markdownNodes(source, {
            headingShift: 0,
            softBreaks: "space",
            visuals: false,
            openLink: () => {},
            copy: () => {},
            image: (src) => {
              if (/^https:\/\//i.test(src)) {
                if (services.settings.peek<boolean>("markdown.preview.remoteImages") === false)
                  return null;
                if (images >= MAX_IMAGES) return null;
                images++;
                // Fetched by the backend into a data: URL (no page may load remote images, D210).
                const remote = remoteImages.dataUrl(src).then((url) => {
                  if (url) sources.set(url, src);
                  return url;
                });
                pending.push(remote);
                return remote;
              }
              if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !root || images >= MAX_IMAGES) return null;
              let rel = src.split(/[?#]/)[0] ?? src;
              try {
                rel = decodeURI(rel);
              } catch {
                // as written
              }
              const file = resolveInRoot(dir, rel);
              if (!workspace.contains(file) || !IMAGE_FILE.test(file)) return null;
              images++;
              const load = fsIpc
                .stat(file)
                .then((st) => (st.size > MAX_IMAGE ? null : fsIpc.read(file)))
                .then((bytes) => {
                  if (!bytes) return null;
                  let binary = "";
                  for (let i = 0; i < bytes.length; i += 0x8000)
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                  const url = `data:${mimeFor(file)};base64,${btoa(binary)}`;
                  sources.set(url, src);
                  return url;
                })
                .catch(() => null);
              pending.push(load);
              return load;
            },
            highlight: (code, lang) => {
              if (!lang) return null;
              const colored = services.documents
                .highlight(code, lang)
                .then((html) => {
                  if (!html) return null;
                  const t = document.createElement("template");
                  t.innerHTML = inlineColors(html);
                  return Array.from(t.content.childNodes);
                })
                .catch(() => null);
              pending.push(colored);
              return colored;
            },
          }),
        );
        await Promise.allSettled(pending);
        // The renderer's own callbacks on those promises have run: settle one more turn.
        await new Promise((resolve) => setTimeout(resolve, 0));
        clean(host);
        for (const img of Array.from(host.querySelectorAll("img"))) {
          const src = img.getAttribute("src") ?? "";
          const original = sources.get(src);
          if (original) img.dataset.src = original;
        }
        return { html: host.innerHTML, ...(css !== false && { css: markdownCss() }) };
      },
    }),
  );
}
