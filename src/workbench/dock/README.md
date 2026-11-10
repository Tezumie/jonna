# workbench/dock

The DOM side of the dock (docs/dock.md). The tree itself and every tree operation are DOM-free in
`src/core/dock/`.

- `model.ts` — `DockModel`: the tree signal, focused group, live views (created lazily per tab, kept
  alive across moves, disposed only when the tab closes), most-recently-used order, ids.
- `service.ts` — `DockService extends DockModel`: open (placement hints, singletons), move, activate,
  close (views may veto: unsaved changes), welcome fallback, maximize, hide/restore regions, resize,
  equalize, reset, serialize/restore. Wrapped 1:1 by `layout.*` commands. Unit-tested with fake views.
- `views.ts` — the view-type contract (`DockViewDescriptor`, `DockView`) extensions register.
- `render.ts` — `DockRenderer`: builds splits/cells/sashes when the tree's *shape* changes, otherwise
  only updates sizes; splitter drag previews with flex and commits once (`layout.setSplitSizes`).
- `group.ts` — one group: tab strip (DESIGN.md §12.3) + body; moves view elements, never recreates.
  A tab click activates on the first click even when another group has focus.
- **Tab actions**: a view type (`DockViewDescriptor.actions`) or live view (`DockView.actions`) adds
  buttons to its group's toolbar while active (`TabAction`: icon, title, command, input); split
  is hidden where it would do nothing.
- **Tab options (D279)**: `DockModel.tabOptions` (set from VS Code's workbench.editor.*
  settings by the workbench extension's `tabOptions.ts`): problem and git colors and badges on
  tabs, the close button's side or none, pinned tabs (first, with a pin that unpins; on their own
  row with `pinnedTabsOnSeparateRow`), tabs on an editor group's side (`tabPlacement`), the tab
  limit (`applyTabLimit`), and the most recently used tab after closing the active one. The strip
  can also start with Go back / Go forward (`navigationControlLocation` "tabBar").
- `tabMenu.ts` — the tab context menu (close variants, copy path, reveal, open changes, pin, split).
- `groupMenu.ts` / `newTab.ts` — the group menu (strip right-click and ⋯): New tab, split four
  ways, new file, tabs, maximize, close saved, close group.
- `dnd.ts` — drag and drop of tabs, whole groups, explorer files and movable sidebar views (a
  section header or view title, D233: dropped, `view.moveView`): zones, ghost, animated preview,
  Escape cancels. Tab targets outside the dock (the sidebar takes back a moved view's tab) are
  checked before the dock's zones.
- `lift.ts` — a dragged group: the live element shrinks toward the pointer (aspect kept), then
  glides into its new slot (FLIP); browser iframes follow (D97).
- `iframeLayer.ts` — iframes live outside the dock, positioned over a slot, so moves don't reload
  them; inside a lifted group they take the group's transform.
- `keepRightWidth.ts` (tested) — the agent's column keeps its width in pixels when the dock is
  resized; the editor area takes the difference (D164).
