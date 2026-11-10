# Settings, themes and profiles

Almost everything about the IDE can be changed in Settings: how the editor behaves, how the
window looks, what the agent may do. This page covers the Settings page and `settings.json`,
user, workspace and folder settings, settings for one language, color, file icon and product icon
themes, color customizations, the window's look (density, panel style, side bar color, tab style,
zoom), fonts, and moving your setup between machines with profiles and the VS Code import.

## Open Settings

- Press **Ctrl+,**, or click the gear at the bottom of the activity bar and choose **Settings**.
- **File → Preferences → Settings** does the same.

[Open settings](command:settings.open) · [Open settings (JSON)](command:settings.openJson)

### The Settings page

The navigation on the left has the search box on top, then the pages in groups: **Appearance**,
**Editor**, **Files and explorer**, **Search**, **Terminal**; the agent and AI pages; **Source
control**, **Browser and network**, **Run and debug**, **Testing**, **Language servers**;
**Accounts**, and extensions' own pages (an extension's settings share one page). **All
settings** shows every setting, page by page. Entries with a small ↗ open a page of their own
(**Keyboard shortcuts**, **Models and providers**, **Extensions**). The open page lists its
sections under it, so you can jump to one.

Each setting is a row: its title and description, and the control on the right. A small dot marks
a setting you changed; the row's reset button (and right-click) sets it back. A section with
changes has its own reset button.

In a narrow window the navigation becomes a column of icons and the search box moves above the
page.

### Search settings

Type in the search box to find settings by title, key or description. The search takes VS Code's
filters:

| Filter | Shows |
|---|---|
| `@modified` | The settings you changed (in the scope shown) |
| `@id:editor.fontSize,editor.tabSize` | Those exact keys |
| `@ext:builtin.terminal` (or `@ext:terminal`) | What one extension adds |
| `@tag:ai` | Settings with a tag (`ai`: the agent's and AI features') |
| `@lang:python` | The settings a language can set for itself, as that language's values |

Combine them with words: `@modified font`.

### Reset settings

- A row's reset button sets that setting back to its default.
- **Reset all** (the ↺ beside the page title) resets every setting in the scope shown. It keeps
  the agent's settings (its models, agents and their choices) unless you check **Also reset the
  agent's settings**.

## User, workspace and folder settings

Settings apply at several levels, the later winning:

1. **Default:** the IDE's own values.
2. **User:** yours, for every folder you open.
3. **Workspace:** for the open folder (or the workspace, with several folders).
4. **Folder:** with several folders in the window, one folder's own.

**User** · **Workspace** (and **Folder**, in a workspace with several folders, with a picker for
the folder) sit beside the page title: pick which level you're changing. A row notes the folders
that set a key themselves.

- User settings are in your user configuration folder; **Open settings (JSON)** opens the file.
- Workspace settings are saved in the IDE's own folder in the project, beside its tasks, launch
  configurations, snippets and the agent's memory. With several folders, workspace settings are
  the workspace file's `settings`, and each folder can have its own.
- A project's `.vscode/settings.json` is read too, under the workspace settings, but never
  created. Where the IDE's folder and `.vscode` have the same file or setting, the IDE's own
  wins; the explorer offers to merge `.vscode` into it.
- Some settings are user settings only, such as the programs the debugger runs: a folder can't
  choose a program to run.

### settings.json

Every setting is also in `settings.json`. The `{}` button beside the page title opens the file of
the scope shown. It's JSON with comments:

```json
{
  // The editor
  "editor.fontSize": 15,
  "editor.formatOnSave": true,
  "workbench.colorTheme": "Light+"
}
```

Problems found in the file are reported.

### Settings for one language

Some settings can differ by language, as in VS Code. Write them in a block named after the
language, or several languages at once:

```json
{
  "[python]": { "editor.tabSize": 4, "editor.formatOnSave": true },
  "[javascript][typescript]": { "editor.tabSize": 2 }
}
```

The block wins over the plain setting, in user and workspace settings alike. Editor options, tab
size, format and code actions on save, and the save-time file settings (trim trailing whitespace,
final newline, line endings, encoding) can be set per language.

In the Settings page, search `@lang:python` to see and change Python's own values: what you change
there goes into the `[python]` block, and the reset button takes it out again.

### File types

`files.associations` tells the IDE which language a file is:

```json
{
  "files.associations": {
    "*.mdx": "markdown",
    "Dockerfile.*": "dockerfile",
    "**/templates/*.html": "jinja"
  }
}
```

A pattern with a `/` is matched against the path. The language decides syntax colors, its
settings and which language server opens the file.

## Color themes

A color theme colors the whole IDE, not only the code.

- **Claude Dark** is the default. It has a second accent, a blue, for selection in lists, resize
  handles and drop targets.
- **Dark+** and **Light+** are VS Code's default themes, built in.
- Shiki's themes are bundled: Dracula, Nord, GitHub, One Dark Pro, Monokai, Night Owl, Catppuccin,
  Gruvbox, Ayu and more.
- VS Code themes from extensions work too. **Extensions → ⋯ → Browse themes…** lists the most
  used ones on Open VSX. See [Extensions](18-extensions.md).

To pick one:

- **Preferences: Color theme…** in the command palette, or the gear → **Themes** → **Color
  theme…**.
- The **Color theme** dropdown on the **Appearance** page of Settings.
- The gear → **Themes** → **Dark+** / **Light+**, or **Preferences: Toggle light/dark theme**.

In Settings' list, bundled themes end in "(built in)". When an installed extension has a theme of
the same name as a bundled one, the extension's is the one listed and used: you installed it on
purpose.

Parts of the window that a theme makes too dark or too light for their text (a dark title bar in a
light theme) follow the built-in theme instead, so text stays readable.

[Pick a color theme](command:ui.selectColorTheme)

### Follow the system's light or dark mode

To switch themes with your system:

1. Turn on `window.autoDetectColorScheme`.
2. Pick `workbench.preferredDarkColorTheme` (Claude Dark by default) and
   `workbench.preferredLightColorTheme` (Light+ by default).

While it's on, these two replace `workbench.colorTheme`.

### Customize a theme's colors

`workbench.colorCustomizations` paints over the theme. It takes the IDE's design tokens or VS
Code's color ids (`titleBar.activeBackground`, `activityBar.background`, `statusBar.background`
and their foregrounds, as the Peacock extension writes them; `editor.background`, `focusBorder`…).
A `"[Theme name]"` block applies only under that theme.

```json
{
  "workbench.colorCustomizations": {
    "--accent": "#5FB3A1",
    "statusBar.background": "#1E3A5F",
    "[Light+]": { "editor.background": "#FAFAF7" }
  }
}
```

A folder's value is merged over the user's, so a project can give its window a color of its own.

## File icon themes

The file icon theme draws the icons beside files in the explorer, tabs and quick access.

- **Material Icon Theme** (built in, the default) or **Minimal** (the IDE's own small set).
- VS Code icon theme extensions work too.

Pick one with **Preferences: File icon theme…**, the gear → **Themes** → **File icon theme…**, or
the dropdown in Settings. Folder icons are off by default: `explorer.folderIcons` (**Explorer →
Folder icons**) turns them on, with any icon theme.

[Pick a file icon theme](command:ui.selectFileIconTheme)

## Product icon themes

A product icon theme redraws the IDE's own icons: the activity bar's, views' and editors' actions
and the status bar's. **Default** is the IDE's own icons; a VS Code product icon theme extension
brings a font of its own. Pick one with **Preferences: Product icon theme…**
(`workbench.productIconTheme`).

[Pick a product icon theme](command:ui.selectProductIconTheme)

## The window's look

The **Appearance…** menu (**File → Preferences → Appearance…**, or **Preferences: Appearance…**
in the command palette) has the light or dark theme, density, panel style, side bar color and tab
style in one place. **View → Appearance** has the theme, density and panel style beside the
layout toggles. Each is also a setting on the **Appearance** page of Settings.

| Setting | Default | Description |
|---|---|---|
| `workbench.density` | `"default"` | Row, tab and control heights: `compact`, `default` or `comfortable` (also the gear → **Layout density**) |
| `workbench.panels` | `"flush"` | `flush`: one shell color with 1px dividers. `floating`: panels as cards with gaps |
| `workbench.sideBarColor` | `"matching"` | `matching` the panels, or `distinct`: the color theme's own side bar color, with either panel style |
| `workbench.tabStyle` | `"rounded"` | `rounded`; `classic` square tabs with the accent along the active one's top; `connected`, where the active tab joins the editor under a strip of another color |
| `workbench.scrollbarSize` | `10` | Width in pixels of scrollbars outside the editor and terminal |
| `window.zoomLevel` | `0` | Zoom of the whole window: each step is 20 % (Ctrl+= / Ctrl+-, Ctrl+Numpad0 resets) |

The tabs have more options (decorations, pinned tabs, a limit on open tabs, where the tabs are);
see [User interface](03-user-interface.md).

## Fonts

| Setting | Default | Description |
|---|---|---|
| `editor.fontFamily` | `""` | The editor's font (a CSS font list). Empty: the system's code font, as in VS Code (Consolas on Windows, Menlo on macOS, Droid Sans Mono on Linux) |
| `editor.fontSize` | `14` | The editor's font size in pixels |
| `editor.lineHeight` | `0` | Line height in pixels (or a multiple of the font size below 8). 0: 1.35 × the font size (1.5 on macOS) |
| `editor.fontWeight` | `"normal"` | The editor's font weight |
| `editor.fontLigatures` | `false` | Use the font's ligatures |
| `editor.mouseWheelZoom` | `false` | Ctrl + mouse wheel changes the editor's font size |
| `terminal.fontFamily` | `""` | The terminal's font. Empty: the editor's monospace font |
| `terminal.fontSize` | `13` | The terminal's font size in pixels |
| `terminal.lineHeight` | `1.25` | The terminal's line height, as a multiple of the font size |
| `markdown.preview.fontFamily` | `""` | Markdown previews' font (`"Georgia, serif"`). Empty: the interface font |
| `markdown.preview.fontSize` | `14` | Markdown previews' font size in pixels |
| `markdown.preview.lineHeight` | `1.6` | Markdown previews' line height |

The interface's own font has no setting; to make the whole window larger or smaller, use the
zoom (Ctrl+= / Ctrl+-).

## Profiles

A profile is your user settings, keyboard shortcuts and snippets in one file, to move them to
another machine.

- **Preferences: Export profile…** saves them to a file you choose. API keys are never in it.
- **Preferences: Import profile…** replaces your settings, keyboard shortcuts and snippets with a
  profile's, after asking. Snippet files that aren't in the profile are kept.

Both are also in the gear's **Profiles** menu and **File → Preferences**.

[Export profile](command:settings.exportProfile) · [Import profile](command:settings.importProfile)

## Import from VS Code

**Help → Import from VS Code…** (also under **File → Preferences**, and a link on the Welcome
page) reads VS Code, VS Code Insiders, Cursor, VSCodium or Windsurf on this computer, or a folder
you choose. It shows, part by part, what it would bring:

- **Settings**, the color theme and per-language blocks included.
- **Keyboard shortcuts**, VS Code's commands matched to the IDE's.
- **Snippets.**
- **MCP servers.**
- **Your extensions:** which are built in here, which a setting turns on, and which aren't
  available yet.

Untick what you don't want, then press **Import**. Your own settings are kept where both have
one, unless you tick "use theirs". A project's `.vscode/settings.json` needs no import: it's read
as it is.

[Import from VS Code](command:settings.showImport)

## Settings sync

Settings sync through an account isn't available yet. Until it is, the **Accounts** menu (the
person icon above the gear) has **Backup and sync settings…**, which exports or imports a
[profile](#profiles).

## Common questions

### Where is my settings.json?

In your user configuration folder; **Preferences: Open settings (JSON)** opens it. A folder's
settings are in the IDE's own folder in the project; the `{}` button on the Settings page opens
whichever scope is shown.

### I changed a setting but nothing happened.

A workspace or folder setting may be overriding it: switch the Settings page to **Workspace** (or
**Folder**) and look for the dot. A `[language]` block also wins over the plain setting for that
language.

### Can I have several named profiles and switch between them?

Not yet. Profiles are export and import of one set of settings, keyboard shortcuts and snippets.

## Next steps

- [Keyboard shortcuts](17-keyboard-shortcuts.md): change any key.
- [Extensions](18-extensions.md): themes and icon themes from Open VSX.
- [User interface](03-user-interface.md): the layout, tabs and panels.
