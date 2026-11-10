# Jupyter

Runs Jupyter notebooks (.ipynb) in the IDE's notebook editor, as a built-in extension (D203). The
IDE opens, edits and saves notebooks without it (D204, like VS Code's built-in ipynb support);
turn it on in Extensions, or from a notebook's "Select kernel" picker, to run their cells.

- **Kernels:** each Python found — `jupyter.pythonPath`, the open folder's `.venv`, `venv`, `env`
  or `.env`, `debug.pythonPath`, then `python3` / `python` (`py -3` on Windows) — with its Jupyter
  kernels, or plain Python without Jupyter. `kernel_host.py` runs the kernel and speaks one JSON
  message per line.
- **ipykernel:** picking a Python that doesn't have it asks to install it (`python -m pip install
  -U ipykernel`, run in a terminal you can watch), then uses its Jupyter kernel; "Run without it"
  runs cells on plain Python (no magics, widgets or interrupting a cell).
- **Permissions:** "Run programs" (the kernels, pip) and "Read files" (finding a folder's virtual
  environments). Cells only run in a trusted folder.

Everything else — the .ipynb format, cells, outputs, plots, widgets, the Variables panel, the run
queue, notebook diffs and the `notebook.*` commands agents use — is the IDE's notebook editor.
