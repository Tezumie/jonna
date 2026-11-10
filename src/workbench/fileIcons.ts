// The active file icon theme (D132): resolves themed icon names ("fi:file:App.tsx") through a VS
// Code icon theme and draws them as 16 px SVGs — an <image> for SVG/PNG icons, a <text> glyph for
// icon fonts (FontFace) — or as the IDE's own minimal glyphs. Images are loaded once per icon
// definition and shared; icons already on screen are swapped when the theme changes.
import { type IconDefinition, IconTheme } from "../core/iconTheme/index";
import type { Disposable } from "../core/lifecycle/index";
import {
  icon,
  minimalThemedIcon,
  setThemedIconRenderer,
  type ThemedIconKind,
  type ThemedIconName,
} from "../ui/Icon";
import type { IconThemeEntry, LoadedIconTheme } from "./contributions";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Active {
  id: string;
  theme: IconTheme;
  loaded: LoadedIconTheme;
  /** Definition id → URL (resolved) or the pending load. */
  urls: Map<string, string | Promise<string>>;
  fonts: Map<string, string>;
}

export class FileIconThemes implements Disposable {
  private active: Active | null = null;
  private light = false;
  private loading = 0;
  private readonly documents = new Set<Document>([document]);
  /** The file's language for themes that map language ids (set by the editor extension). */
  languageOf: (name: string) => string | undefined = () => undefined;

  /** Activates `entry` (null: the IDE's minimal icons). Resolves when its JSON is loaded. */
  async apply(entry: IconThemeEntry | null, light: boolean): Promise<void> {
    const token = ++this.loading;
    this.light = light;
    let next: Active | null = null;
    if (entry) {
      const loaded = await entry.load();
      if (token !== this.loading) return;
      if (loaded)
        next =
          this.active?.id === entry.id
            ? this.active
            : {
                id: entry.id,
                theme: new IconTheme(loaded.doc),
                loaded,
                urls: new Map(),
                fonts: new Map(),
              };
    }
    this.active = next;
    if (next) await this.loadFonts(next);
    setThemedIconRenderer(next ? (kind, name) => this.render(next, kind, name) : null, {
      minimal: !next,
      hidesExplorerArrows: next?.theme.hidesExplorerArrows ?? false,
    });
    this.refreshOnScreen();
  }

  /** Light / dark changed (themes may have light variants). */
  setLight(light: boolean): void {
    if (light === this.light) return;
    this.light = light;
    this.refreshOnScreen();
  }

  /** Auxiliary windows get their icons swapped too. */
  addDocument(doc: Document): Disposable {
    this.documents.add(doc);
    return { dispose: () => this.documents.delete(doc) };
  }

  private render(active: Active, kind: ThemedIconKind, name: string): SVGSVGElement {
    const languageId = kind === "file" ? this.languageOf(name) : undefined;
    const id = active.theme.resolve({
      name,
      kind: kind === "file" ? "file" : "folder",
      expanded: kind.endsWith("open"),
      root: kind.startsWith("root"),
      light: this.light,
      ...(languageId && { languageId }),
    });
    const def = id ? active.theme.definition(id) : undefined;
    if (!id || !def) return minimalThemedIcon(kind, name);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon icon-themed");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    if (def.fontCharacter) svg.appendChild(this.glyph(active, def));
    else if (def.iconPath) {
      const image = document.createElementNS(SVG_NS, "image");
      image.setAttribute("width", "16");
      image.setAttribute("height", "16");
      svg.appendChild(image);
      const url = this.url(active, id, def.iconPath);
      if (typeof url === "string") image.setAttribute("href", url);
      else void url.then((u) => image.setAttribute("href", u)).catch(() => {});
    }
    return svg;
  }

  private url(active: Active, id: string, path: string): string | Promise<string> {
    const known = active.urls.get(id);
    if (known !== undefined) return known;
    const pending = active.loaded.url(path).then((u) => {
      active.urls.set(id, u);
      return u;
    });
    active.urls.set(id, pending);
    return pending;
  }

  /** An icon font glyph (Seti-style themes): the character in the theme's font, centered. */
  private glyph(active: Active, def: IconDefinition): SVGTextElement {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "8");
    text.setAttribute("y", "8");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    const family = active.fonts.get(def.fontId ?? active.theme.doc.fonts?.[0]?.id ?? "");
    if (family) text.style.fontFamily = `"${family}"`;
    text.style.fontSize = def.fontSize ?? "14px";
    text.style.fill = def.fontColor ?? "currentColor";
    text.textContent = def.fontCharacter?.startsWith("\\")
      ? String.fromCodePoint(Number.parseInt(def.fontCharacter.slice(1), 16))
      : (def.fontCharacter ?? "");
    return text;
  }

  private async loadFonts(active: Active): Promise<void> {
    for (const font of active.theme.doc.fonts ?? []) {
      if (active.fonts.has(font.id)) continue;
      const src = font.src[0];
      if (!src) continue;
      try {
        const url = await active.loaded.url(src.path);
        const family = `icon-theme-${active.id}-${font.id}`.replace(/[^\w-]/g, "-");
        const face = new FontFace(family, `url(${url})`, {
          ...(font.weight && { weight: font.weight }),
          ...(font.style && { style: font.style }),
        });
        await face.load();
        for (const doc of this.documents) doc.fonts.add(face);
        active.fonts.set(font.id, family);
      } catch {
        // A font that can't load: its icons fall back to the minimal glyphs' size, empty.
      }
    }
  }

  /** Swaps every themed icon on screen for the current theme's. */
  private refreshOnScreen(): void {
    for (const doc of this.documents)
      for (const old of doc.querySelectorAll<SVGSVGElement>("svg[data-themed-icon]")) {
        const name = old.dataset.themedIcon as ThemedIconName | undefined;
        if (!name) continue;
        const next = icon(name);
        // Classes the caller added (e.g. "explorer-file-icon") stay.
        const own = new Set([
          "icon",
          "icon-themed",
          ...[...old.classList].filter((c) => c.startsWith("icon-")),
        ]);
        next.classList.add(...[...old.classList].filter((c) => !own.has(c)));
        old.replaceWith(next);
      }
  }

  dispose(): void {
    setThemedIconRenderer(null, { minimal: true, hidesExplorerArrows: false });
  }
}
