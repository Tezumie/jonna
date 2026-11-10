# Notebooks

Jupyter notebooks (`.ipynb`) open in the IDE's notebook editor: code and Markdown cells, their
outputs, and a kernel that runs the code. Opening, editing and saving notebooks needs nothing
installed. Running cells needs a kernel, which the built-in **Jupyter** extension provides once
you turn it on. This page covers working with cells, picking a kernel, outputs, the keyboard,
language features in cells, and saving, exporting and comparing notebooks.

## Open or create a notebook

- Open any `.ipynb` file from the Explorer: it opens as a notebook right away, with the outputs
  that were saved in it.
- **New Jupyter notebook** (Command Palette) creates `Untitled.ipynb` in the open folder (numbered
  when the name is taken) and opens it.
- **New untitled notebook** opens a notebook with no file yet; the first save asks where to put
  it.

[New Jupyter notebook](command:notebook.new)

## Work with cells

A notebook is a list of cells. **Code** cells hold code and show their outputs below them;
**Markdown** cells show formatted text; **Raw** cells hold text that isn't run.

- Hover the space between two cells for **+ Code** and **+ Markdown**, or use the notebook's
  toolbar, which adds a cell below the selected one.
- Markdown cells look like the [Markdown preview](04-editing.md#markdown-preview). Double-click
  one, or press Enter, to edit it; press Esc to see it rendered again.
- A code cell's language is at its bottom right; click it to change it (**Change cell
  language**). Its status row also shows how long the cell took to run.
- Drag a cell by the strip to its left to move it. A line shows where it lands; Escape cancels.

### Command mode and edit mode

As in Jupyter and VS Code, a notebook has two modes:

- **Edit mode:** the cursor is in a cell's editor and keys type text.
- **Command mode:** the notebook has the focus and single keys act on the selected cells (A adds
  a cell above, D D deletes, M makes a Markdown cell…). Press **Esc** in a cell to get there, and
  **Enter** to edit the selected cell again.

The arrow keys move past a cell's first or last line into the cell above or below.

### The cell toolbar

Hover a cell for its toolbar: run the cells above, or this cell and the ones below (code cells),
edit or stop editing (Markdown cells), split the cell at the cursor, buttons that extensions add,
**…** for more, and delete. In a cell taller than the screen, the toolbar stays at the top of the
notebook while you scroll through it.

The **…** menu has: cut, copy and paste the cell; insert a cell; change the cell to code,
Markdown or raw; **Change cell language…**; join with the previous or next cell; **Copy cell
down**; move the cell up or down; **Show cell line numbers**; **Format cell**; collapse the
cell's output; and clear the cell's output.

### Select several cells

- **Shift+click** a cell's margin (or its rendered text or output) to select every cell from the
  one selected before.
- **Ctrl+click** adds or removes one cell.
- **Shift+Up / Shift+Down** (or Shift+K / Shift+J) extend the selection from the keyboard;
  **Ctrl+A** selects every cell.

Run, delete (D D), move (Alt+Up / Alt+Down), copy (C), cut (X), clear outputs and change the type
(M, Y, R) then act on all the selected cells, and the **…** menu adds **Run selected cells** and
**Join selected cells**. Dragging one of several selected cells moves all of them, in order, as
one block.

Cell operations (adding, deleting, moving, joining…) are undone with **Z** in command mode, or
Ctrl+Z / Ctrl+Shift+Z; typing inside a cell has its own undo.

## Run cells

Running a cell needs a **kernel**: a process that runs the code and sends back the results.
Click **Select kernel** at the top right of the notebook, or just run a cell: with no kernel
chosen yet, the IDE picks one by itself (the kernel the notebook names, else one for its
language) or opens the picker. The choice is remembered for each notebook.

Cells only run in a trusted folder; the first run asks you to trust it (see
[Workspaces and trust](20-workspaces.md)).

### Turn on the Jupyter extension

Kernels come from extensions. The built-in **Jupyter** extension is off until you turn it on:

1. Click **Select kernel** (or run a cell).
2. Pick **Enable the Jupyter extension**.
3. Allow its permissions: running programs (the kernels and pip) and reading files (to find the
   folder's virtual environments).

You can also turn it on in **Extensions**. **Browse extensions for kernels** in the same picker
lists other extensions that run notebooks.

[Select kernel](command:notebook.selectKernel)

### Choose a Python

The Jupyter extension looks for Pythons in this order and lists each one once:

1. `jupyter.pythonPath`, if you set it;
2. the open folder's `.venv`, `venv`, `env` or `.env`;
3. `debug.pythonPath`;
4. `python3` / `python` on PATH (`py -3` on Windows).

For each Python, the picker lists its Jupyter kernels. A Python without Jupyter is listed as
"Python 3.x … without Jupyter". If none is found, the picker says **No Python found**: install
Python, or set `jupyter.pythonPath`.

### Install ipykernel

`ipykernel` is the package Jupyter uses to run Python. Picking a Python that doesn't have it asks
to install it: the IDE runs `python -m pip install -U ipykernel` in a terminal you can watch, then
uses that Python's Jupyter kernel. **Run without it** runs cells on plain Python instead: they
still run, but without magics, widgets or interrupting a cell.

### Other languages

Any Jupyter kernel installed for a Python that the extension finds is listed, not only Python's:
R (IRkernel) and Julia (IJulia) kernels show up in the picker, and their cells are colored. A
notebook whose language has no kernel installed asks you to pick one rather than running its
cells on Python.

### Run, interrupt and restart

| Command | Keys | What it does |
|---|---|---|
| **Run cell** | Ctrl+Enter | Run the selected cells |
| | Shift+Enter | Run the cell and select the next one |
| | Alt+Enter | Run the cell and insert a cell below |
| **Run all cells** | | Run every cell, top to bottom (**Run all** in the toolbar) |
| **Run the cells above** | | Run every cell above this one |
| **Run this cell and the ones below** | | Run from this cell to the end |
| **Interrupt the kernel** | I I | Stop the running cell (the square in the toolbar) |
| **Restart the kernel** | 0 0 | Start the kernel again, forgetting its variables |
| **Restart the kernel and run all** | | Restart, then run every cell |
| **Select kernel…** | | Choose what runs this notebook |

Cells you run while another is running wait in a queue.

## Outputs

Outputs show under their cell as they arrive:

- text and errors, with their colors and progress bars;
- images (PNG, JPEG, GIF, WebP, SVG) and plots;
- HTML (pandas tables, for example), Markdown, LaTeX and JSON;
- interactive outputs: ipywidgets, Plotly, Bokeh, and scripted HTML, each in a sandboxed frame;
- what extensions' renderers draw for their own output types.

Outputs that run scripts only run in a trusted folder: a downloaded notebook's saved outputs show
as text until you trust its folder. Interactive outputs load their libraries from a CDN
(`notebook.output.cdn`, jsDelivr by default), so they need network access; point the setting at
a mirror if jsDelivr is blocked where you work.

- Long outputs scroll inside their cell (`notebook.output.scrolling`); very long text shows its
  last 200 000 characters.
- **O** in command mode, or **Collapse or expand output**, hides a cell's output. **Clear cell
  output** and **Clear all outputs** (**Clear outputs** in the toolbar) remove them.
- A cell that asks for input (`input()` in Python) shows an input box under it.

### Variables

**Variables** in the notebook's toolbar (**Show variables**) opens a panel with what the kernel
holds: names, types and values. It updates after each run.

## Keyboard shortcuts

### Command mode

| Keys | What it does |
|---|---|
| Enter | Edit the selected cell |
| Up / Down (K / J) | Select the cell above / below; Home / End: the first / last |
| Shift+Up / Shift+Down (Shift+K / Shift+J) | Extend the selection |
| Ctrl+A | Select every cell |
| A / B | Insert a code cell above / below |
| D D | Delete the selected cells |
| M / Y / R | Change the cells to Markdown / code / raw |
| C / X / V | Copy / cut / paste cells |
| Alt+Up / Alt+Down | Move the cells up / down |
| Shift+Alt+Up / Shift+Alt+Down | Copy the cell up / down |
| Ctrl+Alt+J / Ctrl+Alt+Shift+J | Join with the next / previous cell |
| O | Collapse or expand the output |
| L / Shift+L | Show line numbers in this cell / every cell |
| Z | Undo a cell operation (Ctrl+Z / Ctrl+Shift+Z also work) |
| I I / 0 0 | Interrupt / restart the kernel |
| Shift+Alt+F | Format the notebook |
| Ctrl+S | Save the notebook |
| Ctrl+F / Ctrl+H | Find / find and replace |

### Edit mode

| Keys | What it does |
|---|---|
| Ctrl+Enter / Shift+Enter / Alt+Enter | Run the cell (and move on / insert a cell below) |
| Esc | Back to command mode (a Markdown cell renders again) |
| Ctrl+Shift+- | Split the cell at the cursor |
| Ctrl+Alt+J / Ctrl+Alt+Shift+J | Join with the next / previous cell |
| Shift+Alt+Up / Shift+Alt+Down | Copy the cell up / down |
| Shift+Alt+F | Format the cell |
| Up / Down on the first / last line | Move into the cell above / below |

The editor's own popups (suggestions, find, parameter hints) take Esc and the arrows first.

## Find and replace in a notebook

**Ctrl+F** finds across every cell, in command mode or inside a cell. Enter and Shift+Enter move
between matches; the toggles are **Match case**, **Match whole word**, **Use regular expression**
and **Search outputs too**, which also finds text in outputs. **Ctrl+H** (or the arrow at the
left of the find field) adds the replace field: Enter replaces the current match and
Ctrl+Alt+Enter replaces all of them, as one undo step. Escape closes the find bar.

## Language features in cells

The folder's language server for the notebook's language (Pyright or pylsp for Python, for
example) checks the code cells as one program, as VS Code does:

- a name defined in an earlier cell is known in later ones;
- mistakes are underlined in their cell and listed in **Problems** with the cell number;
- hover, completion, signature help, go to definition (F12), references, rename (F2), quick fixes,
  inlay hints and semantic colors work across cells;
- IPython syntax beyond plain magics (`x = !ls`, `%time f()`, `obj?`) isn't reported as an error.

Turn this off with `notebook.languageServer.enabled`. With a kernel running, cells also get
completions and hovers from the kernel. See [Language servers](04-editing.md#language-servers) for
installing a server.

## Format cells

**Format cell** (the cell's **…** menu, or Shift+Alt+F in a cell's editor) formats one cell with
the language server's formatter. **Format notebook** (Shift+Alt+F in command mode) formats every
code cell, as one undo step.

## Outline, breadcrumbs and going to a cell

- The **Outline** (at the bottom of the Explorer) shows the notebook's Markdown headings with the
  code cells under them; click one to go there.
- **Breadcrumbs** above the notebook show the file's folders and the selected cell's place in that
  outline (`breadcrumbs.enabled`).
- **Go to cell** jumps to a cell.

## Export as a script

**Export as script** (the toolbar button, or the Command Palette) writes the notebook beside it as
a script, `name.py` for Python (`.r` for R, `.jl` for Julia), and opens it. Each code cell starts
with a `# %%` line, and Markdown cells become comments under `# %% [markdown]`:

```python
# %% [markdown]
# # Load the data

# %%
import pandas as pd
df = pd.read_csv("data.csv")
```

If the script already exists, the IDE asks before replacing it.

## The notebook's source

**Show source** in the tab's title bar shows the notebook file's JSON in the same tab, which helps
with merge conflicts, a broken file or metadata; **Show as notebook** goes back. With unsaved
changes, you're asked to save first. A file that can't be read as a notebook says so and offers
its source to fix it. **Reopen editor with…** also switches between the two.

## Compare notebooks

The diff view compares notebooks cell by cell, so a notebook's changes in **Source control** show
which cells changed rather than a JSON diff. See [Source control](08-git.md).

## Save notebooks

- **Ctrl+S** saves. The file is written as Jupyter writes it (nbformat 4, keys sorted, one-space
  indents), so an unchanged notebook diffs cleanly. Unknown fields are kept; the kernel and the
  widgets' state are saved in the notebook's metadata.
- **Hot exit:** unsaved notebooks are kept when you close the window (`files.hotExit`) and come
  back unsaved the next time, as text files do. Notebooks over 2 MB aren't kept; closing asks
  about those.
- If the file changes on disk while you have unsaved changes, a banner offers **Load the file** or
  **Keep mine**. Without unsaved changes, the notebook reloads by itself.

## Settings

| Setting | Default | Description |
|---|---|---|
| `jupyter.pythonPath` | `""` | The Python that runs notebooks, tried first (user setting) |
| `notebook.languageServer.enabled` | `true` | Language servers in code cells, as one document |
| `notebook.lineNumbers` | `"off"` | Line numbers in cells' editors |
| `notebook.output.scrolling` | `true` | Long outputs scroll inside their cell |
| `notebook.output.cdn` | `"https://cdn.jsdelivr.net/npm/"` | Where interactive outputs load their libraries from |
| `files.hotExit` | `"onExit"` | Keep unsaved notebooks when the window closes |

## Next steps

- [Editing](04-editing.md): the editor inside each cell, and language servers.
- [Extensions](18-extensions.md): turn on Jupyter, or find other kernels.
- [Source control](08-git.md): commit notebooks and compare their versions.

## Common questions

### Why won't my cells run?

Check three things: the **Jupyter** extension is on (**Select kernel → Enable the Jupyter
extension**), the folder is trusted, and a Python was found (set `jupyter.pythonPath` if yours
isn't on PATH or in the folder's `.venv`).

### How do I use my virtual environment?

Create it in the folder as `.venv` or `venv` and it's found first, or point `jupyter.pythonPath`
at its `python`. Then pick it in **Select kernel**. If it lacks `ipykernel`, accept the offer to
install it.

### Why do Plotly or widget outputs show as text?

Outputs that run scripts only run in a trusted folder, and they load their libraries from
`notebook.output.cdn`. Trust the folder, and check that the CDN is reachable.

### Can I open a `# %%` script as a notebook?

No. **Export as script** writes a notebook as a `# %%` script, but scripts don't open as
notebooks.
