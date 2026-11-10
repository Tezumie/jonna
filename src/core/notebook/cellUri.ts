// A notebook cell's document as extensions name it (VS Code's `vscode-notebook-cell:` Uris, as
// the `vscode` shim makes them: `vscode-notebook-cell:<notebook path>#<cell id>`), read back
// into the notebook and the cell: an extension's diagnostics for a cell (a language server's,
// Pyrefly's or Pylance's in a notebook) land in that cell. DOM-free and unit-tested.

const SCHEME = "vscode-notebook-cell:";

/**
 * The notebook and cell of a cell document's path as the worker sends it (the Uri as text,
 * maybe percent-encoded, maybe `/c:/…` as a server wrote it back), or null when it isn't one.
 */
export function parseCellPath(path: string): { notebook: string; cellId: string } | null {
  if (!path.toLowerCase().startsWith(SCHEME)) return null;
  const rest = path.slice(SCHEME.length);
  const hash = rest.lastIndexOf("#");
  if (hash <= 0) return null;
  const decode = (s: string) => {
    try {
      return s.includes("%") ? decodeURIComponent(s) : s;
    } catch {
      return s;
    }
  };
  let notebook = decode(rest.slice(0, hash));
  const cellId = decode(rest.slice(hash + 1));
  // `//authority/path` (a Uri printed with an empty authority) and `/c:/…` (a Windows path as
  // a Uri's path) back to the IDE's path.
  if (notebook.startsWith("///")) notebook = notebook.slice(2);
  if (/^\/[a-zA-Z]:[\\/]/.test(notebook)) notebook = notebook.slice(1).replace(/\//g, "\\");
  if (!notebook || !/^[\w.-]{1,128}$/.test(cellId)) return null;
  return { notebook, cellId };
}
