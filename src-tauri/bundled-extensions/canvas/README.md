# Canvas

An infinite canvas that you and the agent share. It holds cards of Markdown, files and links,
groups, and arrows between them. Use it to sketch an architecture, plan a feature, map a codebase,
or keep notes beside the code. Canvases are `.canvas` files in the [JSON Canvas](https://jsoncanvas.org)
format, the open format Obsidian uses, so they open there too.

## Using it

- **Opening it:** the **Canvases** icon in the activity bar lists the project's canvases (+
  makes one). **View → Tools → Main canvas**, the **Open** button on the extension's page, and
  New tab (a group's ⋯ menu) work too, as does **Canvas: Open** in the command palette
  (Ctrl+Shift+P). **Canvas: Open** opens the project's main canvas (`<workspace folder>/canvas/main.canvas`).
  Any `.canvas` file opens here, and **Canvas: New canvas** (also in the explorer's folder menu)
  makes another.
- **Cards:**
  - **Add one:** double-click the board, or use the toolbar's **+ card**.
  - **Edit it:** double-click a card. The text is Markdown: headings, lists, `- [ ]` tasks you
    can tick, tables and code.
  - **Finish editing:** press Esc or Ctrl+Enter.
- **Arrows:** drag one of a card's edge dots onto another card. Drop it on empty space instead
  and you get a new card there. Double-click an arrow to label it.
- **Files, images and links:**
  - **Add a file…** and **Add an image…** search the project like quick open.
  - A file card shows the file's first lines and an image card shows the image. Double-click
    either to open it.
  - **Add a link…** adds a link. The card shows the page itself (YouTube and Vimeo as a
    player); select the card to use it, double-click its title to open it in the browser. Some
    sites refuse to be shown inside another page: the card's menu has **Show as a link**
    (setting `canvas.embedPages` turns pages off everywhere).
  - Markdown notes look as they do in the Markdown preview, in your theme.
  - **Drag things out of a card:** select a note's card, then drag a link, an image or a heading
    onto the board for a card of its own (a heading gives the note narrowed to it). Selected text
    dragged out becomes a text card.
- **Right-click** anything for what fits there:
  - **On the board:** add things there, paste, arrange.
  - **On cards:** colors, duplicate, front/back, fit to text, copy path, ungroup.
  - **On arrows:** label, arrowheads, reverse.
- **Find:** Ctrl+F finds cards by their text, file or link.
- **Groups:**
  - Select some cards and press **Group** (Ctrl+G).
  - Drag a group by its name, and the cards inside move with it.
  - Double-click the name to rename it.
- **Moving around:**
  - **Pan:** use the wheel or trackpad, Space+drag, or drag with the middle button.
  - **Zoom:** use Ctrl+wheel, +/-, Ctrl+0 for 100%, or Shift+1 to fit everything.
  - **Select:** drag a box on the board, and Shift adds to the selection.
- **Shortcuts:**
  - Delete removes the selection.
  - Ctrl+D duplicates it.
  - Ctrl+C / X / V copy, cut and paste cards. Pasted text becomes a card, and a pasted link
    becomes a link card.
  - Arrow keys nudge the selection.
  - Ctrl+Z / Ctrl+Shift+Z undo and redo.
- **Arrange** lays out the selection, or everything, along the arrows, or in a grid when there
  are no arrows.
- **Colors:** with something selected, the bar at the top colors it (six colors, the format's
  presets).

**Like Obsidian's canvas:**
- **Moving:** Alt-drag duplicates, Shift-drag moves along one axis, and Space turns snapping off.
  Cards snap to other cards' edges, and dashed guides show where.
- **Resizing:** drag any edge; Shift keeps the shape.
- **Arrows:** select one and drag its end to another card, or off a card to remove it.
- **Align ▾** (in the selection bar) aligns, spreads out and sizes cards evenly.
- **Groups** can have a background image.
- **Notes:** narrow a note to a heading, or convert a text card to a note.
- **Adding:** Add to canvas from the explorer; pasted images become cards.
- **Export as image:** PNG or SVG, with a privacy mode.
- **Read-only** lock, and **?** lists every shortcut.

File cards show code in the editor's colors, with the file icon theme's icons.

Changes save to the file as you go. When the file changes on disk (the agent, git, another
window), the canvas takes the new version, keeps your unsaved moves, and lights up what changed.
Ctrl+Z undoes the agent's change too.

## For the agent

These are ordinary IDE commands, so the agent finds them with `find_commands canvas`:

| Command | What it does |
|---|---|
| `canvas.read` | Cards, arrows, and what the user has selected |
| `canvas.edit` | One call with a list of `ops`: `add` (with `ref` names later ops can use, `near` / `side` to place it), `update`, `remove`, `connect`, `disconnect`, `group`, `layout` (`tree` along the arrows, `grid`, `row`, `column`), `clear`. It opens the canvas beside the editor and lights up what changed |
| `canvas.focus` | Zooms to cards |
| `canvas.open`, `canvas.new`, `canvas.newNamed`, `canvas.list` | Open, create (`newNamed` asks for a name) and list canvases |
| `canvas.refresh` | Refreshes the Canvases view's list |
| `canvas.addFiles` | File cards for a file or a folder's files |
| `canvas.export` | A PNG or SVG of the canvas, saved beside it; returns its path |

A diagram in one call:

```json
{ "ops": [
  { "op": "add", "ref": "ui", "text": "## UI\nVanilla TS views" },
  { "op": "add", "ref": "core", "text": "## Core\nDispatcher, state", "near": "ui" },
  { "op": "connect", "from": "ui", "to": "core", "label": "commands" },
  { "op": "layout", "style": "tree" }
] }
```

Settings (the toolbar's gear): `canvas.folder` (where new canvases go), `canvas.cardWidth`,
`canvas.arrowStyle` (curved, straight, elbow), `canvas.showImages`, `canvas.snapToGrid`,
`canvas.showGrid`, `canvas.snapToObjects` (snap to other cards' edges), `canvas.embedPages`. The Canvases view's + asks for a name, so you can keep several. Permissions: read and change files in the
open folder (the canvases), and the browser (to open link cards).
