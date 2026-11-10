# Extensions

Extensions add to the IDE: color and icon themes, languages, snippets, tools, views, debuggers,
even agents and model providers. VS Code extensions from Open VSX install and run here, and you
can write your own (or ask the agent to). This page covers the Extensions view, installing from
Open VSX or a `.vsix`, what works of VS Code extensions, the permissions question, updates,
turning extensions off, the bundled ones, recommendations, and where to start writing one.

## The Extensions view

Open it with **Ctrl+Shift+X**, the blocks icon in the activity bar, or the gear → **Extensions**.

- The search box stays at the top. With it empty, the view lists **Installed** extensions,
  **Development** extensions (ones in the open folder), folders that are **Not loaded** (with
  why), and, when there are any, **Updates**.
- **Recommended** and **Open VSX** are sections below, which you can collapse and resize like the
  explorer's Outline and Timeline.
- Click an extension for its page. Its gear (or right-click) has its
  [actions](#manage-an-extension).

The view's header buttons are **Create extension…**, **Load unpacked…**, **Install from folder…**
and **Reload extensions**. Its **⋯** menu has:

| Menu item | What it does |
|---|---|
| **Update extensions from the store** | Installs newer versions of extensions from Open VSX |
| **Browse themes…** | Lists the most used color and icon themes on Open VSX |
| **Install from VSIX…** | Installs a `.vsix` package you downloaded |
| **Install from GitHub…** | Installs an extension from a repository (`owner/name` or a git URL) |
| **Browse official extensions…** | Lists the IDE's official extensions, once there's a repository of them |
| **Restore bundled extensions** | Brings back bundled extensions you uninstalled |

[Show extensions](command:extensions.show)

## Install from Open VSX

[Open VSX](https://open-vsx.org) is the open registry of VS Code extensions.

1. Type in the Extensions view's search box. After a moment, Open VSX's results show under your
   installed extensions, with their downloads, rating and, for a verified publisher, a blue
   check.
2. Click a result to see its page: README, features, changelog.
3. Press **Install**. The package is downloaded, checked against the checksum Open VSX
   publishes, and installed. Its **▾** offers **Install specific version…**.

### Search syntax

The search box understands VS Code's filters. Combine them with words, as in
`publisher:"Microsoft" python`. The filter button at the right of the box lists them.

| Filter | Shows |
|---|---|
| `publisher:"Name"` | A publisher's extensions. `publisher:"Microsoft"` covers its namespaces on Open VSX (`ms-python`, `ms-vscode`…) |
| `@category:"Name"` | A category (`Themes`, `Programming Languages`…) |
| `@tag:name` | Extensions with that keyword |
| `@id:publisher.name` | One extension |
| `@popular`, `@recentlyPublished` | Open VSX's most used, or newest |
| `@sort:installs`, `rating`, `name`, `publishedDate`, `updateDate` | Results in that order |
| `@installed`, `@enabled`, `@disabled`, `@builtin`, `@updates`, `@recommended` | Installed extensions only; Open VSX isn't asked |
| `ext:ts` | Installed extensions for that file type |

On an extension's page, click the publisher's name to see their other extensions, a category or
a tag to search for it, and the stars to read its reviews on Open VSX.

`@category:Themes` (or **⋯ → Browse themes…**) lists the most used themes.

> **Note:** Some of Microsoft's extensions, such as Dev Containers, Remote - SSH, Live Share and
> Pylance, aren't on Open VSX: their license allows them in Microsoft's VS Code only. The IDE
> has its own [remote development](19-remote.md) instead.

Nothing is fetched from Open VSX until you search, install, check for updates or open an
extension's page (and, while the view is shown, for the Recommended section).
`extensions.store.enabled` turns the store off: the search box then filters installed extensions
only.

### Install from a VSIX

**⋯ → Install from VSIX…** (or **Extensions: Install from VSIX…** in the command palette)
installs a VS Code extension package (`.vsix`) you downloaded. It's installed as one from Open
VSX would be.

### Other ways to install

- **Install from folder…** installs an extension from a folder on disk.
- **Install from GitHub…** installs one from a repository; **Update extension from its
  repository** (or **Update from repository** in its menu) fetches a newer version.
- **Load unpacked…** loads a folder without installing it, for development.

## What works of VS Code extensions

- **At once:** their color themes, file icon themes, product icon themes, languages with TextMate
  grammars, snippets and settings work as soon as they're installed.
- **Their code** runs in Node.js once you allow it (see
  [the install question](#the-install-question)). Most of VS Code's API is there; what isn't yet shows in the extension's log.
- An extension built per platform (Claude Code, say) gets this computer's build.
- Views VS Code puts in its secondary side bar open as a tab on the right, beside the agent.
- Their language features work in the editor: go to definition, references, rename, formatting,
  code actions, hovers, completions, signature help, CodeLens, inlay hints, semantic colors and
  more. Decorations (Error Lens, Better Comments, TODO highlighters), test controllers, debuggers,
  tasks, terminals, source control providers, sign-ins and file systems plug in as in VS Code.

The full list, with what's missing, is in the extension authoring guide (`docs/extensions.md` in
the IDE's repository, "Coverage versus VS Code").

### Node.js for extensions

Extensions whose code needs Node.js run in a Node process of their own, only in a trusted folder:
opening an untrusted folder stops their code until you trust it. They use Node.js 18 or newer if
it's installed. Without it, the IDE offers to download Node.js for extensions (about 30 MB from
nodejs.org, checked before use); **Extensions: Download Node.js for extensions** does it any time.

Extensions written for the IDE itself run in a sandbox instead, and can only do what they asked
permission for.

## The install question

Installing an extension that asks for permissions shows what it asks for, before anything is
installed:

- For code that runs in Node.js: it runs with your access to files and programs, like any program
  you install, so allow it only if you trust who made it.
- For a sandboxed extension: it can only do what you allow.
- If Node.js isn't on this computer, the question says so, and what happens next.

The buttons are **Allow and install** and **Cancel**. A VS Code extension with code also offers
**Install without its code**: its themes, languages and snippets work, and its code never runs.

An extension's dialogs say which extension asks. It asks you before it installs, updates or turns
off other extensions, and before it uses another extension's sign-in. **Review permissions…** in
its menu shows and changes what it may do; the settings it may read are on its **Permissions**
tab (never the agent's, AI, MCP, account, proxy or language server settings, or anything named
like a password or key).

> **Note:** extensions can't use your AI model unless you turn on
> `extensions.languageModelAccess`, and each one still asks once.

## Manage an extension

An extension's gear menu (or right-click, or its page) has VS Code's actions:

| Action | What it does |
|---|---|
| **Set color theme** / **Set file icon theme** | Applies a theme the extension brings |
| **Disable** / **Enable** | Turns it off or on everywhere |
| **Disable (workspace)** / **Enable (workspace)** | Turns it off or on in this workspace only |
| **Auto update** | Updates this extension by itself (wins over `extensions.autoUpdate`) |
| **Install specific version…** | Installs another version from Open VSX |
| **Reload** | Restarts it |
| **Show log** | Its log |
| **Reveal installed files** | Its folder in the file manager |
| **Copy**, **Copy extension ID**, **Copy link** | Copies its details |
| **Add to workspace recommendations** | Adds it to the folder's `.vscode/extensions.json` |
| **Download VSIX…** / **Download specific version VSIX…** | Saves its package |
| **Copy for development** | Copies it into the open folder to change it |
| **Edit with agent…** | Asks the agent to change it |
| **Uninstall…** | Removes it |

### The extension's page

Click an extension for its page: the README beside its details and links, then **Features**
(what it adds), **Settings** (its settings, live), **Files**, **Changelog**, **Permissions** and
**Log**. The **Open** button lists its tools and views.

### Where an extension's tools are

**View → Tools** lists every tool, the IDE's and extensions' (type to search a long list). The
**Open** button on an extension's page, and **New tab** in an editor group's ⋯ menu, list them too.
A sidebar view gets its own activity bar icon.

## Updates

When a newer version is out, the extension shows under **Updates** with an **Update** button, its
page leads with **Update to x.y.z**, and its gear menu starts with the same. **Update extensions
from the store** updates them all.

| Setting | Default | Description |
|---|---|---|
| `extensions.autoCheckUpdates` | `true` | A minute after start, check Open VSX for newer versions: a notice offers to update, and the Extensions icon shows how many |
| `extensions.autoUpdate` | `false` | Install newer versions by themselves |
| `extensions.updateDelayHours` | `24` | How long a new version must be out before it's offered (0: at once) |

Nothing is installed unless you choose to, or turn on auto update. A version that came out less
than `extensions.updateDelayHours` ago waits, and the newest version that's old enough is offered
instead: a version published by mistake, or by someone who took over the account, is usually
pulled by then. Installing a specific version isn't held back.

## Recommendations

With the search box empty, a **Recommended** section suggests extensions for the workspace: the
ones its `.vscode/extensions.json` names, and well-known ones for its kinds of files (Python, Go,
Rust, Docker…). Installed extensions aren't listed. **×** on a row hides that one for good
(`extensions.recommendations.ignored`); `extensions.recommendations.enabled` turns the section
off. With nothing to suggest (no folder open, for one), the section is **Popular** instead: a few
of the most used extensions (Prettier, ESLint, Python, Error Lens, Path IntelliSense), so it's
plain that the whole Open VSX store is there, not only the bundled extensions.

## Bundled extensions

The IDE comes with a few extensions you can turn on, change or uninstall:

| Extension | What it does | Starts |
|---|---|---|
| **Git tools** | GitLens-style extras for Source control: file blame beside the lines, the history of selected lines, comparing branches or tags, a Stashes section, GitHub notifications | On |
| **Jupyter** | Runs Jupyter notebooks' cells (finds each Python and its kernels) | Off |
| **TODO tree** | Lists the folder's TODO, FIXME, HACK, XXX, BUG and NOTE comments | Off |
| **Canvas** | A board you and the agent share (see below) | Off |

Turn one on from the Extensions view. **Restore bundled extensions** (in the view's ⋯ menu) brings
back ones you uninstalled; **Go back to the IDE's version…** undoes your changes to one you
copied for development.

**Canvas** is a board of Markdown cards, file and link cards, groups and arrows, saved as
`.canvas` files (the JSON Canvas format Obsidian uses):

- **Open it:** click the Canvases icon in the activity bar, or open any `.canvas` file.
- **Draw:** double-click to add a card; drag a card's edge dot to draw an arrow.
- **With the agent:** ask it to "map the modules on the canvas", or to read what you sketched.
  Its changes light up, and Ctrl+Z undoes them.

See [Notebooks](15-notebooks.md) for Jupyter.

## Notebooks and programs from extensions

An extension can add a notebook format of its own (its files open in the notebook editor, with
cells, outputs and the Variables panel) and kernels that run cells, for its own notebooks or for
Jupyter ones.

Extensions can also run programs of their own (a notebook kernel, a tool's server) when you allow
"Run programs" and trust the folder. They stop when you disable the extension, close the folder or
put it in restricted mode.

## Write your own extension

- **Ask the agent:** "add a word counter to the status bar". It builds an extension for you with
  its built-in build-extension skill. Changing the IDE asks you first, even with full access;
  allow it for the chat to stop the questions.
- **Create extension…** (the view's header) writes a starter extension into the open folder.
- **Install permanently** (on its page, or right-click its folder in the explorer) turns a
  development extension into an installed one.

Extensions written for the IDE can add commands, views, settings and keybindings, pages in the
editor area or in their own window, viewers for file types, status bar items, menu items, editor
hovers, completions, highlights and problems, and agents, MCP servers and model providers. They
run in a sandbox and ask for permissions.

The extension authoring guide (`docs/extensions.md` in the IDE's repository) has the manifest,
the API and examples; the agent reads the same guide when it builds one. A few things authors ask
about:

- **Tree row menus:** give items a `contextValue` and add commands under
  `menus["view/item/context"]` with `when` clauses such as `view == my.view && viewItem == task`.
  `group` orders them and `"inline"` makes one a button on the row; the command receives
  `{ item }`.
- **Output channels:** `ide.ui.createOutputChannel(name)` gives an extension its own channel in
  the Output tab (`appendLine`, `info` / `warn` / `error`, `clear`, `show`).
- **Terminals, tasks, source control, debuggers, sign-ins and file systems** plug in as VS Code
  extensions do: an extension's tasks join **Run task** as "type: name", its debugger's starter
  configurations join **Add configuration…**, and files of its URI scheme open and save in the
  editor and show in a section of the explorer.

## Troubleshoot extensions

- **Extensions: Show extension log** (or **Show log** in its menu) shows what an extension logged,
  including VS Code API calls that aren't supported yet.
- **Help: Restart with extensions off** starts the IDE once without any installed or bundled
  extension, to tell whether one causes a problem; **Restart with extensions on** goes back.
- **Help: Start extension bisect** finds the extension behind a problem by turning half of them
  off at each restart and asking whether the problem is still there.

See [Troubleshooting](21-troubleshooting.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `extensions.store.enabled` | `true` | Search, install and update VS Code extensions from Open VSX |
| `extensions.autoCheckUpdates` | `true` | Check for newer versions a minute after start |
| `extensions.autoUpdate` | `false` | Install newer versions by themselves |
| `extensions.updateDelayHours` | `24` | How long a new version must be out before it's offered |
| `extensions.recommendations.enabled` | `true` | The Recommended section |
| `extensions.languageModelAccess` | `false` | Let extensions use your language model (each still asks once) |

[Open settings](command:settings.open)

## Common questions

### An extension installed but its features don't work.

If it has code, check that you allowed it (**Review permissions…**), that the folder is trusted,
and that Node.js is available. Its log (**Show log**) shows API calls the IDE doesn't support yet.

### Can I use the Visual Studio Marketplace?

No: extensions come from Open VSX, or from a `.vsix` you download yourself.

### Where do extension themes show up?

In the color theme and file icon theme pickers, with the bundled ones. See
[Settings, themes and profiles](16-settings-themes.md#color-themes).

## Next steps

- [Settings, themes and profiles](16-settings-themes.md): themes from extensions.
- [Customizing the agent](07-agent-customize.md): skills, MCP servers and agents.
- [Troubleshooting](21-troubleshooting.md): extensions off and bisect.
