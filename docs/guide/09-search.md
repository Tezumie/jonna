# Search

The IDE searches the way VS Code does: a find widget for the file you're in, the **Search** view
for every file in the folder (with replace), search editors that keep a search open in a tab, and
a quick text search in the quick access box. This page covers each of them, from finding a word
in one file to regular expressions across lines and folders.

## Find and replace in a file

Press **Ctrl+F** in an editor to open the find widget, or **Ctrl+H** to open it with the replace
field. Matches are highlighted as you type, and the widget shows how many there are. Both are also
in the **Edit** menu (**Find**, **Replace**).

| Keys | What it does |
|---|---|
| Ctrl+F | Find |
| Ctrl+H | Find and replace |
| Enter / Shift+Enter | Next / previous match (in the find field) |
| F3 / Shift+F3 | Next / previous match |
| Alt+Enter | Select every match (one cursor each) |
| Alt+C | Toggle match case |
| Alt+W | Toggle match whole word |
| Alt+R | Toggle regular expression |
| Alt+L | Toggle find in selection |
| Alt+P | Toggle preserve case (replace) |
| Ctrl+Shift+1 | Replace this match |
| Ctrl+Alt+Enter | Replace all |
| Escape | Close the widget |

With text selected, Ctrl+F starts with the selection. **Ctrl+D** adds the next match of the
selection as another cursor, and **Ctrl+Shift+L** selects every match: see
[Multiple cursors](04-editing.md#multiple-cursors).

Other views have a find of their own:

- **Markdown previews:** Ctrl+F with the preview focused (see
  [Markdown preview](04-editing.md#markdown-preview)).
- **Notebooks:** Ctrl+F finds across every cell, and Ctrl+H adds replace (see
  [Find and replace in a notebook](15-notebooks.md#find-and-replace-in-a-notebook)).
- **Terminals:** Ctrl+F finds in the output (see [Terminal](10-terminal.md)).

## Search across files

Press **Ctrl+Shift+F** (**Edit → Find in files**), or click **Search** in the activity bar. The
query starts with the editor's selection; with nothing selected and `search.seedWithNearestWord`
on, it starts with the word at the cursor. Results fill in as you type
(`search.searchOnType`, after `search.searchOnTypeDebouncePeriod`, 300 ms); turn that off to search
on Enter.

Results are grouped by file. Click a line to open it in a preview tab, with the cursor at the
match.
The message under the fields says how many results there are in how many files, and when the
search stopped at the result limit (`search.maxResults`, 20 000).

### Search options

The query field has three toggles:

- **Match case** (Aa).
- **Match whole word**.
- **Use regular expression**: Rust regular expressions (the same engine as ripgrep). In the
  replacement, `$1`, `$2`… insert the groups.

With `search.smartCase` on, a query with an uppercase letter matches case and an all-lowercase
query ignores it.

### Choose which files to search

**Files to include** and **Files to exclude**, under the query, take comma-separated globs or
folders, such as `src`, `*.ts` or `src/**/*.test.ts`.

- The **Search only in open editors** button (a book) in **Files to include** limits the search to
  the files open in tabs.
- The **Use exclude settings and ignore files** button (a filter) in **Files to exclude** is on by
  default. Turn it off to search what `search.exclude`, `files.exclude` and the ignore files
  normally hide.
- `search.exclude` skips files and folders on top of `files.exclude`. By default it skips
  `node_modules`, `bower_components` and `.code-search` files.
- With `search.useIgnoreFiles` on (the default), files listed in `.gitignore` and `.ignore` are
  skipped.
- Right-click a folder in the Explorer → **Find in folder…** to search only that folder, or
  right-click a result → **Exclude folder from search** to leave its folder out.

```json
{
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/*.min.js": true
  }
}
```

### Replace across files

1. Click the arrow at the left of the query field (**Toggle replace**) to show the **Replace**
   field. **Ctrl+Shift+H** (**Edit → Replace in files**) also opens the Search view.
2. Type the replacement. The results show each change in place: the match struck through and the
   new text beside it.
3. Replace everything with **Replace all** beside the field, one file with the **Replace all in
   this file** button on its row, or one result with right-click → **Replace**.

Replace all asks first, saying how many files it changes. The files are changed on disk, and
the whole replacement is one undo step: **Edit → Undo** (or Ctrl+Z in the Explorer) reverts it,
and Ctrl+Z in one of the changed files asks whether to undo it in all of them or only that one.

**Preserve case** (the toggle in the replace field) keeps the case of each match: replacing `foo`
with `bar` turns `Foo` into `Bar` and `FOO` into `BAR`.

### Work with the results

- **Dismiss** (the ✕ on a row) hides a file or a line from the results until the next search.
- **View as tree / list** (the view's header) groups the results by folder, with single-child
  folders compacted, or shows a flat list of files. `search.defaultViewMode` (`list`) is the start
  in a folder you haven't switched yet.
- The header also has **Search again**, **Open in a search editor**, **Clear search results**,
  **Collapse all** and **Expand all**.
- Right-click a result for: **Open**, **Open to the side**, **Replace** (while replacing),
  **Dismiss**, **Copy** (the line, or the file's results), **Copy path**, **Copy relative path**,
  **Copy all**, **Reveal in explorer**, **Reveal in file manager**, **Find in folder…**, **Exclude
  folder from search**, **Collapse all** and **Expand all**.
- `search.collapseResults` decides whether files start expanded, and `search.showLineNumbers`
  whether line numbers show.

### Search history

Press **Up** and **Down** in the query, replace, include or exclude field to walk what you
searched or typed there before. The history is kept per folder. A query is remembered when you
press Enter, leave the field, or open a result.

### Regular expressions across lines

With **Use regular expression** on, `\n` matches a line break, so a pattern can span lines:
`foo\(\n\s*bar` finds `foo(` with `bar` at the start of the next line. A result shows the line
where its match starts. Replace works across lines too, and Windows line endings (CRLF) match `\n`
as well.

### Several folders in one workspace

In a workspace with several folders, every folder is searched, each with its own
`search.exclude` and `files.exclude`. A folder's results are grouped under its name. An include
or exclude glob that starts with a folder's name (`api/**`, `./api/src`, or just `api`) applies to
that folder only; other globs apply in every folder. See
[Workspaces and trust](20-workspaces.md).

## Search editors

A search editor shows a search in an editor tab: the query, its toggles, the include and exclude
fields and the number of context lines on top, and the results below as a document with
numbered lines and the matches marked.

- Open one with **New search editor** (Command Palette) or the **Open in a search editor** button
  in the Search view's header, which takes the view's current query.
- Press Enter in a field (or **Search again in search editor**) to run the search.
- The **−** and **+** buttons set how many lines of context show around each match (0 to 10; a new
  one starts with `search.searchEditor.defaultNumberOfContextLines`, 1).
- Click a result line to go there.
- Several search editors can be open at once, each keeping its own search.
- **Save search editor** saves it as a `.code-search` file, VS Code's format. Opening the file
  runs its search again.

[New search editor](command:search.openEditor)

## Quick search in quick access

For a quick look without the Search view, open quick access (Ctrl+P), type `%` and then your
text, or run **Quick search…**. It lists matching lines from the folder's files, up to 100, with
the same excludes and smart case as the Search view. Enter opens the line. See
[Quick access](02-quick-access.md).

[Quick search](command:quickOpen.quickTextSearch)

## Commands

| Command | Keys | What it does |
|---|---|---|
| **Search in files** | Ctrl+Shift+F | Show the Search view, starting with the selection |
| **Replace in files** | | Replace the matches of the current search |
| **Find in folder** | | Search only one folder (from the Explorer's menu) |
| **Exclude folder from search** | | Leave a result's folder out of the search |
| **View search results as tree / list** | | Group results by folder, or not |
| **Collapse all search results** / **Expand all search results** | | Fold or unfold every file |
| **Copy search results** | | Copy the results as text |
| **Clear search results** | | Empty the view |
| **Cancel search** | | Stop a running search |
| **New search editor** | | Open a search in an editor tab |
| **Search again in search editor** | | Run the active search editor's search |
| **Save search editor** | | Save it as a `.code-search` file |
| **Quick search…** | | Search text from quick access (`%`) |

[Search in files](command:search.show)

## Settings

| Setting | Default | Description |
|---|---|---|
| `search.exclude` | `node_modules`, `bower_components`, `*.code-search` | Globs the search skips, on top of `files.exclude` |
| `search.useIgnoreFiles` | `true` | Skip files that `.gitignore` and `.ignore` list |
| `search.followSymlinks` | `true` | Follow symbolic links while searching |
| `search.smartCase` | `false` | Match case only when the query has an uppercase letter |
| `search.maxResults` | `20000` | Stop a search after this many matches |
| `search.searchOnType` | `true` | Search while typing (otherwise press Enter) |
| `search.searchOnTypeDebouncePeriod` | `300` | Milliseconds after the last key before searching |
| `search.seedWithNearestWord` | `false` | With no selection, start with the word at the cursor |
| `search.showLineNumbers` | `true` | Show line numbers next to results |
| `search.defaultViewMode` | `"list"` | Results as a `list` or a `tree` in a folder you haven't switched |
| `search.collapseResults` | `"alwaysExpand"` | Whether files start expanded (`alwaysExpand`, `auto`, `alwaysCollapse`) |
| `search.searchEditor.defaultNumberOfContextLines` | `1` | Context lines in a new search editor |
| `files.exclude` | `.git`, `.svn`, `.hg`, `.DS_Store`, `Thumbs.db` | Files the Explorer hides; search skips them too |

## Next steps

- [Quick access](02-quick-access.md): files, commands, symbols and lines from one box.
- [Editing](04-editing.md): multiple cursors, navigation and refactoring.
- [Workspaces and trust](20-workspaces.md): searching a workspace with several folders.

## Common questions

### Why doesn't the search find a file I know is there?

It's probably excluded: by `search.exclude`, `files.exclude`, or a `.gitignore`. Turn off **Use
exclude settings and ignore files** (the filter in **Files to exclude**) and search again.

### How do I search only some files?

Type folders or globs in **Files to include** (`src, *.ts`), click the book to search only the
files open in editors, or right-click a folder in the Explorer → **Find in folder…**.

### Can I undo a replace all?

Yes. It's one undo step: **Edit → Undo**, or Ctrl+Z with the Explorer focused. If a file changed
since, the undo says so and leaves it alone.
