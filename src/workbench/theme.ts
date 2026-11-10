// UI theme state: theme (dark/light), density, panel style and motion, applied as attributes on
// <html> (DESIGN.md §2). Also resolves token values to concrete colors for Monaco and the terminal,
// and applies imported-theme overrides (DESIGN.md §19).
import { Emitter } from "../core/events/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { effect, type Signal, signal } from "../core/reactive/index";
import { parseCssColor, type Rgba } from "../core/themes/color";
import { contrast, readableOnAccent, readableTextOn } from "../core/themes/importer";

export type ThemeKind = "dark" | "light";
export type Density = "compact" | "default" | "comfortable";
export type PanelStyle = "floating" | "flush";
/** The side bar's color (D275): the panels' (matching) or the theme's side bar color (distinct). */
export type SideBarColor = "matching" | "distinct";
/** The dock's tab look (D278): rounded (the default), classic (square, accent on top) or
 *  connected (the active tab joins the editor under a strip of its own color). */
export type TabStyle = "rounded" | "classic" | "connected";

export const THEMES: readonly ThemeKind[] = ["dark", "light"];
export const DENSITIES: readonly Density[] = ["compact", "default", "comfortable"];
export const PANEL_STYLES: readonly PanelStyle[] = ["flush", "floating"];
export const SIDE_BAR_COLORS: readonly SideBarColor[] = ["matching", "distinct"];
export const TAB_STYLES: readonly TabStyle[] = ["rounded", "classic", "connected"];

export interface UiPreferences {
  theme: ThemeKind;
  density: Density;
  panels: PanelStyle;
  sideBar: SideBarColor;
  tabs: TabStyle;
}

export class ThemeService implements Disposable {
  readonly theme: Signal<ThemeKind> = signal<ThemeKind>("dark");
  readonly density: Signal<Density> = signal<Density>("default");
  readonly panels: Signal<PanelStyle> = signal<PanelStyle>("flush");
  readonly sideBar: Signal<SideBarColor> = signal<SideBarColor>("matching");
  readonly tabs: Signal<TabStyle> = signal<TabStyle>("rounded");
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  /** Fires after the new theme's styles are in effect (Monaco/terminal re-read colors). */
  readonly onDidChange = this.changed.event;
  private repaint = 0;
  private readonly probe: HTMLElement;
  private overrides: Record<string, string> = {};

  constructor(private readonly root: HTMLElement = document.documentElement) {
    // Scrollbars (::-webkit-scrollbar) don't repaint when only a variable changed: flip a class
    // for a frame after each change.
    // Whatever set the colors (a theme of any format, colorCustomizations, the built-ins), text on
    // the accent stays readable: checked on the colors as the browser resolved them (D191).
    this.store.add(this.changed.event(() => this.ensureAccentText()));
    this.store.add(
      this.changed.event(() => {
        if (this.repaint) return;
        this.root.classList.add("is-retheming");
        this.repaint = requestAnimationFrame(() => {
          this.repaint = 0;
          this.root.classList.remove("is-retheming");
        });
      }),
    );
    this.probe = document.createElement("span");
    this.probe.hidden = true;
    this.probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.probe);
    // The first check has no theme change around it: one is announced when it changed the color,
    // so what copied the tokens (the terminal, extension pages) reads them again.
    const firstCheck = requestAnimationFrame(() => {
      const before = this.root.style.getPropertyValue("--fg-on-accent");
      this.ensureAccentText();
      if (this.root.style.getPropertyValue("--fg-on-accent") !== before) this.changed.fire();
    });
    this.store.add(toDisposable(() => cancelAnimationFrame(firstCheck)));
    this.store.add(toDisposable(() => this.probe.remove()));
    let first = true;
    this.store.add(
      effect(() => {
        this.root.dataset.theme = this.theme.value;
        this.root.dataset.density = this.density.value;
        this.root.dataset.panels = this.panels.value;
        this.root.dataset.sidebarColor = this.sideBar.value;
        this.root.dataset.tabStyle = this.tabs.value;
        if (first) {
          first = false;
          return undefined;
        }
        // Computed styles update synchronously, but let layout settle before consumers read sizes.
        requestAnimationFrame(() => this.changed.fire());
        return undefined;
      }),
    );
  }

  private forcedOnAccent = false;

  private ensureAccentText(): void {
    if (this.forcedOnAccent) {
      this.forcedOnAccent = false;
      const own = this.overrides["--fg-on-accent"];
      if (own) this.root.style.setProperty("--fg-on-accent", own);
      else this.root.style.removeProperty("--fg-on-accent");
    }
    const accent = this.color("--accent");
    const text = this.color("--fg-on-accent");
    if (!accent || !text || accent.a < 0.5 || contrast(text, accent) >= 3) return;
    this.root.style.setProperty("--fg-on-accent", readableTextOn(accent));
    this.forcedOnAccent = true;
  }

  get preferences(): UiPreferences {
    return {
      theme: this.theme.peek(),
      density: this.density.peek(),
      panels: this.panels.peek(),
      sideBar: this.sideBar.peek(),
      tabs: this.tabs.peek(),
    };
  }

  apply(prefs: Partial<UiPreferences>): void {
    if (prefs.theme && THEMES.includes(prefs.theme)) this.theme.value = prefs.theme;
    if (prefs.density && DENSITIES.includes(prefs.density)) this.density.value = prefs.density;
    if (prefs.panels && PANEL_STYLES.includes(prefs.panels)) this.panels.value = prefs.panels;
    if (prefs.sideBar && SIDE_BAR_COLORS.includes(prefs.sideBar))
      this.sideBar.value = prefs.sideBar;
    if (prefs.tabs && TAB_STYLES.includes(prefs.tabs)) this.tabs.value = prefs.tabs;
  }

  /** Raw value of a custom property (e.g. "--syntax-theme"). */
  token(name: string): string {
    return getComputedStyle(this.root).getPropertyValue(name).trim();
  }

  /** A color token resolved to RGBA (handles var() chains and color-mix()). */
  color(name: string): Rgba | null {
    this.probe.style.color = `var(${name})`;
    return parseCssColor(getComputedStyle(this.probe).color);
  }

  /** The syntax colors of an extension's color theme (VS Code JSON), or null for the built-ins. */
  syntaxTheme: { name: string; json: unknown } | null = null;

  setSyntaxTheme(theme: { name: string; json: unknown } | null): void {
    if (this.syntaxTheme?.name === theme?.name) return;
    this.syntaxTheme = theme;
    requestAnimationFrame(() => this.changed.fire());
  }

  /** Applies imported-theme token overrides (replacing previous ones). */
  setOverrides(tokens: Record<string, string>): void {
    if (JSON.stringify(tokens) === JSON.stringify(this.overrides)) return;
    for (const name of Object.keys(this.overrides)) this.root.style.removeProperty(name);
    this.overrides = { ...tokens, ...readableOnAccent(tokens) };
    for (const [name, value] of Object.entries(this.overrides))
      this.root.style.setProperty(name, value);
    requestAnimationFrame(() => this.changed.fire());
  }

  dispose(): void {
    this.store.dispose();
  }
}
