# Design System

> The visual language of the IDE: tokens, typography, motion, components, the agent UI, the editor and terminal.
> **Audience:** core contributors *and* extension authors. If you build anything that shows up in the IDE, this is the contract.
> **Source of truth in code:** `src/styles/tokens.css` (Appendix A is its reference implementation). If this doc and the CSS disagree, fix one of them in the same change.
> The product is unnamed: never put a product name in UI copy, assets or class names.
> **Version 2** — neutral palette, flush panels by default, accent used sparingly (see Changelog at the end).

---

## 1. Direction

**Quiet tool, sharp focus.** The interface recedes so code and conversation are the brightest things on screen. It should feel closer to a precision instrument than a dashboard: flat surfaces, exact alignment, few colors, and motion that only ever explains a change.

Principles:
1. **Content is the brightest thing.** Chrome uses muted text and low-contrast surfaces. Code, chat text and the thing you're working on get full contrast.
2. **The active pane is lit; the rest dims.** Exactly one pane group has focus. Its active tab text is at full strength; inactive groups drop their chrome text to muted. Focus is shown with surface steps and text weight, not colored bars.
3. **One shell, flat and neutral.** The title bar, sidebar, explorer, editor, terminal, agent and status bar share one neutral shell color, separated by hairline borders. Grays are true neutrals (no blue tint). Hierarchy inside panels comes from one surface step up (`--bg-surface-raised`). Shadows only for things that float.
4. **Labels appear when needed.** Icons stand alone at rest; labels, secondary actions and details reveal on hover, focus or expansion with short width/height tweens.
5. **Color is rare and means something.** The accent appears only for keyboard focus rings, the focused selection in lists/trees, editor selection, links, progress, and the agent's Accept buttons. No accent bars, underlines or tinted chrome. Green/amber/red = status only.
6. **No glow, no gradient** — except the two sanctioned uses in §8.6 (loading shimmer, streaming "thinking" text).
7. **Every surface works at every density** and in both themes, keyboard first.

---

## 2. Token architecture

Three layers. Only the middle one is public.

| Layer | Example | Who uses it |
|---|---|---|
| **Primitive** (private) | `--gray-950`, `--blue-600` | Only `tokens.css` and theme files. Never in components or extensions. |
| **Semantic** (public API) | `--bg-surface`, `--fg-muted`, `--border-subtle`, `--accent` | Everything: core UI, built-in extensions, third-party extensions. |
| **Component** (optional, derived) | `--tab-bg-active`, `--row-height` | Defined next to a component, always derived from semantic tokens. Themes may override them. |

**Naming rule:** `--{group}-{role}[-{variant}][-{state}]`, lowercase, hyphenated, full words.
- Groups: `bg`, `fg`, `border`, `accent`, `status`, `diff`, `space`, `size`, `radius`, `shadow`, `font`, `text`, `motion`, `z`.
- Roles describe *purpose*, never *appearance*: `--fg-muted`, not `--gray-text`; `--status-danger`, not `--red`.
- States are suffixes: `-hover`, `-active`, `-selected`, `-disabled`.

Themes set attributes on `<html>`: `data-theme="dark|light"`, `data-density="compact|default|comfortable"`, `data-panels="flush|floating"` (**flush is the default**), `data-motion="full|reduced"`.

---

## 3. Color

### 3.1 Surfaces and text

Neutral grays only (equal R, G and B). In the default **flush** layout, `--bg-app` and `--bg-surface` are the same color, so the whole window reads as one shell.

| Token | Use | Dark | Light |
|---|---|---|---|
| `--bg-app` | Window, title bar, activity bar, status bar (and gaps in `floating`) | `#181818` (`#111111` in floating) | `#F7F7F7` (`#EDEDED` in floating) |
| `--bg-surface` | Panels: explorer, editor, terminal, agent, settings | `#181818` | `#F7F7F7` |
| `--bg-surface-sunken` | Wells: inputs, code blocks, title-bar command field | `#141414` | `#F0F0F0` |
| `--bg-surface-raised` | One step up: active tab, active activity-bar button, hovered cards, user chat messages, selected segmented control | `#232323` | `#EBEBEB` |
| `--bg-overlay` | Floating: menus, quick input, tooltips, dialogs, Monaco widgets | `#262626` | `#FFFFFF` |
| `--bg-scrim` | Behind modal dialogs | `rgb(0 0 0 / 0.5)` | `rgb(0 0 0 / 0.2)` |

| Token | Use | Dark | Light | Contrast on shell / raised / overlay |
|---|---|---|---|---|
| `--fg-default` | Primary text, code, active labels | `#E6E6E6` | `#1F1F1F` | dark 14.2 / 12.6 / 12.1 · light 15.4 / 13.8 / 16.5 |
| `--fg-muted` | Secondary text, inactive tabs, chrome labels, icons at rest | `#A6A6A6` | `#575757` | dark 7.3 / 6.5 / 6.2 · light 6.8 / 6.1 / 7.2 |
| `--fg-subtle` | Hints, placeholders, timestamps | `#8C8C8C` | `#686868` | dark 5.3 / 4.7 / 4.5 · light 5.2 / 4.7 / 5.6 |
| `--fg-disabled` | Disabled text, line numbers (decorative) | `#5C5C5C` | `#A8A8A8` | — |
| `--fg-on-accent` | Text/icons on accent fills | `#FFFFFF` | `#FFFFFF` | 4.9 on `--accent` |

All text tokens meet WCAG AA (≥ 4.5:1) on shell, raised and overlay surfaces in both themes.

### 3.2 Borders and interaction overlays
Interaction states are translucent overlays so they work on any surface.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--border-subtle` | `rgb(255 255 255 / 0.06)` | `rgb(0 0 0 / 0.07)` | Hairlines between panels (flush), dividers inside panels |
| `--border-default` | `rgb(255 255 255 / 0.09)` | `rgb(0 0 0 / 0.10)` | Inputs, cards, panel edge in `flush` mode |
| `--border-strong` | `rgb(255 255 255 / 0.16)` | `rgb(0 0 0 / 0.18)` | Hovered inputs, emphasis |
| `--bg-hover` | `rgb(255 255 255 / 0.05)` | `rgb(0 0 0 / 0.04)` | Hover on rows, ghost buttons, tabs |
| `--bg-active` | `rgb(255 255 255 / 0.08)` | `rgb(0 0 0 / 0.07)` | Pressed |
| `--bg-selected` | `rgb(255 255 255 / 0.08)` | `rgb(0 0 0 / 0.06)` | Selected row when its list/tree is **not** focused (inactive selection) |
| `--bg-selected-focus` | `--accent` at 28% | `--accent` at 16% | Selected row when its list/tree **has** focus (active selection) |

### 3.3 Accent
One restrained blue, used **only** for: keyboard focus rings, the active selection in a focused list/tree, editor text selection, links, progress, and the agent's "Accept" buttons (Send is a quiet icon button since D385). It never appears on tabs, the activity bar, the title bar, borders or the caret.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--accent` | `#2B6FD1` | `#2B6FD1` | Fills and rings (white text on it: 4.9:1; ring vs shell: 3.6 / 4.6) |
| `--accent-hover` | from `--accent` | from `--accent` | Hovered accent fills: a light accent a step darker, a dark one a step lighter (D276) |
| `--accent-secondary` | = `--accent` | = `--accent` | The second accent (D276): focus and selection in lists and trees, resize handles, drop targets, info notes. A theme may set its own (Claude Dark: `#2C84DB`) |
| `--accent-secondary-subtle` / `-border` | at 16% / 50% | at 10% / 40% | Drop-target fills and outlines |
| `--accent-text` | `--accent-secondary` + 38% white | `--accent-secondary` + 18% black | Accent-colored **text** and icons (links, info) |
| `--accent-subtle` | `--accent` at 16% | `--accent` at 10% | Toggled-on icon buttons |
| `--accent-border` | `--accent` at 50% | `--accent` at 40% | Drag ring |
| `--focus-ring` | `--accent` | `--accent` | Keyboard focus (buttons, rows, cards; lists use `--accent-secondary`) |
| `--border-input-focus` | `--fg-default` 35% | `--fg-default` 35% | A focused text field's border: a step brighter (darker on light themes), quieter than the accent (D385) |

Users may override `--accent` alone; the derived tokens follow via `color-mix()` (Appendix A).

### 3.4 Status
Each status has a foreground (text/icons), a subtle background and a border.

| Status | `-fg` dark / light | `-bg` | `-border` |
|---|---|---|---|
| `--status-success` | `#4CC38A` / `#18794A` | 12% of fg | 35% of fg |
| `--status-warning` | `#E8AE4C` / `#8A5800` | 12% | 35% |
| `--status-danger` | `#F27474` / `#BE3333` | 12% | 35% |
| `--status-info` | = `--accent-text` | 12% | 35% |

### 3.5 Diff and version control
| Token | Dark | Light | Use |
|---|---|---|---|
| `--diff-added-bg` | `rgb(76 195 138 / 0.12)` | `rgb(24 121 74 / 0.10)` | Added line background |
| `--diff-added-bg-strong` | `rgb(76 195 138 / 0.28)` | `rgb(24 121 74 / 0.22)` | Added characters (inline) |
| `--diff-removed-bg` | `rgb(242 116 116 / 0.12)` | `rgb(190 51 51 / 0.09)` | Removed line |
| `--diff-removed-bg-strong` | `rgb(242 116 116 / 0.28)` | `rgb(190 51 51 / 0.20)` | Removed characters |
| `--diff-added-fg` / `--diff-removed-fg` / `--diff-modified-fg` | success / danger / `#5B9BD5` (dark) `#2F6EB5` (light) | same | Gutter bars, file badges (A, D, M), +/− counts |

Git file states in trees: modified = `--diff-modified-fg`, added/untracked = `--diff-added-fg`, deleted = `--diff-removed-fg` (+ strikethrough), conflict = `--status-warning-fg`, ignored = `--fg-subtle`.

---

## 4. Typography

**UI:** the platform's own UI face, at zero bundle cost and native rendering:
`--font-ui: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, Ubuntu, "Noto Sans", sans-serif;`

**Code:** user-configurable; the default is VS Code's for each OS (D382), set by `<html data-platform>`:
Windows `Consolas, "Courier New", monospace`; macOS `Menlo, Monaco, "Courier New", monospace`;
Linux `"Droid Sans Mono", "monospace", monospace`.
Code ligatures off by default. `font-variant-numeric: tabular-nums` on all numbers in chrome (line/col, counts, timings).

### 4.1 Type scale (UI)
Base UI size is **13px**: dense enough for an IDE, comfortable for long sessions.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 11 / 16 | 400 | Badges, keybinding hints, status bar |
| `--text-sm` | 12 / 18 | 400 | Secondary text, tree rows in compact, tooltips |
| `--text-md` | 13 / 20 | 400 | **Default UI**: tabs, rows, buttons, inputs, menus |
| `--text-lg` | 14 / 22 | 400 | Chat and markdown body text |
| `--text-xl` | 16 / 24 | 600 | Dialog titles, panel empty-state titles |
| `--text-2xl` | 20 / 28 | 600 | Markdown h2, welcome headings |
| `--text-3xl` | 24 / 32 | 600 | Markdown h1 only |

Weights: 400 regular, 500 medium (active tab, selected row label, buttons), 600 semibold (titles). Never 700+ in chrome.
Letter-spacing: 0 at ≤ 14px; −0.01em at 16–20px; −0.015em at 24px.

### 4.2 Editor and terminal type
- Editor: `--font-mono`, **13px**, line-height **1.6** (≈ 21px), user-adjustable.
- Terminal: `--font-mono`, **13px**, line-height **1.25** (terminals need tighter rows).
- Inline code in UI/chat: `--font-mono` at 0.92em of the surrounding text.

### 4.3 Case and copy rules
- **Sentence case everywhere**: "Open folder", "Source control", "Explorer". No ALL-CAPS section headers (VS Code's `EXPLORER` style is deliberately not used).
- Section headers in sidebars use `--text-sm` / 500 / `--fg-muted`.
- No trailing periods on labels, buttons or tooltips; full sentences in descriptions do have them.

---

## 5. Space, size and density

### 5.1 Spacing scale (4px base, 2px half-step)
| Token | px | | Token | px |
|---|---|---|---|---|
| `--space-0` | 0 | | `--space-6` | 16 |
| `--space-px` | 1 | | `--space-7` | 20 |
| `--space-1` | 2 | | `--space-8` | 24 |
| `--space-2` | 4 | | `--space-9` | 32 |
| `--space-3` | 6 | | `--space-10` | 40 |
| `--space-4` | 8 | | `--space-11` | 48 |
| `--space-5` | 12 | | `--space-12` | 64 |

Rules: padding inside controls uses 2–8; gaps between related items 4–8; between groups 12–16; panel insets 12; empty states and dialogs 24–32.

### 5.2 Sizes
| Token | default | compact | comfortable | Use |
|---|---|---|---|---|
| `--size-control-xs` | 20 | 18 | 22 | Inline icon buttons in rows |
| `--size-control-sm` | 24 | 22 | 28 | Toolbar buttons, tab-strip actions, small inputs |
| `--size-control-md` | 28 | 26 | 32 | Default buttons and inputs |
| `--size-control-lg` | 36 | 32 | 40 | Dialog primary actions |
| `--size-row` | 24 | 22 | 28 | Tree/list rows |
| `--size-tab` | 34 | 30 | 38 | Dock tab height |
| `--size-titlebar` | 38 | 34 | 42 | Title bar |
| `--size-statusbar` | 24 | 22 | 26 | Status bar |
| `--size-activitybar` | 44 | 40 | 48 | Activity bar width |
| `--size-icon-sm` / `-md` / `-lg` | 14 / 16 / 20 | same | same | Icons |
| `--size-gap-panel` | 0 | 0 | 0 | Outer gap around the panels: 0 in `flush` (default); 6 / 4 / 8 in `floating` |
| `--size-gap-split` | 0 | 0 | 0 | Gap between panels, where the splitters are: 0 in `flush` (1px hairline); 4 / 4 / 6 in `floating` (D278) |

Minimum hit area for any interactive element: 24×24 (compact 22).

---

## 6. Radius and borders

Radii follow hierarchy — bigger containers get bigger radii, nested items get smaller ones (`inner = outer − padding`).

| Token | px | Use |
|---|---|---|
| `--radius-xs` | 3 | Badges, kbd, inline code, checkbox |
| `--radius-sm` | 5 | Buttons, inputs, tabs, tree row highlight, menu items |
| `--radius-md` | 8 | Cards, code blocks, tool cards, popovers, menus |
| `--radius-lg` | 10 | Panels (dock groups, sidebar) — `floating` mode only; 0 in `flush` |
| `--radius-lifted` | 10 | A dragged group's preview, in both panel styles (D410) |
| `--radius-xl` | 14 | Dialogs, command palette, chat composer |
| `--radius-full` | 999 | Pills, avatars, switches |

Borders are 1px. In `flush` (default) panels are separated by a single 1px `--border-subtle` hairline — no gaps, no radii. Inside panels prefer surface steps over borders; use `--border-default` for control outlines.

---

## 7. Elevation and shadow

Only floating things cast shadows. Panels are flat.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--shadow-0` | none | none | Panels, cards |
| `--shadow-1` | `0 2px 8px rgb(0 0 0 / .35), 0 0 0 1px var(--border-default)` | `0 2px 8px rgb(16 18 24 / .08), 0 0 0 1px var(--border-default)` | Tooltips, small popovers |
| `--shadow-2` | `0 8px 24px rgb(0 0 0 / .45), 0 0 0 1px var(--border-default)` | `0 8px 24px rgb(16 18 24 / .12), 0 0 0 1px var(--border-default)` | Menus, suggest widget, quick pick |
| `--shadow-3` | `0 20px 56px rgb(0 0 0 / .55), 0 0 0 1px var(--border-strong)` | `0 20px 56px rgb(16 18 24 / .18), 0 0 0 1px var(--border-default)` | Dialogs, command palette |
| `--shadow-drag` | `0 12px 28px rgb(0 0 0 / .6), 0 0 0 1px var(--accent-border)` | `0 12px 28px rgb(16 18 24 / .22), 0 0 0 1px var(--accent-border)` | A tab or item being dragged — crisp and deliberate |

The 1px ring is part of the shadow so floating edges stay sharp on dark backgrounds.

Z-index scale: `--z-base 0`, `--z-sticky 10`, `--z-dropdown 100`, `--z-overlay 200` (dock drop overlays), `--z-modal 300`, `--z-palette 400`, `--z-toast 500`, `--z-tooltip 600`, `--z-drag 700`.

---

## 8. Motion

Motion explains change: where something came from, where it went, what grew. It never decorates.

### 8.1 Durations
| Token | ms | Use |
|---|---|---|
| `--motion-instant` | 0 | Selection changes, caret, typing feedback |
| `--motion-fast` | 90 | Hover fades, icon swaps, button press |
| `--motion-base` | 150 | Label reveal, tooltips, small expands, tab reorder |
| `--motion-slow` | 220 | Panel collapse/expand, menus, drop-zone preview, toasts |
| `--motion-deliberate` | 320 | Dialogs, palette, maximize/restore a group |

### 8.2 Easing
| Token | Curve | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions (moves, resizes, reveals) |
| `--ease-enter` | `cubic-bezier(0, 0, 0, 1)` | Things appearing (menus, toasts) |
| `--ease-exit` | `cubic-bezier(0.3, 0, 1, 1)` | Things leaving (always ~70% of the enter duration) |
| `--ease-spring` | `linear(0, 0.35 12%, 0.72 26%, 0.95 42%, 1.02 56%, 1.005 72%, 1)` | Drag drops settling, tab landing — one tiny overshoot, never bouncy |

### 8.3 Patterns
- **Label reveal (icon → icon + label):** wrap the label in a grid cell and animate `grid-template-columns: 0fr → 1fr` with `--motion-base`/`--ease-standard`; fade label opacity 0 → 1 over the last 60%. Used by activity bar on hover-hold, status bar items, toolbar buttons with hidden labels, collapsed agent tool calls.
- **Expand/collapse (height):** `grid-template-rows: 0fr → 1fr` on a wrapper; never animate `height: auto` with JS measurements.
- **Hover-revealed actions:** row actions (close, more, stage) fade in at `--motion-fast`; they keep their space reserved so text never reflows.
- **Popovers/menus:** scale 0.98 → 1 + opacity, origin at the trigger, `--motion-slow` `--ease-enter`; exit at 70% duration.
- **Dialogs/palette:** translateY(−6px) → 0 + opacity, `--motion-deliberate`.
- **Tabs:** reorder slides with FLIP at `--motion-base`; a dropped tab settles with `--ease-spring`.
- **Dock drop preview:** the highlight rectangle animates between candidate zones at `--motion-slow` (position + size), not jumping.
- **Splitter resize, typing, scrolling:** no animation, ever.
- Only animate `transform`, `opacity`, `grid-template-*` and colors. Never animate layout-heavy properties on large trees.

### 8.4 Reduced motion
With `prefers-reduced-motion: reduce` or `data-motion="reduced"`: all durations become 0 except opacity fades (cap 90ms); shimmer and streaming-text effects become static.

### 8.5 Delays
Tooltip: 500ms first show, 0 while moving between tooltip targets within 300ms. Hover-intent label reveal: 400ms. Never delay feedback to a click.

### 8.6 Sanctioned gradients
1. **Skeleton shimmer:** a soft band (`--bg-surface-raised` → `--bg-hover` → `--bg-surface-raised`) sweeping at 1.4s linear, infinite.
2. **Streaming "Thinking…" text:** the same sweep applied to text via `background-clip: text`, 1.6s.
Nothing else in the UI uses a gradient or glow.

---

## 9. Iconography
- Style: outline, **1.5px stroke**, rounded caps/joins, 24-unit grid drawn at 16px (Lucide-compatible). Stored in the in-repo SVG sprite; `currentColor` only.
- Sizes: 14 (dense rows, inline), **16 (default)**, 20 (activity bar, empty states).
- Color: `--fg-muted` at rest, `--fg-default` on hover/active. Toggled-on state = `--bg-surface-raised` fill behind the icon (never an accent color).
- File icons: monochrome outline glyph per type, tinted with a desaturated language hue from the `--file-icon-*` tokens (Appendix A). Folder icons stay `--fg-muted`; unknown types use `--file-icon-default`. Icon themes are extensions and must keep the 16px grid.

| Token | Types | Dark | Light |
|---|---|---|---|
| `--file-icon-default` | anything else | `--fg-muted` | `--fg-muted` |
| `--file-icon-ts` | .ts .tsx .mts | `#6C9EDB` | `#2F6DB5` |
| `--file-icon-js` | .js .jsx .mjs .cjs | `#D9C46A` | `#8A7A12` |
| `--file-icon-json` | .json .jsonc | `#C9A35B` | `#86631C` |
| `--file-icon-markup` | .html .xml .svg .vue | `#D98A5F` | `#A4502A` |
| `--file-icon-style` | .css .scss .less | `#9C8AD6` | `#6650B0` |
| `--file-icon-md` | .md .mdx .txt | `#9AA3AD` | `#5B6470` |
| `--file-icon-rust` | .rs | `#D08A5B` | `#9E5420` |
| `--file-icon-python` | .py | `#7FAFD6` | `#2F6E9E` |
| `--file-icon-go` | .go | `#6CC2C9` | `#1E7F87` |
| `--file-icon-shell` | .sh .ps1 .bat .cmd | `#8CBF7A` | `#3F7A2C` |
| `--file-icon-config` | .toml .yaml .yml .ini .env lockfiles | `#A6A6A6` | `#626262` |
| `--file-icon-image` | .png .jpg .gif .webp .ico | `#B98ACB` | `#7E4A94` |
- Never mix filled and outline icons in one toolbar; "filled" is only used as a toggled-on state.

---

## 10. Workbench anatomy (visual)

Behavior of the dock (drag, split, move) is specified in `docs/dock.md`, not here. Visually (default **flush**):

```
┌ title bar ─────────────[ ⌕ Search commands      Ctrl+Shift+P ]──── ▢ ▢ ▢ │ — ▢ ✕ ┐
├act┬ Explorer ───────┬ tab  tab  tab ───────────────┬ Agent ──────────────────────┤
│ ▣ │ ▸ src           │                               │                             │
│ ▢ │   file.ts       │   editor                      │   conversation              │
│   │                 ├ Terminal  Problems ───────────┤                             │
│ ⚙ │                 │   terminal                    │ [composer]                  │
├───┴─────────────────┴───────────────────────────────┴─────────────────────────────┤
└ status bar ───────────────────────────────────────────────────────────────────────┘
```

- **Flush (default):** every region — title bar, activity bar, explorer, dock groups, status bar — uses the same shell color (`--bg-app` = `--bg-surface`). Regions are separated only by 1px `--border-subtle` hairlines. No gaps, no radii, no shadows.
- **Floating (setting):** `--bg-app` drops one step darker; the sidebar and each dock group become `--bg-surface` cards with `--radius-lg`, separated by `--size-gap-panel`.

### 10.1 Title bar (responsive)
Height `--size-titlebar`, `--bg-app`, 1px `--border-subtle` bottom. Built as a three-column grid that **never overflows the window**:
`grid-template-columns: minmax(0, 1fr) minmax(160px, 560px) minmax(0, 1fr);` with the window controls in a fixed, non-shrinking area at the far right.
- **Left:** app menu button (logo or ☰), then menu items (File, Edit, View, Go, Terminal, Help) as ghost buttons, then the workspace name. When space runs out, menu items collapse into the ☰ button first, then the workspace name truncates with an ellipsis.
- **Center:** the command field — `--bg-surface-sunken`, `--radius-sm`, height `--size-control-sm`, search icon + "Search commands" placeholder + kbd chip. It shrinks to an icon-only button below 160px; it never pushes other items.
- **Right:** layout toggles (sidebar, bottom, right) as 16px icon buttons, then window controls. Layout toggles hide below ~720px window width. **Window controls (minimize, maximize/restore, close) are always visible and never move off-screen** (hidden only in full screen, as in VS Code, D387). Windows controls: 46×`--size-titlebar`, hover `--bg-hover`; close hover `--status-danger-fg` fill with white icon. macOS uses native traffic lights in the left inset. The Windows 11 snap-layout flyout isn't available with a custom title bar; Win+Z and Win+arrow keys still work, and that trade-off is accepted.
- Everything except buttons and the command field is a drag region; double-click maximizes/restores.
- Every element in every layout container has `min-width: 0` so content (like many tabs) can never widen the window.

### 10.2 Activity bar
Width `--size-activitybar`, `--bg-app`, 1px `--border-subtle` right. Icon buttons 36×36, `--radius-sm`, 20px icons `--fg-muted`. **Active view: `--bg-surface-raised` fill and `--fg-default` icon** — no accent bar. Hover: `--bg-hover`. Badges: `--radius-full` 16px, `--text-xs`, `--bg-surface-raised` + `--fg-default` (status color only for errors). Settings (⚙) and account sit at the bottom.

### 10.3 Sidebar (explorer etc.)
Same shell color as everything else. Header 30px: title in sentence case (`--text-sm` / 500 / `--fg-muted`), actions (new file, new folder, refresh, collapse all) as 20px ghost icon buttons visible on sidebar hover or focus.

### 10.4 Status bar
Height `--size-statusbar`, `--bg-app`, 1px `--border-subtle` top, `--text-xs`, `--fg-muted`; items are ghost buttons with `--radius-xs`. No colored background, ever, except `--status-warning-bg` for an untrusted workspace.

### 10.5 Splitters and scrollbars
- **Splitters (sashes):** the 1px hairline is the visible splitter; hit area 6px. On hover (after 150ms) or drag the hairline becomes 2px `--border-strong`. Cursor changes immediately.
- **Scrollbars:** overlay, 8px thumb (`--fg-subtle` at 35% opacity, `--radius-full`, 50% on hover), visible while the container is hovered or scrolling (CSS-only fade at `--motion-slow`; no JS timers). No tracks or arrows. **Exception — tab strips:** a 4px thumb that is always visible while the strip overflows (§12.3), so overflow is discoverable.

## 11. States

| State | Treatment |
|---|---|
| Rest | Chrome text `--fg-muted`; icons `--fg-muted` |
| Hover | `--bg-hover` fill; text/icon → `--fg-default`; `--motion-fast` |
| Pressed | `--bg-active`; no scale transforms on chrome (buttons may scale 0.98) |
| Selected | `--bg-selected`; text `--fg-default`; weight 500 |
| Selected in focused pane | `--bg-selected-focus` |
| Focus visible | 2px `--focus-ring` outline, 1px offset (inset −1px inside dense lists). Only for keyboard focus (`:focus-visible`). Never removed. |
| Disabled | 45% opacity, `cursor: default`, no hover. Keep tooltips explaining *why*. |
| Drag source | 40% opacity in place |
| Drop target | `--accent-secondary-subtle` fill + 1px `--accent-secondary-border`, `--radius-md` |
| Error (input) | border `--status-danger-fg`; message below in `--text-sm` `--status-danger-fg` |
| Dirty (unsaved) | 6px dot `--fg-default` in place of the close icon; close icon on hover |
| Running / busy | 2px indeterminate progress line at the top edge of the owning panel (`--accent`) |

**Cursor:** `pointer` on every clickable control — buttons, icon buttons, tabs, tree/list rows, menu items, links, chips, toggles, the command field. `default` on static text and panel backgrounds; `text` in editors, inputs and the terminal; resize cursors on splitters; `grab`/`grabbing` only while a tab drag is in progress.

---

## 12. Components

All components live in `src/ui/`. Extensions using declarative views get these automatically. Webview-panel authors should replicate them using tokens (§19).

### 12.1 Buttons
| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--fg-default` (high-contrast) | `--bg-app` | none | The single main action in a dialog, form or empty state |
| Accent | `--accent` | `--fg-on-accent` | none | Agent "Apply"/"Accept" |
| Secondary | `--bg-surface-raised` | `--fg-default` | `--border-default` | Other actions |
| Ghost | transparent | `--fg-muted` → `--fg-default` on hover | none | Toolbars, rows, status bar |
| Danger | transparent | `--status-danger-fg` | `--status-danger-border` | Destructive (hover: `--status-danger-bg`) |
| Icon | ghost, square, `--size-control-sm` | — | — | Toolbars; always has a tooltip and `aria-label` |

Sizes: `sm` (24, `--text-sm`, padding 0 8), `md` (28, `--text-md`, 0 12), `lg` (36, `--text-md`/500, 0 16). Radius `--radius-sm` (`lg` uses `--radius-md`). Icon + label gap: `--space-3`. One primary per view.

### 12.2 Inputs
Text input, textarea, select, search field: `--bg-input` (a translucent tint of the foreground in dark themes, white in light ones — **a field is never darker than the surface under it**: no dark wells on cards, raised panels or overlays; D122), 1px `--border-default`, `--radius-sm`, height `--size-control-md`, padding 0 8, placeholder `--fg-subtle`. Hover: `--border-strong`. Focus: border `--border-input-focus` (a step brighter, D385), no ring. Search fields: leading 14px search icon, trailing clear button on value, inline option toggles (case, word, regex) as 20px ghost icon toggles that fill `--accent-subtle` when on.

**Dropdowns** (D282) look like a field with a chevron and open the IDE's menu (§12.5), never the
system's list: under the field, at least as wide, 2px apart, the chosen value checked; a search
box past 15 options; a long list goes on the side with more room and scrolls, never over the field.

Checkbox 14px `--radius-xs`; switch 28×16 `--radius-full`, on = `--accent`. Radio 14px circle. Labels `--text-md` with `--space-3` gap.

### 12.3 Dock tabs (editor, terminal, agent, settings… all the same component)
- Height `--size-tab`; padding 0 10; gap 6; `--text-md`; min width 80, max width 220 with middle ellipsis on file names. `cursor: pointer`.
- Content: 16px type icon · title · (description in `--fg-subtle`, e.g. parent folder for duplicate names) · close/dirty slot (16px, always reserved).
- Inactive tab: transparent, `--fg-muted`. Hover: `--bg-hover`, `--fg-default`, close icon fades in.
- **Active tab: `--bg-surface-raised` fill, `--radius-sm`** (inset 4px top/bottom inside the strip). In the focused group its text is `--fg-default` / 500; in unfocused groups it keeps the raised fill but its text is `--fg-muted` / 400 (this rule wins over any other wording). In the light theme the active tab also gets a 1px `--border-subtle` outline so it reads on the pale shell. **No underline, no accent.**
- Preview (transient) tabs: italic title.
- **Pinned tabs (D279):** first in their group, a `--fg-subtle` pin in the action slot (always shown; a click unpins). With `workbench.editor.pinnedTabsOnSeparateRow` they get a row of their own above the others, a `--border-subtle` hairline between.
- **Tab options (D279):** the close button can sit left of the title (the insets swap) or be hidden (unsaved dots and pins stay); problem and git colors and badges come from the file decorations (errors `--status-danger-fg`, warnings `--status-warning-fg`, then git's). An editor group's tabs can be a column on its left or right (`--size-tab-list` wide, a hairline toward the editor, the group's actions above the list); panels keep theirs on top.
- **Go back / forward (D279):** two ghost icon buttons left of the title bar's command field (disabled: `--fg-disabled`), or at the start of each tab strip.
- **Tab styles (`workbench.tabStyle`, D278):** the above is `rounded`, the default. `classic`: square tabs edge to edge with a `--border-subtle` hairline between them, the active tab with a 1px `--accent` line along its top (`--accent-border` in an unfocused group), the owner's chosen exception to "no accent". `connected`: the active tab is full height with `--radius-sm` top corners and curved feet, joining the editor; inactive tabs stay as in `rounded`. Both paint the strip `--bg-tab-strip` and the active tab `--bg-surface` (the editor's color).
- Tab strip: same color as its group; 1px `--border-subtle` bottom. Group actions (split, more) pinned on the right, visible on group hover/focus; they never scroll away.
- **Overflow:** the strip scrolls horizontally (mouse wheel scrolls it sideways) and shows the always-visible 4px scrollbar from §10.5 along its bottom edge; the active tab auto-scrolls into view; an overflow "⋯" menu lists all tabs. The strip must have `min-width: 0` and `overflow-x: auto` so tabs never widen the group or the window.
- Terminal tabs are titled with the shell and folder ("pwsh · ide"), never a raw executable path.

### 12.4 Tree and list rows
Height `--size-row`, `--text-md`, indent 12px per level with 1px `--border-subtle` indent guides (shown on tree hover). Chevron 14px `--fg-subtle`. Rows are full-width with `--radius-sm` highlight inset 4px from the panel edges. Row actions appear on hover, right-aligned. Rename-in-place uses the input style at row height. `cursor: pointer`.

**Selection and focus states** (same model as VS Code lists, so it behaves the way users expect):

| State | When | Treatment |
|---|---|---|
| Hover | Pointer over a row | `--bg-hover` |
| **Active selection** | Row is selected *and the tree has keyboard focus* (e.g. you just clicked it) | `--bg-selected-focus` (accent-tinted) + `--fg-default` |
| **Inactive selection** | Row is selected but focus is elsewhere (editor, terminal…) | `--bg-selected` (neutral gray) |
| **Focused row** | The keyboard cursor row while the tree has focus (can differ from the selection) | 1px `--accent-secondary` outline, inset −1px |
| Multi-select | Ctrl/Cmd-click or Shift-click | every selected row uses the selection treatment |
| Drop target (folder) | Dragging a file over a folder | `--accent-secondary-subtle` fill on the folder and its expanded children |
| Cut | After "Cut" | row at 50% opacity |

- **Reveal active editor:** when a tab becomes active (click, keyboard, command), the explorer expands to the file, scrolls it into view and marks it as the selection (inactive-selection look, because focus stays in the editor). Setting `explorer.autoReveal` (default on).
- Clicking a row selects it and focuses the tree (active selection). Single-click opens a file in a preview tab; double-click pins it.
- Git decorations (later) color the file name per §3.5 and add a letter badge on the right.

### 12.5 Menus and context menus
`--bg-overlay`, `--radius-md`, `--shadow-2`, padding 4. Items: height 26, padding 0 8, `--radius-sm`, icon slot 16 (kept even if empty for alignment), label, right-aligned keybinding in `--fg-subtle` `--text-xs`. Hover/keyboard focus: `--bg-hover`. Separators: 1px `--border-subtle` with 4px margin. Submenu chevron right. Destructive items use `--status-danger-fg`.

**Icons in menus (D162):** actions get an icon wherever one is clear (file, folder, editor, tab,
view header and panel menus); lists of data (models, themes, recent folders, branches, accounts)
and on/off items (they show a check) don't. One action, one icon, everywhere:

| Action | Icon | Action | Icon |
|---|---|---|---|
| New file / new text file | `file-plus` | New folder | `folder-plus` |
| Open file | `file-input` | Open folder | `folder-open` |
| New / move to new window | `app-window` | Open to the side, split right | `columns-2` |
| Split down | `rows-2` | Open in browser / externally | `external-link` |
| Reveal in file manager | `folder-search` | Reveal in explorer / locate | `locate` |
| Cut | `scissors` | Copy | `copy` |
| Paste | `clipboard-paste` | Copy path / relative path | `clipboard-copy` |
| Copy link | `link` | Duplicate | `copy-plus` |
| Rename | `pencil` | Delete (destructive) | `trash-2` |
| Close, remove from a list | `x` | Close others | `circle-x` |
| Close to the right | `arrow-right-to-line` | Close all | `list-x` |
| Close saved | `check-check` | Close folder | `folder-x` |
| Pin / unpin | `pin` / `pin-off` | Save / save all | `save` / `save-all` |
| Save as | `file-output` | Revert, discard | `undo-2` |
| Undo / redo | `undo-2` / `redo-2` | Find | `search` |
| Replace | `replace` | Format | `wand-sparkles` |
| Rename symbol | `text-cursor-input` | Refresh, reload | `refresh-cw` |
| Settings, preferences | `settings` | Keyboard shortcuts | `keyboard` |
| Theme, appearance | `palette` | Compare, open changes | `git-compare` |
| Diff of a file | `file-diff` | History, timeline | `history` |
| Stage / unstage | `plus` / `minus` | Commit | `git-commit-horizontal` |
| Push / pull | `cloud-upload` / `cloud-download` | Branch | `git-branch` |
| Stash | `archive` | Run / debug | `play` / `bug-play` |
| Stop | `square` | Restart | `rotate-cw` |
| Terminal | `square-terminal` | Clear | `eraser` |
| Collapse all | `list-collapse` | Expand all | `list-tree` |
| Show / hide | `eye` / `eye-off` | Sort / filter | `arrow-down-a-z` / `list-filter` |
| Docs, help | `book-open` | About, details | `info` |
| Zoom in / out | `zoom-in` / `zoom-out` | Full screen, maximize | `maximize-2` |
| Exit, sign out | `log-out` | Download / upload | `download` / `upload` |
| Go to / peek references | `text-search` | Open a chat | `message-square` |
| New conversation | `message-square-plus` | Rename or change an agent's face | `user-pen` |
| Edit a channel's agents | `users` | A channel's memory | `brain` |
| Archive | `archive` | Close a task | `circle-check` |

**Every** context menu in the IDE uses this component — including the editor's. Monaco's built-in context menu is disabled (`contextmenu: false`) and replaced by this menu populated with the editor's actions (Go to definition, Find references, Rename, Change all occurrences, Format, Cut, Copy, Paste, Command palette), so menus are never unstyled or transparent.

### 12.6 Command palette and quick pick
Width min(640px, 90vw). **Anchored to the top, directly under the title bar's command field** (top = `--size-titlebar` + 4px, horizontally centered on the command field), like VS Code's quick input — never in the middle of the screen. `--bg-overlay`, `--radius-md`, `--shadow-3`. Input row 36px, `--text-md`, `--bg-surface-sunken` input with `--radius-sm` inside 6px padding, bottom divider `--border-subtle`. Results: rows 26px with icon, label (matched characters `--fg-default`/600, rest `--fg-muted`), description `--fg-subtle`, keybinding chips right. Group headings in sentence case `--text-xs` `--fg-subtle`. Max 10 visible rows, VirtualList beyond. Empty: "No matching commands" in `--fg-subtle`.

### 12.7 Keybinding chips (kbd)
`--font-ui`, `--text-xs`, min-width 18, height 18, padding 0 4, `--bg-surface-sunken`, 1px `--border-default`, `--radius-xs`. Use platform symbols on macOS (⌘ ⇧ ⌥ ⌃), words elsewhere (Ctrl Shift Alt).

### 12.8 Tooltip
`--bg-overlay`, `--text-sm`, padding 4 8, `--radius-sm`, `--shadow-1`, max width 280. Label + optional kbd chip. Never contains interactive content.

**Hover card** (`ui/HoverCard`, D148): when the details are worth acting on (a commit in the Graph), an interactive card instead of a tooltip. `--bg-overlay`, 1px `--border-default`, `--radius-md`, `--shadow-2`, max width 420. It shows beside the target, toward the editors, after a ~600 ms rest, and stays while the pointer is in it. Content: a header line (avatar or icon, name, muted meta), the body, then a footer of text links separated from it by a hairline. Esc, a press elsewhere or the wheel closes it.

### 12.9 Badges, pills, counts
Badge: `--text-xs`/500, height 16, padding 0 5, `--radius-full`, neutral = `--bg-surface-raised` + `--fg-muted`; status variants use `-bg` + `-fg`. Counts in the activity bar: `--bg-surface-raised` + `--fg-default` (`--status-danger-*` only for errors).

**Ref badges** (git, D148): an outlined pill with an icon, its hue from one `--ref` variable (the fill is 18% of it, the border 55%): current branch `--scm-graph-0` + target icon, branches `--scm-graph-2`, remote branches `--scm-graph-1` + cloud, tags `--scm-graph-3` + tag. A badge that repeats a neighbour's name shows only its icon. When space is short, only the current branch keeps its name.

**Rating pill** (metrics, D147): a dot and a word (Good, Needs work, Poor) in `--status-*-bg` / `-fg`, top right of a metric card. Ratings never color a card's edge. Rated values add a three-part scale (good / needs work / poor at 45% opacity) with a marker where the value sits.

### 12.10 Dialogs
Width 440 (sm) / 560 (md) / 720 (lg). `--bg-overlay`, `--radius-md`, `--shadow-3`, padding 24, over `--bg-scrim`. Title `--text-xl`; body `--text-md` `--fg-muted`; actions right-aligned with the primary action rightmost on every platform. Escape and scrim click dismiss non-destructive dialogs. Focus is trapped and returned to the trigger.

### 12.11 Toasts / notifications
Bottom-right, stacked with 8px gap, width 360, `--bg-overlay`, `--radius-md`, `--shadow-2`, padding 12. Leading 16px status icon in status color; title `--text-md`/500; message `--fg-muted`; up to 2 actions as `sm` buttons; close on hover. Every toast hides itself, paused on hover (D140): info/success 4s, warnings 6s, errors 8s, toasts with actions 20s; the bell keeps the history. Enter: slide 8px up + fade.

### 12.12 Banners (inline)
Full-width inside a panel, `--status-*-bg`, 1px `--status-*-border` bottom, `--text-sm`, icon + message + actions. Used for "Workspace not trusted", "File changed on disk", "Agent needs permission".

### 12.13 Empty states
Centered in the panel, max width 320: 20px icon in `--fg-subtle`, title `--text-lg`/500 `--fg-default`, one line of guidance `--fg-muted`, one primary or secondary button. Copy invites action: "Open a folder to start", "No problems in this workspace".

### 12.14 Breadcrumbs
Under the tab strip, height 22, `--text-sm` `--fg-muted`, separators are 12px chevrons `--fg-subtle`, last segment `--fg-default`. Each segment is a ghost button opening a picker.

### 12.15 Progress and loading
See §16.

### 12.16 Settings editor
Settings open as a **dock tab** (view type `settings`, singleton), like the terminal or agent — never a modal.
- Header row: scope switcher as a segmented control — **User** · **Workspace** (workspace disabled with a tooltip when no folder is open). Segmented control: `--bg-surface-sunken` track, `--radius-sm`; selected segment `--bg-surface-raised` + `--fg-default`.
- Search field (full width, §12.2) filters settings live; matching text highlighted with `--fg-default`/600.
- Body: a left table of contents (categories: Editor, Workbench, Terminal, Files, Explorer, Agent, Extensions…) as tree rows, and the settings list on the right. Each setting: title (`--text-md`/500, "Editor: Sticky scroll"), description (`--fg-muted`), control (checkbox, select, number/text input, or "Edit in settings.json" link for complex values). A modified setting shows a 2px `--border-strong` bar on its left and a "Reset" ghost action on hover.
- Top-right: "Open settings.json" icon button (opens the JSONC file for the current scope in an editor tab).
- Data comes from the contributed settings schemas, so extensions' settings appear automatically.

### 12.17 Welcome tab
Shown when no editor is open. Centered column (max 420px): the app logo at 48px (`assets/logo.svg`), the product name from `product.json`, then actions as secondary rows with keybindings (Open folder, New file, Open recent ▸, Command palette), and a "Recent" list. Its tab icon is the logo at 16px.

### 12.18 Panels with tracks (timelines)
DevTools' Performance timeline (D147): a 92px label column (64px when narrow) on `--bg-surface-raised`, tracks separated by `--border-subtle`, grid lines in `--border-subtle`, markers as dashed lines in their status color with a pill label. Series colors come from status and graph tokens only. A readout follows the pointer (`--bg-overlay`, `--shadow-2`). A selection is `--accent-subtle` with `--accent` edges. Keep labels in tracks clipped, never overlapping: rows grow (and the track scrolls) instead.

### 12.19 Responsive panels
Panels respond to their own width (container queries), not the window's. In order, as width shrinks:
1. Tab strips go from icon and name to shorter names, then to icons only; the selected tab keeps its name.
2. Strips then scroll like editor tabs.
3. Two-pane splits stack.
4. Secondary table columns go.
5. Groups of toggle chips fold into one menu.
6. Buttons that have an icon lose their words, and the tooltip keeps them.

---

## 13. Agent and chat UI

The agent panel is a dock view like any other. Its job: make a long conversation scannable, make every action the agent takes visible and reversible, and keep the composer always ready.

### 13.1 Layout
- Header (height `--size-tab` as part of the tab): session title (editable), model pill, overflow menu.
- Conversation: max reading width **72ch** centered in wide panels; padding 16; messages separated by 20px; turns by 28px.
- Composer pinned to the bottom with 12px inset.

### 13.2 Messages
- **User message:** a card, `--bg-surface-raised`, `--radius-md`, padding 10 12, `--text-lg`, aligned to the reading column (not right-aligned bubbles). Attached context (files, selection) shown above the text as compact chips.
- **Assistant message:** no container — plain `--text-lg` prose on the panel surface, rendered with the markdown styles in §14. This keeps answers the brightest, calmest thing.
- Message actions (copy, retry, edit, fork) are ghost icon buttons that appear on hover below the message.

### 13.3 Tool calls (the agent's actions)
Each tool call is a single compact row that can expand:
```
[icon] Read  src/editor/service.ts  · 120 lines                  ✓
[icon] Ran   npm test                · exit 1 · 4.2s              ✕   ▸
[icon] Edit  src/core/dispatcher.ts  · +12 −3                     ●   ▸
```
- Row: height 28, `--text-md`, verb in `--fg-default`/500, target in `--font-mono` at 0.92em `--fg-muted`, metadata in `--fg-subtle`, status icon right (spinner while running, ✓ success, ✕ `--status-danger-fg`, ● pending review `--accent`).
- Consecutive read-only calls collapse into a group: "Read 6 files" with a label-reveal expand.
- Expanded content sits in a `--bg-surface-sunken` well, `--radius-md`: command output (mono, ANSI colors), file excerpts, search hits.
- Clicking a target opens it in the editor; clicking a command opens its run in the Agent terminal.

### 13.4 Changes (diff cards)
- Card: `--bg-surface-raised`, 1px `--border-default`, `--radius-md`. Header: file icon, path (mono), `+12 −3` in diff colors, actions: "Open diff", "Reject", "Accept" (accent `sm`).
- Body: up to 8 changed lines preview using `--diff-*` tokens, mono 12px; "Show all" expands.
- A sticky **changeset bar** above the composer when edits are pending: "3 files changed · +40 −12" with "Review", "Reject all", "Accept all".

### 13.5 Permission requests
Inline card with `--status-warning-border` left border 2px, `--bg-surface-raised`: what the agent wants ("Run `npm install`"), why if given, and actions "Deny", "Allow once", "Always allow `npm install`" — focus starts on "Allow once"; Enter confirms, Esc denies. Destructive requests use `--status-danger-*` and no "always" option.

### 13.6 Thinking and streaming
- While waiting for the first token: "Thinking…" with the sanctioned text shimmer (§8.6), `--text-md` `--fg-muted`. Collapsible reasoning (if the model exposes it) as a muted row "Thought for 8s ▸".
- Streaming text appears token-by-token with no per-token animation; a 2×1em `--fg-default` caret blinks (1s steps) at the end until done.
- Auto-scroll follows the stream only if the user is at the bottom; otherwise a "Jump to latest" pill (`--radius-full`, `--shadow-1`) appears.

### 13.7 Composer
- Container: `--bg-surface-raised`, 1px `--border-default`, `--radius-xl`, padding 10 12. Focus-within: border `--border-input-focus` (no ring — the caret is enough; D385).
- Textarea: `--text-lg`, auto-grows 1 → 12 lines, then scrolls. Placeholder: "Ask, or describe a change" in `--fg-subtle`.
- Context chips row above the text when files/selections are attached (`--radius-sm`, `--bg-surface-sunken`, mono file names, remove "×" on hover). `@` and `/` open a list over the box (files, mentions, symbols, agents / commands), its rows like the context menu's (D389, D390); "Browse files and context…" opens the picker.
- Footer row: attach (+) ghost icon, model pill (ghost `sm` with chevron), mode pill ("Review edits" / "Auto-apply"), and on the right the send button: a quiet 30px icon button (no fill), the ↵ icon in `--fg-default`, `--bg-hover` square on hover; with nothing to send it's `--fg-subtle`; while running it becomes Stop, a small filled square (D385). With dictation on, a microphone button in the same style is always last and Send shows to its left only when there's something to send (or to stop); while recording the microphone shows ✓ (D384).
- Enter sends, Shift+Enter newline, Up on empty composer edits the last message.

### 13.8 Session list
When the agent view is narrow or on "History": rows with title, relative time (`--fg-subtle`), and a status dot (running = `--accent`, needs attention = `--status-warning-fg`).

---

## 14. Markdown and prose

Applies to chat answers, markdown preview, hovers, extension descriptions, and empty states with rich text. Base: `--text-lg` (14/22) `--fg-default`; max width 72ch.

| Element | Style |
|---|---|
| Paragraph | margin 0 0 12px |
| h1 | `--text-3xl`/600, margin 24 0 12 |
| h2 | `--text-2xl`/600, margin 20 0 10 |
| h3 | 16/24 600, margin 16 0 8 |
| h4–h6 | 14/22 600, margin 12 0 6; h5–h6 `--fg-muted` |
| Links | `--accent-text`, no underline; underline on hover; external links get a 12px ↗ icon only in docs, not chat |
| Strong / em | 600 / italic |
| Lists | padding-left 20; item gap 4; nested lists 4 top; markers `--fg-subtle`; task lists use the checkbox component (read-only in chat) |
| Inline code | mono 0.92em, padding 1 5, `--bg-surface-sunken`, 1px `--border-subtle`, `--radius-xs` |
| Code block | `--bg-surface-sunken`, `--radius-md`, 1px `--border-subtle`; header row 28px with language (`--text-xs` `--fg-subtle`) and actions (copy, insert at cursor, apply) as ghost icons; body padding 12, mono 12.5/1.6, Shiki-highlighted with the active syntax theme; horizontal scroll, no wrap |
| Blockquote | 2px `--border-strong` left bar, padding-left 12, `--fg-muted` |
| Table | a card as wide as its content (up to the column), 1px `--border-subtle`, `--radius-md`, scrolling inside when wider (D283); `--text-md`; header row 600 `--fg-default` on `--bg-surface-raised`; cells padding 8 12, top-aligned; row dividers 1px `--border-subtle`, none under the last row; numbers right-aligned tabular. Tables elsewhere that show the same kind of data (notebook outputs, an extension's Features tab) use the same card |
| hr | 1px `--border-subtle`, margin 20 0 |
| Images | max-width 100%, `--radius-md` |
| Callouts (`> [!NOTE]` etc.) | banner style using `--status-*` tokens, `--radius-md` |

---

## 15. Editor, diff and terminal

### 15.1 Editor surface (Monaco mapping)
The editor sits directly on its dock group's `--bg-surface`; there is no separate editor color.

**How:** Shiki registers the syntax theme with Monaco; the IDE then defines the final Monaco theme by reading the computed values of the tokens below (`getComputedStyle(document.documentElement)`), resolving `color-mix()`/alpha to hex, and merging them over Shiki's colors. Re-run on every theme or accent change. Monaco needs hex (`#RRGGBB` or `#RRGGBBAA`), so convert alpha tokens accordingly.

| Monaco color key | Token |
|---|---|
| `editor.background`, `editorGutter.background` | `--bg-surface` |
| `editor.foreground` | `--fg-default` |
| `editorLineNumber.foreground` | `--fg-disabled` |
| `editorLineNumber.activeForeground` | `--fg-muted` |
| `editor.lineHighlightBackground` | `--bg-hover` (no border) |
| `editor.selectionBackground` | `--accent` at 35% |
| `editor.inactiveSelectionBackground` | `--accent` at 18% |
| `editor.selectionHighlightBackground` / `wordHighlight` | `--fg-default` at 8% |
| `editor.findMatchBackground` / `findMatchHighlightBackground` | `--status-warning-fg` at 35% / 16% |
| `editorCursor.foreground` | `--fg-default` |
| `editorBracketMatch.background` / `.border` | transparent / `--border-strong` |
| `editorIndentGuide.background` / `.activeBackground` | `--border-subtle` / `--border-strong` |
| `editorWhitespace.foreground` | `--fg-disabled` at 50% |
| `editorError/Warning/Info.foreground` (squiggles) | `--status-danger-fg` / `--status-warning-fg` / `--status-info-fg` |
| `editorGutter.added/modified/deletedBackground` | `--diff-added-fg` / `--diff-modified-fg` / `--diff-removed-fg` (3px bars) |
| `diffEditor.insertedLineBackground` / `insertedTextBackground` | `--diff-added-bg` / `--diff-added-bg-strong` |
| `diffEditor.removedLineBackground` / `removedTextBackground` | `--diff-removed-bg` / `--diff-removed-bg-strong` |
| `editorWidget.background` (find, suggest, hover) | `--bg-overlay` + `--shadow-2` + `--radius-md` |
| `menu.*` / context menu | not used — Monaco's context menu is disabled and replaced by the IDE menu (§12.5) |
| `editorSuggestWidget.selectedBackground` | `--bg-selected-focus` |
| `editorStickyScroll.background` | `--bg-surface` + 1px `--border-subtle` bottom (no shadow) |
| `scrollbarSlider.*` | §10 scrollbar spec |
| `minimap` | **off by default**; when on, background `--bg-surface`, slider `--bg-hover` |

Editor defaults: font 13px/1.6, padding-top 8, cursor style line (2px), smooth caret animation **off**, render line highlight "line", **sticky scroll on by default** (enclosing functions/classes stay pinned at the top, max 5 lines), `contextmenu: false` (IDE menu instead), bracket-pair colorization off (Shiki colors suffice), rulers `--border-subtle`, overview ruler border none.

### 15.2 Syntax theme
Default: **Shiki `dark-plus`** (light theme: `light-plus`). The syntax theme is separate from UI tokens; the editor background always comes from `--bg-surface`, so any Shiki/VS Code syntax theme can be paired with any UI theme.

### 15.3 Agent inline edits
Pending agent changes render inline in the editor: added lines `--diff-added-bg`, removed lines shown as a collapsed `--diff-removed-bg` zone above, with a floating 24px action bar at the hunk's top-right (`--bg-overlay`, `--shadow-1`, `--radius-sm`): "Reject" (ghost) · "Accept" (accent `sm`) · hunk counter "2 of 5".

### 15.4 Terminal
- Background `--bg-surface` (same shell color as everything else); foreground `--fg-default`; cursor `--fg-default` (block, blinking); selection `--accent` at 35%.
- **Bell:** silent by default (`terminal.bell: "none" | "visual" | "sound"`, default `none`). The visual bell is a 150ms `--bg-hover` flash of the terminal tab.
- Sizing: the terminal fills its group exactly; it is refit only when the group's pixel size changes and only resizes the PTY when the computed columns/rows actually change. It must never grow its container.
- Padding 8 12 inside the panel. No border.
- Shell-integration decorations: 6px dot in the left gutter per command (`--fg-subtle` running, `--status-success-fg` exit 0, `--status-danger-fg` non-zero), hover shows command duration.
- ANSI palette (dark / light):

| ANSI | Dark | Light | | ANSI | Dark | Light |
|---|---|---|---|---|---|---|
| black | `#1F2024` | `#1B1C20` | | bright black | `#5C5F68` | `#6B6E77` |
| red | `#F27474` | `#BE3333` | | bright red | `#FF9494` | `#D64545` |
| green | `#4CC38A` | `#18794A` | | bright green | `#6FDCA6` | `#22975E` |
| yellow | `#E8AE4C` | `#8A5800` | | bright yellow | `#F5C76E` | `#A86D00` |
| blue | `#7BA4FF` | `#2F5FD0` | | bright blue | `#9DBCFF` | `#4677E6` |
| magenta | `#C792EA` | `#8F3FB8` | | bright magenta | `#DDB2F5` | `#A552CF` |
| cyan | `#5BC8D6` | `#137A87` | | bright cyan | `#82DCE6` | `#1A93A2` |
| white | `#C9CBD1` | `#5A5D66` | | bright white | `#F2F3F5` | `#1B1C20` |

---

## 16. Loading and feedback

| Situation | Pattern |
|---|---|
| < 150ms expected | Nothing. Don't flash loaders. |
| Panel content loading (tree, results, extension list) | **Skeleton rows** after 150ms: bars at row height, widths varied 40–85%, `--bg-surface-raised`, `--radius-xs`, with shimmer (§8.6). |
| Panel busy (search running, git fetch, agent task) | **2px indeterminate progress line** at the top edge of the panel, `--accent`, 1.2s ease-in-out sweep. |
| Inline small task (button action, row operation) | **Spinner** 12/14px, 1.5px stroke ring, `--fg-muted`, 700ms linear rotation, replacing the icon in place (no layout shift). |
| Determinate (download model, install extension) | 4px track `--bg-surface-sunken`, fill `--accent`, `--radius-full`, percentage `--text-xs` tabular. |
| Agent waiting for model | "Thinking…" text shimmer (§13.6). |
| Editor loading (Monaco lazy-load) | Editor area shows the file's first ~40 lines as plain mono text immediately, swapped for Monaco when ready (no spinner). |
| Success after action | Icon swaps to a check for 1.2s (`--status-success-fg`), or a toast if the result isn't visible. |
| Errors | Inline where it happened (input, row, card) with a clear next step; toast only if the source isn't visible. Copy states what failed and how to fix it, never apologizes. |

---

## 17. Writing in the UI
- Sentence case, plain verbs: "Open folder", "Accept all", "Run task". The button and its result use the same verb ("Accept" → "Accepted 3 changes").
- Name things by what the user does, not how it's built: "Agent sessions", not "ACP clients".
- Errors: what happened + how to fix it. "Couldn't save `app.ts`: the file is read-only. Save as a copy?"
- Empty states invite action: "No terminals open · New terminal".
- Keep tooltips to a label + keybinding.
- Never use the product name in UI copy unless it comes from `product.json`.

---

## 18. Accessibility
- Text contrast ≥ 4.5:1 for all text tokens (verified in §3.1); non-text UI (icons, focus rings, borders on inputs) ≥ 3:1 against adjacent colors.
- Every interactive element is reachable by keyboard and shows `:focus-visible`.
- Roles: `tablist`/`tab`/`tabpanel` for dock tabs, `tree`/`treeitem` for the explorer, `listbox`/`option` for quick pick, `menu`/`menuitem`, `dialog` with `aria-modal`, `log` with `aria-live="polite"` for the agent conversation, `status` for the status bar.
- Never use color alone: diff uses +/− glyphs and gutter bars; status uses icons.
- Respect `prefers-reduced-motion`, `prefers-contrast: more` (switch borders to `--border-strong`, `--fg-muted` → `--fg-default`), and OS font scaling via a UI zoom setting (80–150%).
- Hit targets ≥ 24px.

---

## 19. Theming and VS Code theme import
- **Built-in themes** (dark and light) are defined directly in `src/styles/tokens.css` (Appendix A). It is hand-authored source, not generated.
- **Imported themes** are applied at runtime as semantic-token overrides on top of the built-in theme of the same kind (dark/light).
- A theme is a VS Code-format theme JSON (`colors` + `tokenColors`). The importer maps VS Code keys to our semantic tokens; unmapped keys are ignored, missing tokens fall back to the base theme.

| Semantic token | VS Code key(s) used when importing |
|---|---|
| `--bg-app` | `titleBar.activeBackground`, then `activityBar.background` |
| `--bg-surface` | `editor.background` |
| `--bg-surface-sunken` | `input.background`, then `sideBar.background` darkened |
| `--bg-surface-raised` | `editorWidget.background`, then `dropdown.background` |
| `--bg-overlay` | `menu.background`, then `quickInput.background` |
| `--fg-default` | `editor.foreground`, then `foreground` |
| `--fg-muted` | `descriptionForeground`, then `tab.inactiveForeground` |
| `--fg-subtle` | `editorLineNumber.activeForeground` |
| `--border-default` | `panel.border`, then `input.border` |
| `--accent` | `focusBorder`, then `button.background` |
| `--status-*-fg` | `editorError/Warning/Info.foreground`, `gitDecoration.addedResourceForeground` |
| `--diff-*` | `diffEditor.*` |
| Terminal ANSI | `terminal.ansi*` |

- User overrides: `"workbench.colorCustomizations": { "--accent": "#5FB3A1" }` in `settings.json`, applied after the theme.
- Theme switching updates `<html data-theme>` and swaps one stylesheet; no reload.

---

## 20. For extension authors

### 20.1 What you get for free
- **Declarative views** (tree, list, form, markdown) are rendered by the host with the components in §12 — they match automatically.
- **Webview panels** (sandboxed iframes) receive the host's token stylesheet injected as `<link rel="stylesheet" href="ide-tokens.css">` and live updates when the theme changes, plus `data-theme` and `data-density` on the iframe's `<html>`.

### 20.2 Rules
1. Use **semantic tokens only** (`var(--bg-surface)`, `var(--fg-muted)`, `var(--space-4)`…). Never hard-code colors, and never use primitive tokens.
2. Use `--font-ui` and the type scale; `--font-mono` for code. Don't bundle fonts.
3. Use the 16px outline icon style (1.5 stroke, `currentColor`).
4. Sentence case for all labels. No ALL-CAPS headers.
5. One primary button per view. Accent only for focus rings, focused selection, links and progress — never on tabs, borders, headers or decoration.
6. No gradients or glows (except the two in §8.6), no custom shadows on flat content.
7. Motion uses the duration and easing tokens and respects reduced motion.
8. Provide empty, loading and error states for every view.
9. Keyboard: everything reachable, visible focus, Escape closes transient UI.
10. Test in dark, light, `compact` and `flush`.

### 20.3 Review checklist
- [ ] No hex/rgb values outside a theme file
- [ ] All spacing from `--space-*`, radii from `--radius-*`
- [ ] Text passes contrast in both themes
- [ ] Works at 300px panel width and at 1600px
- [ ] Focus visible on every control
- [ ] Empty / loading / error states present
- [ ] Reduced motion respected
- [ ] Copy is sentence case, verbs match outcomes

### 20.4 Minimal webview example
```html
<link rel="stylesheet" href="ide-tokens.css">
<style>
  body { margin: 0; padding: var(--space-5); background: var(--bg-surface);
         color: var(--fg-default); font: var(--text-md-font); }
  .card { background: var(--bg-surface-raised); border-radius: var(--radius-md);
          padding: var(--space-5); }
  .muted { color: var(--fg-muted); }
  button.accent { height: var(--size-control-sm); padding: 0 var(--space-4);
         background: var(--accent); color: var(--fg-on-accent); border: 0;
         border-radius: var(--radius-sm); font: inherit; }
  button.accent:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
</style>
```

---

## Appendix A — `tokens.css` reference implementation

```css
@layer tokens {
  :root {
    /* ---------- primitives (private) — true neutrals, no tint ---------- */
    --gray-1000: #111111; --gray-975: #141414; --gray-950: #181818;
    --gray-925: #232323; --gray-900: #262626; --gray-700: #5C5C5C;
    --gray-550: #8C8C8C; --gray-450: #A6A6A6; --gray-100: #E6E6E6;
    --blue-600: #2B6FD1; --blue-550: #3A7EE0; --blue-300: #6AA9F5;
    --green-400: #4CC38A; --amber-400: #E8AE4C; --red-400: #F27474;

    /* ---------- type ---------- */
    --font-ui: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont,
               "SF Pro Text", Inter, Ubuntu, "Noto Sans", sans-serif;
    --font-mono: "Droid Sans Mono", "monospace", monospace;
    /* :root[data-platform="windows"]: Consolas, "Courier New", monospace
       :root[data-platform="mac"]: Menlo, Monaco, "Courier New", monospace */
    --text-xs: 11px;  --text-xs-lh: 16px;
    --text-sm: 12px;  --text-sm-lh: 18px;
    --text-md: 13px;  --text-md-lh: 20px;
    --text-lg: 14px;  --text-lg-lh: 22px;
    --text-xl: 16px;  --text-xl-lh: 24px;
    --text-2xl: 20px; --text-2xl-lh: 28px;
    --text-3xl: 24px; --text-3xl-lh: 32px;
    --text-md-font: 400 var(--text-md)/var(--text-md-lh) var(--font-ui);

    /* ---------- space ---------- */
    --space-0: 0; --space-px: 1px; --space-1: 2px; --space-2: 4px; --space-3: 6px;
    --space-4: 8px; --space-5: 12px; --space-6: 16px; --space-7: 20px; --space-8: 24px;
    --space-9: 32px; --space-10: 40px; --space-11: 48px; --space-12: 64px;

    /* ---------- size (default density) ---------- */
    --size-control-xs: 20px; --size-control-sm: 24px; --size-control-md: 28px;
    --size-control-lg: 36px; --size-row: 24px; --size-tab: 34px;
    --size-titlebar: 38px; --size-statusbar: 24px; --size-activitybar: 44px;
    --size-icon-sm: 14px; --size-icon-md: 16px; --size-icon-lg: 20px;
    --size-gap-panel: 0px;

    /* ---------- radius ---------- */
    --radius-xs: 3px; --radius-sm: 5px; --radius-md: 8px;
    --radius-lg: 0px; /* panels: 0 in flush (default), 10px in floating */
    --radius-xl: 14px; --radius-full: 999px;

    /* ---------- motion ---------- */
    --motion-instant: 0ms; --motion-fast: 90ms; --motion-base: 150ms;
    --motion-slow: 220ms; --motion-deliberate: 320ms;
    --ease-standard: cubic-bezier(0.2, 0, 0, 1);
    --ease-enter: cubic-bezier(0, 0, 0, 1);
    --ease-exit: cubic-bezier(0.3, 0, 1, 1);
    --ease-spring: linear(0, 0.35 12%, 0.72 26%, 0.95 42%, 1.02 56%, 1.005 72%, 1);

    /* ---------- z ---------- */
    --z-base: 0; --z-sticky: 10; --z-dropdown: 100; --z-overlay: 200; --z-modal: 300;
    --z-palette: 400; --z-toast: 500; --z-tooltip: 600; --z-drag: 700;
  }

  /* ---------- dark (default) ---------- */
  :root, :root[data-theme="dark"] {
    color-scheme: dark;
    --bg-app: var(--gray-950);
    --bg-surface: var(--gray-950);
    --bg-surface-sunken: var(--gray-975);
    --bg-surface-raised: var(--gray-925);
    --bg-overlay: var(--gray-900);
    --bg-scrim: rgb(0 0 0 / 0.5);

    --fg-default: var(--gray-100);
    --fg-muted: var(--gray-450);
    --fg-subtle: var(--gray-550);
    --fg-disabled: var(--gray-700);
    --fg-on-accent: #FFFFFF;

    --border-subtle: rgb(255 255 255 / 0.06);
    --border-default: rgb(255 255 255 / 0.09);
    --border-strong: rgb(255 255 255 / 0.16);
    --bg-hover: rgb(255 255 255 / 0.05);
    --bg-active: rgb(255 255 255 / 0.08);
    --bg-selected: rgb(255 255 255 / 0.08);

    --accent: var(--blue-600);

    --status-success-fg: var(--green-400);
    --status-warning-fg: var(--amber-400);
    --status-danger-fg: var(--red-400);
    --diff-modified-fg: #5B9BD5;

    --file-icon-default: var(--fg-muted);
    --file-icon-ts: #6C9EDB; --file-icon-js: #D9C46A; --file-icon-json: #C9A35B;
    --file-icon-markup: #D98A5F; --file-icon-style: #9C8AD6; --file-icon-md: #9AA3AD;
    --file-icon-rust: #D08A5B; --file-icon-python: #7FAFD6; --file-icon-go: #6CC2C9;
    --file-icon-shell: #8CBF7A; --file-icon-config: #A6A6A6; --file-icon-image: #B98ACB;

    --shadow-1: 0 2px 8px rgb(0 0 0 / .35), 0 0 0 1px var(--border-default);
    --shadow-2: 0 8px 24px rgb(0 0 0 / .45), 0 0 0 1px var(--border-default);
    --shadow-3: 0 16px 48px rgb(0 0 0 / .55), 0 0 0 1px var(--border-strong);
    --shadow-drag: 0 12px 28px rgb(0 0 0 / .6), 0 0 0 1px var(--accent-border);
  }

  /* ---------- light ---------- */
  :root[data-theme="light"] {
    color-scheme: light;
    --bg-app: #F7F7F7; --bg-surface: #F7F7F7; --bg-surface-sunken: #F0F0F0;
    --bg-surface-raised: #EBEBEB; --bg-overlay: #FFFFFF;
    --bg-scrim: rgb(0 0 0 / 0.2);
    --fg-default: #1F1F1F; --fg-muted: #575757; --fg-subtle: #686868;
    --fg-disabled: #A8A8A8; --fg-on-accent: #FFFFFF;
    --border-subtle: rgb(0 0 0 / 0.07); --border-default: rgb(0 0 0 / 0.10);
    --border-strong: rgb(0 0 0 / 0.18);
    --bg-hover: rgb(0 0 0 / 0.04); --bg-active: rgb(0 0 0 / 0.07);
    --bg-selected: rgb(0 0 0 / 0.06);
    --accent: #2B6FD1; --accent-hover: #235FB6; --accent-text: #1F64C2;
    --status-success-fg: #18794A; --status-warning-fg: #8A5800; --status-danger-fg: #BE3333;
    --diff-modified-fg: #2F6EB5;
    --file-icon-default: var(--fg-muted);
    --file-icon-ts: #2F6DB5; --file-icon-js: #8A7A12; --file-icon-json: #86631C;
    --file-icon-markup: #A4502A; --file-icon-style: #6650B0; --file-icon-md: #5B6470;
    --file-icon-rust: #9E5420; --file-icon-python: #2F6E9E; --file-icon-go: #1E7F87;
    --file-icon-shell: #3F7A2C; --file-icon-config: #626262; --file-icon-image: #7E4A94;
    --shadow-1: 0 2px 8px rgb(0 0 0 / .08), 0 0 0 1px var(--border-default);
    --shadow-2: 0 8px 24px rgb(0 0 0 / .12), 0 0 0 1px var(--border-default);
    --shadow-3: 0 16px 48px rgb(0 0 0 / .16), 0 0 0 1px var(--border-default);
    --shadow-drag: 0 12px 28px rgb(0 0 0 / .2), 0 0 0 1px var(--accent-border);
  }

  /* ---------- derived (both themes) ---------- */
  :root {
    --accent-subtle: color-mix(in srgb, var(--accent) 16%, transparent);
    --accent-border: color-mix(in srgb, var(--accent) 50%, transparent);
    --focus-ring: var(--accent);
    --bg-selected-focus: color-mix(in srgb, var(--accent) 28%, transparent);
    --status-info-fg: var(--accent-text);
    --status-success-bg: color-mix(in srgb, var(--status-success-fg) 12%, transparent);
    --status-warning-bg: color-mix(in srgb, var(--status-warning-fg) 12%, transparent);
    --status-danger-bg:  color-mix(in srgb, var(--status-danger-fg) 12%, transparent);
    --status-info-bg:    color-mix(in srgb, var(--status-info-fg) 12%, transparent);
    --status-success-border: color-mix(in srgb, var(--status-success-fg) 35%, transparent);
    --status-warning-border: color-mix(in srgb, var(--status-warning-fg) 35%, transparent);
    --status-danger-border:  color-mix(in srgb, var(--status-danger-fg) 35%, transparent);
    --status-info-border:    color-mix(in srgb, var(--status-info-fg) 35%, transparent);
    --diff-added-fg: var(--status-success-fg);
    --diff-removed-fg: var(--status-danger-fg);
    --diff-added-bg: color-mix(in srgb, var(--diff-added-fg) 12%, transparent);
    --diff-added-bg-strong: color-mix(in srgb, var(--diff-added-fg) 28%, transparent);
    --diff-removed-bg: color-mix(in srgb, var(--diff-removed-fg) 12%, transparent);
    --diff-removed-bg-strong: color-mix(in srgb, var(--diff-removed-fg) 28%, transparent);
  }
  :root[data-theme="light"] {
    --bg-selected-focus: color-mix(in srgb, var(--accent) 16%, transparent);
    --accent-subtle: color-mix(in srgb, var(--accent) 10%, transparent);
    --accent-border: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* ---------- density ---------- */
  :root[data-density="compact"] {
    --size-control-xs: 18px; --size-control-sm: 22px; --size-control-md: 26px;
    --size-control-lg: 32px; --size-row: 22px; --size-tab: 30px;
    --size-titlebar: 34px; --size-statusbar: 22px; --size-activitybar: 40px;
  }
  :root[data-density="comfortable"] {
    --size-control-xs: 22px; --size-control-sm: 28px; --size-control-md: 32px;
    --size-control-lg: 40px; --size-row: 28px; --size-tab: 38px;
    --size-titlebar: 42px; --size-statusbar: 26px; --size-activitybar: 48px;
  }

  /* ---------- panel style: flush is the default; floating opts in ---------- */
  :root[data-panels="floating"] { --size-gap-panel: 6px; --radius-lg: 10px; --bg-app: var(--gray-1000); }
  :root[data-panels="floating"][data-theme="light"] { --bg-app: #EDEDED; }
  :root[data-panels="floating"][data-density="compact"] { --size-gap-panel: 4px; }
  :root[data-panels="floating"][data-density="comfortable"] { --size-gap-panel: 8px; }

  /* ---------- reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    :root { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; --motion-deliberate: 0ms; }
  }
  :root[data-motion="reduced"] {
    --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; --motion-deliberate: 0ms;
  }
}
```

---

## Changelog

**v2.1** (D146–D149)
- Hover cards (§12.8), ref badges and rating pills (§12.9).
- Tracks and timelines (§12.18), responsive panels by container width (§12.19).
- Metric cards lost their colored left edge: rating pill + scale instead.
- The Testing view's status icons: `--status-success-fg` / `--status-danger-fg`, `--fg-subtle` for skipped and not run; the editor margin shows the same as dots.

**v2**
- Neutral grays (no blue tint); one shell color shared by title bar, sidebar/explorer, editor, terminal, agent and status bar.
- **Flush panels are the default**; floating is opt-in.
- Accent changed to a restrained blue and limited to focus rings, focused selection, editor selection, links and progress. Removed: active-tab underline, activity-bar accent bar, accent caret.
- Active tab and active activity-bar button = one surface step up (`--bg-surface-raised`).
- Responsive title bar spec (§10.1); quick input anchored under the command field (§12.6).
- VS Code-style tree states and reveal-active-editor (§12.4).
- Pointer cursor on all clickable controls (§11).
- Visible tab-strip scrollbar on overflow (§12.3).
- IDE context menu replaces Monaco's (§12.5); sticky scroll on by default (§15.1).
- Settings editor as a dock tab (§12.16); welcome tab with logo (§12.17).
- Terminal bell silent by default; terminal sizing rules (§15.4).
- From the M1.5 review: `--file-icon-*` tokens (§9); CSS-only scrollbar fade; unfocused active tab rule clarified; light-theme active tab outline; snap-layout flyout trade-off accepted.
