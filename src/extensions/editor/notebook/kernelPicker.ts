// Choosing what runs a notebook (D202, D204, VS Code's kernel picker): the kernels its kernel
// sources find, the sources' own actions ("Existing Jupyter server…", an extension's), commands
// extensions put in the picker (`menus` "notebook/kernelSource"), and — like VS Code without the
// Jupyter extension — "Enable the Jupyter extension" (the built-in one, off until turned on) and
// "Browse extensions for kernels". Running a cell with nothing to run it on opens this picker.

import {
  JUPYTER_EXTENSION,
  JUPYTER_KERNELS,
  JUPYTER_NOTEBOOK,
  type KernelOption,
} from "../../../core/notebook/providers";
import { s } from "../../../core/schema/index";
import type { QuickPickItem } from "../../../ui/QuickInput";
import type { WorkbenchServices } from "../../../workbench/services";
import { notebookWhen } from "./toolbar";
import type { NotebookView } from "./view";

type Register = WorkbenchServices["dispatcher"]["register"];
type Target = (path?: string) => Promise<NotebookView>;

interface ExtensionInfo {
  id: string;
  status: string;
  permissions: { asked: string[]; granted: string[] };
}

const named = (k: KernelOption) => (k.data as { kernel?: unknown } | undefined)?.kernel;

/** Waits until `ready()` holds (true) or `ms` pass (false). */
async function until(ready: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 200) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return ready();
}

export function registerKernelCommands(
  register: Register,
  target: Target,
  services: WorkbenchServices,
): void {
  const { dispatcher, notebooks, quickInput, workspace } = services;

  /** The built-in Jupyter extension as the Extensions view knows it (null: not installed). */
  const jupyterExtension = async (): Promise<ExtensionInfo | null> => {
    const r = (await dispatcher.execute("extensions.list", {}).catch(() => null)) as {
      extensions?: ExtensionInfo[];
    } | null;
    return r?.extensions?.find((e) => e.id === JUPYTER_EXTENSION) ?? null;
  };

  register({
    id: "notebook.enableJupyter",
    title: "Enable the Jupyter extension",
    description:
      "Turns on the built-in Jupyter extension, which runs Jupyter notebooks' cells on the Pythons it finds (the folder's .venv, PATH) with their Jupyter kernels. Asks the user to allow what it needs (running programs, reading files) first. Resolves once its kernels are available.",
    input: s.object({
      grant: s.boolean().describe("Test scripts only: answer the permission dialog").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ grant }, ctx) => {
      // The user's choice (the kernel picker): an extension or agent can't turn it back on.
      if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test")
        throw new Error("Only the user can enable the Jupyter extension (Select kernel).");
      if (notebooks.source(JUPYTER_KERNELS)) return { enabled: true, already: true };
      const ext = await jupyterExtension();
      if (!ext)
        throw new Error(
          `The Jupyter extension (${JUPYTER_EXTENSION}) isn't installed: restore it from the Extensions view.`,
        );
      // Its permissions first (one dialog, the user's consent), then it starts.
      const missing = ext.permissions.asked.some((p) => !ext.permissions.granted.includes(p));
      if (missing) {
        // As the caller (a test script may answer the dialog; nobody else can).
        const r = (await ctx.execute("extensions.grantPermissions", {
          id: JUPYTER_EXTENSION,
          ...(grant !== undefined && { grant }),
        })) as { granted?: boolean };
        if (!r?.granted) return { enabled: false, reason: "Its permissions weren't allowed." };
      }
      if (ext.status === "disabled")
        await ctx.execute("extensions.enable", { id: JUPYTER_EXTENSION });
      const ready = await until(() => !!notebooks.source(JUPYTER_KERNELS), 15_000);
      if (!ready)
        throw new Error(
          "The Jupyter extension didn't start: its page in the Extensions view says why.",
        );
      return { enabled: true };
    },
  });

  register({
    id: "notebook.browseKernelExtensions",
    title: "Browse extensions for kernels",
    description:
      "Opens the Extensions view on Open VSX's Notebooks category: extensions that run notebooks (kernels) and render their outputs.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: async () => {
      // The store's category (D254), installed ones listed first as with any search.
      await dispatcher.execute("extensions.show", { query: "@category:Notebooks" });
      return {};
    },
  });

  register({
    id: "notebook.selectKernel",
    title: "Select kernel…",
    description:
      "Chooses what runs a notebook: the kernels its notebook type offers (Jupyter notebooks, with the Jupyter extension on: each Python found here with its Jupyter kernels, or plain Python) and kernels from extensions that run any notebook. `kernel`: a choice's label, id or kernelspec name, else the user picks; the picker also offers to enable the Jupyter extension and kernel sources' actions.",
    input: s.object({ path: s.string().optional(), kernel: s.string().optional() }),
    effects: ["exec"],
    run: async ({ path, kernel }, ctx) => {
      const view = await target(path);
      // The notebook's own folder's environments (D251), else the first folder's.
      const root = workspace.folderOf(view.path)?.path ?? workspace.root.peek();
      if (!root) throw new Error("Open a folder first.");
      // Finding kernels runs the folder's own Pythons (.venv): only in a trusted folder.
      await services.trust.require("Running notebook cells");
      const type = view.notebookType;
      const context = { root, path: view.path, notebookType: type };
      const found = await notebooks.findKernels(context);
      if (kernel) {
        const choice = found.find(
          // VS Code's `<extension>/<controller>` id too (interactive.open's controller).
          (k) =>
            k.label === kernel || k.id === kernel || named(k) === kernel || k.source === kernel,
        );
        if (!choice)
          throw new Error(
            found.length
              ? `No kernel "${kernel}" here. There are: ${found.map((k) => k.label).join(", ")}.`
              : view.runner.noKernelMessage(false, view.language()),
          );
        await view.useKernel(choice);
        return { kernel: choice.label, detail: choice.detail };
      }
      if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test" && !found.length)
        throw new Error(view.runner.noKernelMessage(false, view.language()));

      type Row = QuickPickItem & { run: () => Promise<unknown> };
      const rows: Row[] = found.map((k, i) => ({
        id: `k${i}`,
        label: k.label,
        // Whose it is, so an extension's kernel can't pass for one of the IDE's.
        description:
          k.source === JUPYTER_KERNELS
            ? k.detail
            : `${k.detail} · from the extension ${k.source.split("/")[0]}`,
        icon: "cpu",
        run: () => view.useKernel(k).then(() => ({ kernel: k.label, detail: k.detail })),
      }));
      const jupyter = type === JUPYTER_NOTEBOOK;
      const jupyterOn = !!notebooks.source(JUPYTER_KERNELS);
      if (jupyter && jupyterOn && !found.some((k) => k.source === JUPYTER_KERNELS))
        rows.push({
          id: "no-python",
          label: "No Python found",
          description: "Install Python (python.org), or set jupyter.pythonPath to one",
          icon: "info",
          disabled: true,
          run: async () => null,
        });
      // Kernel sources' own actions, then extensions' picker commands (VS Code's kernel sources).
      const more: Row[] = [];
      for (const source of notebooks.sourcesFor(type))
        for (const action of source.actions ?? [])
          more.push({
            id: `a:${source.id}:${action.id}`,
            label: action.label,
            description: action.detail ?? `from the extension ${source.id.split("/")[0]}`,
            icon: "server",
            run: async () => {
              const option = await source.runAction?.(action.id, context);
              if (!option) return { kernel: null };
              await view.useKernel({ ...option, source: source.id });
              return { kernel: option.label, detail: option.detail };
            },
          });
      for (const m of services.extensionFeatures.menuItems(
        "notebook/kernelSource",
        notebookWhen(services, { notebookType: type }),
      ))
        more.push({
          id: `m:${m.owner}:${m.command}`,
          label: m.title,
          description: `from the extension ${m.owner}`,
          icon: "server",
          run: () => dispatcher.execute(m.command, { path: view.path }),
        });
      // Offered only while no other extension runs Jupyter notebooks (Microsoft's Jupyter has
      // its own rows, as in VS Code, where nothing built in is offered beside them).
      const otherJupyter = notebooks
        .sourcesFor(type)
        .some((s) => s.id !== JUPYTER_KERNELS && s.notebookTypes?.includes(JUPYTER_NOTEBOOK));
      if (jupyter && !jupyterOn && !otherJupyter)
        more.unshift({
          id: "enable-jupyter",
          label: "Enable the Jupyter extension",
          description:
            "Built in: runs cells on Python (the folder's .venv, PATH) and Jupyter kernels",
          icon: "puzzle",
          run: async () => {
            const r = (await dispatcher.execute("notebook.enableJupyter", {})) as {
              enabled?: boolean;
            };
            if (!r?.enabled) return { kernel: null };
            // Its kernels, now that it runs.
            return dispatcher.execute("notebook.selectKernel", { path: view.path });
          },
        });
      more.push({
        id: "browse",
        label: "Browse extensions for kernels…",
        description: "Extensions that run notebooks",
        icon: "search",
        run: () => dispatcher.execute("notebook.browseKernelExtensions", {}),
      });
      if (more[0]) more[0].separator = rows.length ? "Kernel sources" : undefined;
      const all = [...rows, ...more];
      const picked = await quickInput.pick(all, {
        placeholder: rows.length ? "Run this notebook with…" : "Type to choose a kernel source",
      });
      const row = picked ? all.find((r) => r.id === picked.id) : undefined;
      if (!row) return { kernel: null };
      return row.run();
    },
  });
}
