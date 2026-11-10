// Explorer cut / copy / paste and moves (drag in the tree) as commands. The clipboard is the
// explorer's own (paths), not the system clipboard; cut rows are drawn dimmed until pasted.
import { fsIpc } from "../../core/ipc/fs";
import { clipboardIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath, pathKey, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { validateName } from "./fileCommands";
import { updateImportsAfterMove } from "./importUpdates";
import { createdOperation, movedOperation } from "./undo";
import type { ExplorerView } from "./view";

export interface ExplorerClipboard {
  mode: "cut" | "copy";
  paths: string[];
}

export function registerClipboardCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  getView: () => ExplorerView | undefined,
): void {
  const { dispatcher, workspace, events } = services;
  const root = (): string => {
    const r = workspace.root.peek();
    if (!r) throw new Error("No folder is open.");
    return r;
  };
  /**
   * Given paths, else the explorer selection; a collapsed nest parent takes its nested files
   * along (D203) for the selection, or for given paths with `withNested`.
   */
  const resolveAll = (paths: readonly string[] | undefined, withNested?: boolean): string[] => {
    root();
    const view = getView();
    const given = !!paths?.length;
    const picked = given
      ? (paths ?? []).map((p) => workspace.resolve(p))
      : (view?.tree?.selectedItems().map((e) => e.path) ?? []);
    const list =
      view && (given ? withNested === true : withNested !== false)
        ? view.withNestedFiles(picked)
        : picked;
    // Inside a workspace folder (any, D251), and never one of them itself.
    for (const p of list)
      if (!workspace.contains(p) || workspace.folders.peek().some((f) => samePath(f.path, p)))
        throw new Error(`Can't move or copy ${p}`);
    return list;
  };
  /** Paste/move target: the given folder, the folder of a selected file, or the root. */
  const destination = async (dest: string | undefined): Promise<string> => {
    const r = root();
    const candidate = dest ? workspace.resolve(dest) : (getView()?.tree?.selection?.path ?? r);
    const stat = await fsIpc.stat(candidate).catch(() => null);
    return stat?.kind === "dir" ? candidate : dirname(candidate);
  };
  const pathsInput = s
    .array(s.string())
    .describe("Files or folders, absolute or relative to the workspace root (default: selection)")
    .optional();
  const withNestedInput = s
    .boolean()
    .describe(
      "Also take the files nested under a collapsed nest parent in the explorer (explorer.fileNesting); default: true for the selection, false for `paths`",
    )
    .optional();

  /** Moves (or copies) into `dest`, telling editors about moves, then refreshes and reveals. */
  const transfer = async (
    mode: "cut" | "copy",
    paths: readonly string[],
    dest: string,
    user = false,
  ) => {
    const done: string[] = [];
    const moves: { from: string; to: string }[] = [];
    let failure: unknown = null;
    try {
      for (const from of paths) {
        if (mode === "cut") {
          if (pathKey(dirname(from)) === pathKey(dest)) continue; // already there
          const to = await fsIpc.move(from, dest);
          events.emit("files.didRename", { from, to });
          moves.push({ from, to });
          done.push(to);
        } else {
          done.push(await fsIpc.copy(from, dest));
        }
      }
    } catch (err) {
      // What was done before the failure is still recorded (undoable); then the error shows.
      failure = err;
    }
    const deps = {
      services,
      refresh: async (dirs: string[]) => {
        await getView()?.refresh([...new Set(dirs)]);
      },
    };
    const what = (n: number) => (n === 1 ? basename(done[0] ?? "") : `${n} items`);
    if (moves.length) {
      const op = movedOperation(deps, moves, `Move ${what(moves.length)}`);
      const entry = services.history.push(op);
      const imports = failure
        ? undefined
        : await updateImportsAfterMove(
            services,
            moves,
            user,
            undefined,
            () => services.history.peek("undo")?.id === entry,
          ).catch((err: unknown) => {
            services.notifications.show(
              "warning",
              `Imports weren't updated: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          });
      if (imports) op.attach(imports);
    }
    if (!moves.length && done.length && mode === "copy")
      services.history.push(createdOperation(deps, done, `Paste ${what(done.length)}`));
    const view = getView();
    await view?.refresh([dest, ...paths.map(dirname)]);
    if (failure) throw failure;
    const last = done[done.length - 1];
    if (last) view?.tree?.reveal(last);
    return done.map((p) => workspace.relative(p));
  };

  sub.add(
    dispatcher.register({
      id: "explorer.duplicate",
      title: "Duplicate",
      category: "File",
      description:
        'Copies files or folders next to themselves ("name copy.ext"); undoable like a paste.',
      input: s.object({ paths: pathsInput }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ paths }) => {
        const list = resolveAll(paths);
        const created: string[] = [];
        for (const p of list) created.push(...(await transfer("copy", [p], dirname(p))));
        return { created };
      },
    }),
  );
  // Compare two files (VS Code's "Select for compare" / "Compare with selected").
  sub.add(
    dispatcher.register({
      id: "explorer.selectForCompare",
      title: "Select for compare",
      category: "File",
      description: "Remembers a file for explorer.compareWithSelected.",
      input: s.object({ path: s.string() }),
      effects: [],
      agent: "hidden",
      when: "workspaceOpen",
      run: ({ path }) => {
        root();
        const abs = workspace.resolve(path);
        services.context.set("explorerCompareBase", abs);
        return { selected: abs };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "explorer.compareWithSelected",
      title: "Compare with selected",
      category: "File",
      description: "Opens a diff: the file chosen with Select for compare ↔ `path`.",
      input: s.object({ path: s.string() }),
      effects: [],
      agent: "hidden",
      when: "workspaceOpen",
      run: async ({ path }, ctx) => {
        const base = services.context.get("explorerCompareBase");
        if (typeof base !== "string") throw new Error("First pick a file with Select for compare.");
        root();
        return ctx.execute("editor.compareFiles", {
          path: workspace.resolve(path),
          against: base,
        });
      },
    }),
  );

  /** What explorer.copy / cut put on the system clipboard (the paths). */
  let marker = "";

  /** A name proposal for pasted content: image.png, or pasted.<ext> by what the text looks like. */
  const proposal = (c: { kind: "image" } | { kind: "text"; text: string }): string => {
    if (c.kind === "image") return "image.png";
    const t = c.text.trim();
    if (/^<svg[\s>]/i.test(t)) return "pasted.svg";
    if (/^[[{]/.test(t)) {
      try {
        JSON.parse(t);
        return "pasted.json";
      } catch {
        // not JSON
      }
    }
    if (/^#{1,6}\s|\n#{1,6}\s|^- |\n- /.test(t)) return "pasted.md";
    return "pasted.txt";
  };

  /** Names the new file inline (the proposal's name part selected) and writes it. */
  const pasteAsFile = async (
    c: { kind: "image"; bytes: Uint8Array } | { kind: "text"; text: string },
    folder: string,
  ): Promise<string | null> => {
    const view = getView();
    const initial = await freeName(folder, proposal(c));
    const dot = initial.lastIndexOf(".");
    const validate = (v: string) => validateName(v);
    const name = view?.canEditInline()
      ? await view.inline.start({
          kind: "file",
          path: folder,
          initial,
          selection: [0, dot > 0 ? dot : initial.length],
          acceptInitial: true,
          validate,
        })
      : await services.quickInput.prompt({
          prompt: c.kind === "image" ? "Paste the picture as" : "Paste the text as",
          value: initial,
          validate,
        });
    if (!name) return null;
    const path = joinPath(folder, name.trim());
    if (
      await fsIpc.stat(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`${name.trim()} already exists.`);
    await fsIpc.write(
      path,
      c.kind === "image" ? c.bytes : new TextEncoder().encode(c.text),
      "user",
    );
    events.emit("files.didCreate", { path, kind: "file" });
    const deps = {
      services,
      refresh: async (dirs: string[]) => {
        await getView()?.refresh([...new Set(dirs)]);
      },
    };
    services.history.push(createdOperation(deps, [path], `Paste ${basename(path)}`));
    await getView()?.refresh([folder]);
    return path;
  };

  /** `name`, or `name-2`, `name-3`… the first free one in `folder`. */
  const freeName = async (folder: string, name: string): Promise<string> => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      if (
        !(await fsIpc.stat(joinPath(folder, candidate)).then(
          () => true,
          () => false,
        ))
      )
        return candidate;
    }
  };

  for (const mode of ["cut", "copy"] as const) {
    sub.add(
      dispatcher.register({
        id: `explorer.${mode}`,
        title: mode === "cut" ? "Cut" : "Copy",
        category: "File",
        description: `Puts files or folders on the explorer's clipboard for explorer.paste (${mode === "cut" ? "moved" : "copied"} when pasted). A collapsed nest parent's nested files go with it, as in VS Code.`,
        input: s.object({ paths: pathsInput, withNested: withNestedInput }),
        effects: [],
        when: "workspaceOpen",
        run: ({ paths, withNested }) => {
          const list = resolveAll(paths, withNested);
          getView()?.setClipboard(list.length ? { mode, paths: list } : null);
          // The system clipboard gets the paths too (pasted in a terminal or a chat, they're
          // useful); Paste here knows its own copy by them (D190).
          if (list.length) {
            const paths = list.join("\n");
            marker = "";
            void clipboardIpc.writeText(paths).then(
              () => {
                marker = paths;
              },
              () => {},
            );
          }
          return { count: list.length };
        },
      }),
    );
  }

  sub.add(
    dispatcher.register({
      id: "explorer.paste",
      title: "Paste",
      category: "File",
      description:
        "Pastes what explorer.cut / explorer.copy put on the clipboard into a folder (default: the selected folder, or the folder of the selected file). A copy whose name is taken gets ' copy' added.",
      input: s.object({ dest: s.string().describe("Destination folder").optional() }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ dest }, ctx) => {
        const view = getView();
        const clip = view?.clipboard;
        // Something copied elsewhere since (a screenshot, text): pasted as a new file (D190).
        if (ctx.caller.kind === "user") {
          const text = await clipboardIpc.readText().catch(() => "");
          // Anything but our own copy's paths (a screenshot leaves no text at all) is fresh;
          // when those never reached the system clipboard, the explorer's copy wins.
          const fresh = !clip || (marker !== "" && text !== marker);
          if (fresh) {
            const image = await clipboardIpc.readImagePng();
            if (image || text) {
              const created = await pasteAsFile(
                image ? { kind: "image", bytes: image } : { kind: "text", text },
                await destination(dest),
              );
              if (created) await ctx.execute("editor.openFile", { path: created });
              return { pasted: created ? [created] : [] };
            }
          }
        }
        if (!clip) return { pasted: [] };
        const pasted = await transfer(
          clip.mode,
          clip.paths,
          await destination(dest),
          ctx.caller.kind === "user",
        );
        if (clip.mode === "cut") view?.setClipboard(null);
        return { pasted };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "explorer.move",
      title: "Move to folder",
      category: "File",
      description:
        "Moves files or folders into another folder of the workspace (what dragging in the explorer does; a collapsed nest parent's nested files go with it). Open editors follow.",
      input: s.object({
        paths: pathsInput,
        dest: s.string().describe("Destination folder, absolute or relative to the workspace root"),
        withNested: withNestedInput,
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ paths, dest, withNested }, ctx) => ({
        moved: await transfer(
          "cut",
          resolveAll(paths, withNested),
          await destination(dest),
          ctx.caller.kind === "user",
        ),
      }),
    }),
  );
}
