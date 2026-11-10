// The active product icon theme (D267): VS Code's product icon themes redraw the workbench's
// icons with a font. Each of the IDE's icons that has a codicon counterpart the theme defines
// (core/iconTheme/productIcons.ts) is drawn as that glyph, the rest stay the IDE's. Icons on
// screen are swapped when the theme changes.
import {
  glyphText,
  type ProductIconDefinition,
  type ProductIconThemeDocument,
  productGlyph,
} from "../core/iconTheme/productIcons";
import type { Disposable } from "../core/lifecycle/index";
import { type IconName, icon, setProductIconRenderer } from "../ui/Icon";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A product icon theme: its JSON, and a URL for one of its files (its fonts). */
export interface LoadedProductIconTheme {
  doc: ProductIconThemeDocument;
  url(path: string): Promise<string>;
}

export interface ProductIconThemeEntry {
  /** What `workbench.productIconTheme` stores (VS Code's ids). */
  id: string;
  label: string;
  source: string;
  load(): Promise<LoadedProductIconTheme>;
}

export class ProductIconThemes implements Disposable {
  private loading = 0;
  private activeId: string | null = null;
  private readonly documents = new Set<Document>([document]);

  /** Activates `entry` (null: the IDE's own icons). Resolves once its fonts are loaded. */
  async apply(entry: ProductIconThemeEntry | null): Promise<void> {
    const token = ++this.loading;
    if (!entry) {
      if (this.activeId === null) return;
      this.activeId = null;
      setProductIconRenderer(null);
      this.refreshOnScreen();
      return;
    }
    if (entry.id === this.activeId) return;
    const loaded = await entry.load();
    const fonts = new Map<string, string>();
    for (const font of loaded.doc.fonts) {
      const src = font.src[0];
      if (!src) continue;
      try {
        const url = await loaded.url(src.path);
        const family = `product-icons-${entry.id}-${font.id}`.replace(/[^\w-]/g, "-");
        const face = new FontFace(family, `url(${url})`, {
          ...(font.weight && { weight: font.weight }),
          ...(font.style && { style: font.style }),
        });
        await face.load();
        for (const doc of this.documents) doc.fonts.add(face);
        fonts.set(font.id, family);
      } catch {
        // A font that can't load: its glyphs stay the IDE's icons.
      }
    }
    if (token !== this.loading) return;
    const first = loaded.doc.fonts[0]?.id ?? "";
    this.activeId = entry.id;
    setProductIconRenderer((name) => {
      const def = productGlyph(loaded.doc, name);
      const family = def && fonts.get(def.fontId ?? first);
      return def && family ? glyph(def, family) : null;
    });
    this.refreshOnScreen();
  }

  /** Auxiliary windows get the fonts and the swap too. */
  addDocument(doc: Document): Disposable {
    this.documents.add(doc);
    return { dispose: () => this.documents.delete(doc) };
  }

  /** Swaps every icon on screen for the current theme's (or the IDE's). */
  private refreshOnScreen(): void {
    for (const doc of this.documents)
      for (const old of doc.querySelectorAll<SVGSVGElement>("svg[data-icon]")) {
        const name = old.dataset.icon as IconName | undefined;
        if (!name) continue;
        const next = icon(name);
        // Classes the caller added (e.g. "tab-icon") stay.
        next.classList.add(
          ...[...old.classList].filter((c) => c !== "icon-glyph" && !c.startsWith("icon-")),
        );
        for (const a of ["role", "aria-label", "style"]) {
          const v = old.getAttribute(a);
          if (v !== null) next.setAttribute(a, v);
        }
        old.replaceWith(next);
      }
  }

  dispose(): void {
    setProductIconRenderer(null);
  }
}

/** A glyph in the theme's font, centred in the IDE's 16 px icon box. */
function glyph(def: ProductIconDefinition, family: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon icon-glyph");
  svg.setAttribute("viewBox", "0 0 16 16");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "8");
  text.setAttribute("y", "8");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.style.fontFamily = `"${family}"`;
  text.style.fontSize = "16px";
  text.style.fill = "currentColor";
  text.style.stroke = "none";
  text.textContent = glyphText(def.fontCharacter);
  svg.appendChild(text);
  return svg;
}
