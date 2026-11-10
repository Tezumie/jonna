# extensions/workbench

Layout, appearance and window commands, the `welcome` dock view, dock + sidebar persistence per
workspace, `ide://layout` and `ide://perf`.

- `layoutCommands.ts` — `layout.openView`, `moveTab`, `splitActive` (Ctrl/Cmd+\), `focusGroup`
  (Ctrl/Cmd+K Ctrl/Cmd+Arrow), `focusTab`, `moveTabToGroup` (Ctrl/Cmd+Alt+Arrow), `closeTab`
  (Ctrl/Cmd+W), `closeGroup`, `toggleMaximize`, `resizeGroup`, `setSplitSizes`, `equalize`, `reset`,
  `nextTab`/`previousTab` (Ctrl+PageDown/PageUp), `moveGroup` (dragging a group by its strip),
  `newTab` (the group menu's New tab, `workbench/dock/newTab.ts`).
- `regionCommands.ts` — `layout.toggleSidebar` (Ctrl/Cmd+B), `toggleRegion` (title-bar toggles),
  `togglePanel` (Ctrl/Cmd+J), `focusAgent` (Ctrl/Cmd+L), `getTree`, `view.show`, `view.toggle`;
- `statusBarCommands.ts` — `workbench.toggleStatusBar` (`workbench.statusBar.visible`),
  `statusBar.setItemHidden` (`workbench.statusBar.hidden`, the status bar's right-click menu,
  D383), `ide://statusbar`.
- `appearance.ts` — `window.autoDetectColorScheme` (D279: `workbench.preferredDarkColorTheme` /
  `preferredLightColorTheme` follow the system's mode), `ui.setTheme`, `ui.toggleTheme`, `ui.selectColorTheme`, `ui.setDensity`,
  `ui.setPanelStyle` (they write the `workbench.*` settings; `workbench.colorTheme` is the one theme
  setting, "Dark+" / "Light+" built in, D135) and the appearance menu; applies settings and
  `workbench.colorCustomizations` to the theme: our tokens or VS Code color ids, user, the
  folder's `.vscode` and workspace layers merged, `"[Theme]"` blocks
  (`core/themes/customizations.ts`, tested); Peacock's title bar, activity bar and status bar
  colors are tokens of their own (`--bg-titlebar`, `--bg-activitybar`, `--bg-statusbar`…) that
  `colorCustomizations.css` gives those bars.
- `manageMenu.ts` — the activity bar's gear (`workbench.showManageMenu`, D134): VS Code's Manage
  menu — command palette, profiles, settings, extensions, keyboard shortcuts, snippets, tasks,
  Themes and Layout density submenus. Color and file icon themes are dropdowns in Settings too
  (`settings.registerChoices`); bundled color themes say "(built in)" there, and an extension's
  theme wins over a bundled one of the same name (D282).
- `iconThemes.ts` — file icon themes (`workbench.iconTheme`, `ui.selectFileIconTheme`, D132):
  Material Icon Theme (bundled by build.mjs), Minimal, and extensions' VS Code icon themes; drawn by
  `workbench/fileIcons.ts`. `shikiThemes.ts` — Shiki's bundled color themes as color themes.
- `menus.ts` — title-bar menus (File, Edit, View, Go, Git, Terminal, Help) as command lists with
  submenus (Open recent, Preferences): `ui.showMenu`, `ui.showAppMenu` (☰); once one is open,
  hovering another title switches to it.
- `tabCommands.ts` — `layout.closeOtherTabs`, `layout.closeTabsToRight`, `layout.closeSavedTabs`,
  `layout.closeAllTabs` (each leaves pinned tabs; Close all closes them once only they're left),
  `layout.pinEditor` / `layout.unpinEditor` (Ctrl/Cmd+K Shift+Enter, VS Code's Pin, D279),
  `layout.copyTabPath` (the tab context menu, `workbench/dock/tabMenu.ts`), `layout.reopenClosedTab`
  (Ctrl+Shift+T, D111).
- `tabOptions.ts` (D279) — VS Code's tab settings (`workbench.editor.decorations.colors` /
  `.badges`, `tabActionLocation`, `tabActionCloseVisibility`, `pinnedTabsOnSeparateRow`,
  `limit.*`, `focusRecentEditorAfterClose`) and our `workbench.editor.tabPlacement` → the dock's
  `tabOptions`; the `activeEditorIsPinned` context key.
- `index.ts` also has the window commands (`window.minimize`, `window.toggleFullscreen`,
  `workbench.about`), UI zoom (`window.zoomIn/zoomOut/zoomReset`, `window.zoomLevel`), the README
  shown on a folder's first open (`workbench.openReadme`), `workbench.hideImportLink` (the welcome
  page's "Import from VS Code" link, D194) and two helpers for pages and menus, `ui.copyText` and
  `ui.openLink` (http(s) and mailto only).
- `auxCommands.ts` — `layout.moveToNewWindow`, `layout.returnFromWindow`,
  `layout.returnAllWindows`, `layout.focusWindow`: a tab in a window of its own (D101).
- `trustCommands.ts` — workspace trust (D103): `workspace.manageTrust`, `workspace.setTrust`,
  `workspace.trust`, a status bar item in restricted mode, `ide://workspace/trust` (with
  `inheritedFrom`). D200: the trust dialog shows when a folder the user hasn't decided about
  opens (`security.workspace.trust.startupPrompt`: `once` default, `never`; not in test runs),
  with "Trust the authors of all files in the parent folder"; `workspace.setTrust {parent}`.
- `riskyFolderCommands.ts` — the risky-folder caution (D213): before Downloads (or a folder in
  it), the home folder, the Desktop, temp or a drive root opens, a dialog explains the risk and
  offers restricted mode (default), trust or cancel, with "Don't ask again for this folder"
  (`security.warnRiskyFolders`, default on; `security.riskyFolders` adds folders).
  `workspace.resetRiskyFolderWarnings`, the test hook `security.setTestDownloadsFolder`
  (`{ path, open }`), `ide://security/riskyFolders`; `ide://workspace` and
  `ide://workspace/trust` carry `risky`.
- `followRenames.ts` — tabs showing a file follow it when it's renamed and close when it's deleted
  (D187, D189). `progress.ts` — the progress line on a view while its commands run (D118).
- `notificationCommands.ts` — the status bar bell: `notifications.show` (the list),
  `notifications.clear`, `notifications.toggleDoNotDisturb`, `ide://notifications`.
- `views.ts` — the welcome tab (logo, actions, recent folders; DESIGN.md §12.17).
- `index.ts` — window commands, `workbench.screenshot` (D96), `workbench.startupTimings`,
  persistence, state paths.

- Settings: `workbench.colorTheme`, `workbench.iconTheme`, `workbench.density`,
  `workbench.panels`, `workbench.scrollbarSize`, `workbench.sideBar.location`,
  `workbench.activityBar.hidden` / `.order`, `workbench.statusBar.visible`,
  `workbench.editor.enablePreview`, `workbench.view.alwaysShowHeaderActions` (on by default,
  D196).
- View → Tools, the extension page's Open button and New tab list every extension's views and `menubar/view` commands (`ExtensionFeatures.allOpeners`, D182).
- Updates (D192): `updates.ts` has `update.check`, `update.install`, `ide://update` and the quiet
  daily check (`update.mode`); the Rust side is `src-tauri/src/update`, and docs/releasing.md has
  the release and signing setup. `update.channel` (stable / beta, D204) picks the endpoint;
  About shows it.
- Centered layout (D192): `layout.toggleCenteredLayout` / `workbench.editor.centeredLayout` puts
  `.is-centered-layout` on the workbench; text editors keep `--centered-layout-width`.
