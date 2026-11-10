// VS Code's `contributes.notebookPreload` (D295): scripts an extension has loaded into every
// notebook's output page of a type, before any renderer runs (Jupyter's ipywidgets kernel side,
// the ipywidgets 7 and 8 bundles of Jupyter's renderers). Each is an ES module whose
// `activate(context)` gets `postKernelMessage` / `onDidReceiveKernelMessage`, the messages of
// the notebook's controller. Read here from the extension's package.json on its own (the manifest
// parser keeps what the IDE's own format has). DOM-free and tested.

export interface NotebookPreloadContribution {
  /** The notebook type, as the package names it ("jupyter-notebook", "interactive"). */
  type: string;
  /** The module, relative to the extension's folder ("dist/kernel.js"). */
  entrypoint: string;
  /** Folders the module may load files from (relative); the IDE's page has none of them. */
  localResourceRoots: string[];
}

const MAX_PRELOADS = 20;

/** The `notebookPreload` contributions of a package.json (invalid ones left out). */
export function notebookPreloads(packageJson: unknown): NotebookPreloadContribution[] {
  if (!packageJson || typeof packageJson !== "object") return [];
  const contributes = (packageJson as { contributes?: unknown }).contributes;
  if (!contributes || typeof contributes !== "object") return [];
  const list = (contributes as { notebookPreload?: unknown }).notebookPreload;
  if (!Array.isArray(list)) return [];
  const relative = (p: unknown): string | null => {
    if (typeof p !== "string") return null;
    const path = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    // Inside the extension's folder only.
    if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes(".."))
      return null;
    return path;
  };
  const out: NotebookPreloadContribution[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type.trim() : "";
    const entrypoint = relative(r.entrypoint);
    if (!type || !entrypoint) continue;
    const roots = Array.isArray(r.localResourceRoots)
      ? r.localResourceRoots.flatMap((x) => relative(x) ?? [])
      : [];
    out.push({ type, entrypoint, localResourceRoots: roots.slice(0, 10) });
    if (out.length >= MAX_PRELOADS) break;
  }
  return out;
}
