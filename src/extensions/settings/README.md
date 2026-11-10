# extensions/settings

The settings editor (`settings` dock tab, singleton; DESIGN.md §12.16; D121, reorganized in D179
after Cursor's): the navigation on the left has search on top, then groups of pages separated by
dividers (`pages.ts`: Appearance, Editor, Files and explorer, Search, Terminal | Agent, AI in the
editor, MCP server | Source control, Browser and network, Run and debug, Testing, Language
servers | Accounts, extensions' own pages), links that open elsewhere with a small ↗ (Keyboard
shortcuts, Models and providers, Extensions), and the open page's sections under it like a docs
page's contents. A page gathers categories; its settings are grouped in sections (a setting's
`section`, else its category), each a card with a small label above. The page title has User ·
Workspace, reset and `{}` beside it. A row: title (the schema's `title`, else derived from the
key), a small dot when changed, description, control on the right; rows are divided by inset
lines. Under 640 px the navigation is an icon rail and search moves above the page. `pages.ts`
(DOM-free, tested) maps categories to pages; `controls.ts` builds rows; `view.ts` the tab. An
extension's own settings share one page (`groupByExtension`, like VS Code's Extensions ›
<name>): a VS Code package's configuration titles become its sections, the page is named after
its one title or its keys' first word.

**Commands:** `settings.open` (Ctrl/Cmd+,; the ⚙ in the activity bar), `settings.openJson`,
`settings.set {key, value, scope}`, `settings.reset {key | keys | category | all, scope}`. The editor has Reset all (current scope; the agent's `agent.*` settings and the model providers stay unless checked, D166, D275), a reset button on changed sections and right-click menus on sections and rows.

**Rendering (D275):** a page builds about its first screens' rows (`EAGER_ROWS`) and each later
section when it scrolls near (an IntersectionObserver; until then its card holds about its
height); sections off screen skip style and layout (`content-visibility: auto`). Rows found by a
test or a command may not exist until their section is near: search for them, or scroll.

**Search filters** (VS Code's, `searchQuery.ts`, DOM-free and tested): `@modified` (changed in
the scope shown), `@id:editor.fontSize,editor.tabSize` (those keys), `@ext:builtin.terminal` or
`@ext:terminal` (what one extension contributes; schemas carry `extension` from
`toSettingSchemas`), `@tag:<tag>` (a schema's `tags`, plus `ai` for the agent's and AI features'
settings), `@lang:<language>` (D201: the settings a language can set for itself — the editor's
and the save-time `files.*` ones, `isLanguageSetting` — shown and edited as that language's values:
the rows read and write the scope's `"[language]": {…}` block, reset removes from it). Filters
combine, and the remaining words are searched as before. `settings.open {query}` takes them.

**Per language** (D201): `settings.set {key, value, scope, language}` and `settings.reset {key |
keys, scope, language}` write the block (`SettingsService.updateForLanguage`). Import from VS Code
and `settings.importVscode` keep language blocks (their settings that apply here), merged into the
user's block of that name.

**State:** `ide://settings` — file paths, every setting with value, source (default/user/workspace)
and schema, `languages` (each language with a block → the values it sets for itself),
`associations` (files.associations), and problems found in the files.

**VS Code** (D95): the folder's `.vscode/settings.json` is a layer under workspace settings
(`core/settings/vscode.ts` translates it); `settings.importVscode` copies VS Code's / Cursor's /
VSCodium's applicable user settings.

**Where settings live:** user settings in the app's config folder (Linux `~/.config/<identifier>/settings.json`,
macOS `~/Library/Application Support/<identifier>/settings.json`, Windows
`%APPDATA%\<identifier>\settings.json`; "Open settings (JSON)" opens it), workspace settings
written to the folder's own workspace folder (product.json `workspaceFolderName`, D177, D189),
and `<folder>/.vscode/settings.json` read too (under it).

`profile.ts`: `settings.exportProfile` / `settings.importProfile` — user settings, keybindings and
snippets in one file (`core/settings/profile.ts`, D130).

Import from VS Code (D193): `editorImport.ts` has the page (`settings.showImport`) and
`settings.importFromEditor`. Rust reads the other editor's User folder
(`settings_editor_profiles`); `core/settings/vscodeImport.ts` maps keybindings, extensions and
MCP configs (tested).

**Multi-root workspaces** (D251): the Workspace tab edits the workspace file's `settings`; a
Folder tab (with a folder picker when there are several) edits one folder's own
`<folder>/<IDE folder>/settings.json` (`SettingsService.updateAt`; `folderScope.ts` reads the
folder's layer, DOM-free parts tested). `settings.open`, `settings.openJson`, `settings.set` and
`settings.reset` take `scope: "folder"` and `folder` (a path or a folder's name; default: the
active file's folder, else asks); with one folder, "folder" is the workspace scope. Rows note the
folders that set a key themselves. `ide://settings` adds `folders: [{ name, path, settingsFile,
set }]` in a multi-root workspace.
