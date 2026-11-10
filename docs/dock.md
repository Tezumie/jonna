> The dynamic dock: everything except the activity bar and sidebar lives in one n-ary split tree of tab groups.
> Implementation: `src/core/dock/` (DOM-free model + tree operations) and `src/workbench/dock/` (DOM, drag and drop, iframe layer).

# Dock specification

### 1. Model
```
Workbench
├─ TitleBar
├─ ActivityBar + Sidebar     (fixed, collapsible; not part of the dock)
├─ Dock                      (everything else)
│   └─ root: DockNode
└─ StatusBar

DockNode = Split | Group
Split  { kind: "split", direction: "row" | "column", children: DockNode[], sizes: number[] /* fractions, sum 1 */ }
Group  { kind: "group", id, tabs: TabRef[], activeTabId, maximized?: boolean, hidden?: boolean /* Ctrl+J, region toggles */ }
TabRef { id, viewType, viewState: Json, preview?: true, pinned?: true }   // e.g. { viewType: "editor", viewState: { path } }
```
- The dock is an **n-ary split tree**; splits in the same direction are flattened (no row inside a row).
- There is **no** special bottom panel or right panel. "Terminal at the bottom, agent on the right" is just the default tree.
- The tree is plain JSON: persisted per workspace in `state.json`, exposed at `ide://layout`, and fully controllable through commands.

### 2. Views
Every tab hosts a **view**. Views are registered by extensions (built-ins included):
```ts
interface ViewDescriptor {
  type: string;                 // "editor" | "terminal" | "agent" | "problems" | "output" | "search" | "browser" | ...
  title(state): string;
  icon(state): string;
  singleton?: boolean;          // e.g. "problems": at most one tab
  create(host: HTMLElement, state: Json): View;   // View: { update?(state), onShow?(), onHide?(), onResize?(), serialize(): Json, dispose() }
  defaultPlacement?: "main" | "bottom" | "right"; // hint only, used when no tab of this type exists yet
}
```
Built-in view types include `editor`, `terminal`, `agent`, `welcome`, `problems`, `browser`, `diff`, `settings`, `notebook`, `searchEditor` and the file viewers; extensions add their own. `ide://layout` lists them (`viewTypes`). None needed dock changes.

### 3. Default arrangement
```
row
├─ column (0.70)
│   ├─ group "main"    (0.70)  editor tabs / welcome
│   └─ group "bottom"  (0.30)  Terminal (only with a folder open)
└─ group "right"       (0.30)  Agent
```
The window starts from this when there's nothing to restore (`workbench/baseLayout.ts`, D163): the agent's column is about 380px wide, and it keeps its width in pixels when the window is resized (`keepRightWidth.ts`, D164).
"main", "bottom", "right" are only initial ids used for placement hints; once the user rearranges, hints resolve to the nearest group in that region or create one there.

### 4. Drag and drop
- Start: pointer down on a tab, move ≥ 4px. A flat copy of the tab lifts and follows the pointer with `--shadow-drag`; the source tab drops to 40% opacity.
- While dragging over a group, compute the drop zone:
  - **Tab strip:** insert at position (an insertion caret 2px `--accent` between tabs; other tabs FLIP aside).
  - **Center** (inner 50% of the group body): add to this group.
  - **Edges** (outer 25% on each side): split this group left/right/top/bottom.
  - **Dock edges** (outer 16px of the whole dock): split at the root level (full height/width).
- A single preview rectangle (`--accent-subtle` fill, 1px `--accent-border`, `--radius-md`) animates between candidate zones (`--motion-slow`, `--ease-standard`).
- Drop: commit the tree change, tab settles with `--ease-spring`. Escape or dropping outside cancels.
- Sizes: a new split gives the new group 50% of the target (35% for a bottom split, 30% for a right split when the dragged view is `terminal` or `agent`).
- The left sidebar is not a drop target, except for a moved sidebar view's tab, which goes back
  there (§10). Dragging a file from the explorer onto the dock opens it as an editor tab in the zone (same zones, same preview); several selected rows open together, and a folder opens as a folder browser tab (D190).
- A tab moves into a window of its own with `layout.moveToNewWindow` (the tab menu, D101). Dragging a tab out of the window isn't supported yet.
- Whole groups (D97): pointer down on the empty part of a tab strip (or on a group's only tab) and
  move ≥ 4px. The live group element is transformed in place (`lift.ts`: never cloned or
  re-parented) and shrinks toward the pointer to at most 360×240, keeping its aspect ratio and the
  grabbed point under the cursor; its slot shows a dashed outline; browser iframes follow through
  the iframe layer. Same zones as tabs (the group itself is never a target); the drop commits
  `layout.moveGroup` and the group glides into its new slot. Right-click on the strip's empty area
  or its ⋯ opens the group menu (`groupMenu.ts`).

### 5. Groups
- Closing a group's last tab removes the group; its siblings share the space proportionally; single-child splits collapse.
- The `main` editor region never disappears entirely: if the last editor-capable group closes, show the `welcome` view in its place. Welcome itself can be closed while another tab is on screen (a chat, the terminal); a file opened then gets an editor area of its own on the left (D368). With nothing on screen, Welcome comes back.
- **Focus:** exactly one active group. Clicking anywhere in a group focuses it. Focused group = lit chrome per DESIGN.md §1.2 and §12.3; others dim.
- **Maximize:** double-click a tab strip or `layout.toggleMaximize` → the group fills the dock (`--motion-deliberate` resize), others hidden; again to restore.
- Minimum group size: 160px wide, 80px tall (tab strip + 2 rows). Splitters can't shrink past it.
- Resizing: splitters per DESIGN.md §10 (6px hit area, 2px accent on hover/drag). Double-click a splitter → equalize siblings.

### 6. Keeping views alive when moved (important)
Moving a tab must **not** recreate its view.
- Monaco and the terminal: move the existing DOM node into the new group, then call `onResize()` (Monaco `layout()`, terminal fit).
- **Iframes reload when their DOM node moves.** Any view containing an iframe (browser preview, extension webview panels) must be rendered into a stable "iframe layer" outside the dock tree and absolutely positioned over its slot (ResizeObserver + rAF to track the slot's rect). The browser and extension pages use it; `dev.openIframeTest` is a test view that proves an iframe survives a move.
- Hidden (non-active) tabs are kept alive but detached from layout work (`display:none` + `onHide()`), never disposed until closed. A view whose tab leaves the tree some other way (a layout replaced, a transient tab left out) is disposed a microtask after the change (D379).
- Scroll offsets survive moves, closing and restarts (`scrollMemory`, D190). Chromium drops a hidden box's offsets, so they're put back when a tab moves to another group, when it comes back in front of its group's other tabs, and for every shown view after the tree is rebuilt (D370).
- A view whose `persist()` returns false (generated read-only text, test views, a terminal marked `transient`, D388) is left out of the saved tree and doesn't come back after a restart.

### 7. Commands (all through the dispatcher, all discoverable by agents)
| Command | Input | Notes |
|---|---|---|
| `layout.openView` | `{ viewType, state?, placement?: "main"\|"bottom"\|"right"\|{groupId}, focus?: boolean }` | Reuses a singleton if open |
| `layout.moveGroup` | `{ groupId, to }` (same targets as moveTab) | Moves a whole group: merge into a strip, split next to a group, or a dock edge |
| `layout.newTab` | `{ groupId?, kind? }` | Opens a file / terminal / browser / agent / … in a group (picker without `kind`) |
| `layout.moveTab` | `{ tabId, to: {groupId, index?} \| {groupId, split: "left"\|"right"\|"top"\|"bottom"} \| {root: side} }` | The same operation drag-and-drop performs |
| `layout.splitActive` | `{ direction?: "left"\|"right"\|"up"\|"down", groupId? }` | `Ctrl/Cmd+\` = right (the default) |
| `layout.focusGroup` | `{ direction: "left"\|"right"\|"up"\|"down" } \| { groupId }`, `focusView?` | `Ctrl/Cmd+K Ctrl/Cmd+Arrow` |
| `layout.moveTabToGroup` | `{ direction }` | `Ctrl/Cmd+Alt+Arrow` |
| `layout.closeTab` / `layout.closeGroup` | `{ tabId? }` / `{ groupId? }` (default: the focused group's) | Dirty-check editors |
| `layout.toggleMaximize` | `{ groupId? }` | |
| `layout.resizeGroup` | `{ groupId, size }` | Fraction of parent |
| `layout.equalize` | `{}` | |
| `layout.reset` | `{}` | Back to the default arrangement |
| `layout.toggleSidebar` | `{}` | `Ctrl/Cmd+B` |
| `layout.getTree` | `{}` | Same as `ide://layout` |

More layout commands (tab menus, windows, centered layout) are listed in `src/extensions/workbench/README.md`.

Keybinding behavior with a dynamic layout:
- `` Ctrl+` `` → if a terminal tab exists: focus it (reveal its group; if it's already focused, focus back to the last editor). If none: `layout.openView { viewType: "terminal", placement: "bottom" }`.
- `Ctrl/Cmd+J` → toggles the group that holds the most recent non-editor tab (terminal/problems/output): hide ↔ restore at the same size.
- `Ctrl/Cmd+L` → focus the agent view (open in `right` if none).
- `Ctrl/Cmd+Shift+P` palette, `Ctrl/Cmd+P` quick open, `Ctrl/Cmd+W` closes the active tab of the focused group (any view type).

### 8. State tree
`ide://layout` returns the tree with, per group: id, tab list (id, viewType, title, dirty), active tab, focused flag, size in px; plus `focusedGroupId`, `maximizedGroupId`, `sidebar: { visible, width, activeView }`. Budgeted like every provider.

### 9. Title bar layout toggles
Right side of the title bar: three 16px toggles — sidebar, "bottom" region, "right" region — mapped to `layout.toggleSidebar` and to hide/restore whatever groups currently occupy the bottom/right regions. They show as on/off (icon filled = on).

### 10. Movable sidebar views (D233)
A sidebar view whose descriptor says `movable` (Source control's Graph) can live in a dock tab
instead, as VS Code moves views between containers: `view.moveView { id?, to?: "sidebar" |
"dock", placement? }` (the palette's "Move view" asks which), dragging its section header or title
onto the dock (same zones as a tab), or its header's "Move to the dock". The tab is a
`sidebarView` view (`{ id }`) hosting the view's own instance; where the view is follows the
dock's tabs, so it's saved with the dock and closing the tab returns it. Dragging the tab onto the
sidebar, or its "Move back to the sidebar" button, moves it back. State: `ide://views/moved`.
