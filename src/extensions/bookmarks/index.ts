// Bookmarks (D143), like the popular Bookmarks extension: Ctrl/Cmd+Alt+K marks the cursor's line
// (a bookmark in the editor's margin), Ctrl/Cmd+Alt+L / J jump to the next / previous one across
// files, "List bookmarks…" picks one with its line's text. Marks follow edits and renames and
// are kept per workspace. State: `ide://bookmarks`.
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { basename, isAbsolute, pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { GutterMark } from "../../workbench/gutterMarks";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { type Bookmark, BookmarkStore } from "./store";

const OWNER = "bookmarks";

export const bookmarksExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, state, workspace, persistence, gutterMarks, events, quickInput } = services;
    const store = new BookmarkStore();
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Bookmarks", ...c }));
    // Stored absolute; shown relative to their folder (with its name first when there are
    // several, D251), and a relative path given may start with a folder's name.
    const rel = (p: string) => workspace.relative(p);
    const abs = (p: string) => (workspace.root.peek() && !isAbsolute(p) ? workspace.resolve(p) : p);
    const activeEditor = async (): Promise<{ path: string; line: number } | null> => {
      const snap = await state.get("ide://editors/active").catch(() => null);
      const v = snap?.value as { absolutePath?: string | null; cursor?: { line: number } } | null;
      return v?.absolutePath ? { path: v.absolutePath, line: v.cursor?.line ?? 1 } : null;
    };
    /** The text of `line` in `path` (open editor first), trimmed, for lists. */
    const lineText = async (path: string, line: number): Promise<string> => {
      const text =
        services.documents.text(path) ??
        (await fsIpc.read(path).then(
          (b) => new TextDecoder().decode(b),
          () => "",
        ));
      return (text.split(/\r?\n/)[line - 1] ?? "").trim().slice(0, 160);
    };

    // The margin marks, and their lines following edits.
    sub.add(
      effect(() => {
        const byPath = new Map<string, GutterMark[]>();
        for (const b of store.list.value) {
          const key = pathKey(b.path);
          const list = byPath.get(key) ?? [];
          list.push({
            line: b.line,
            className: `bookmark-glyph${b.label ? " is-labeled" : ""}`,
            hover: b.label ? `Bookmark: ${b.label}` : "Bookmark",
          });
          byPath.set(key, list);
        }
        gutterMarks.set(OWNER, byPath);
        return undefined;
      }),
    );
    sub.add(
      gutterMarks.onDidMove(({ owner, path, lines }) => {
        if (owner === OWNER) store.moveLines(path, lines);
      }),
    );
    sub.add(events.on("files.didRename", ({ from, to }) => store.renamed(from, to)));

    // Kept per workspace.
    sub.add(
      persistence.register("bookmarks", {
        save: () => store.save(),
        restore: (data) => store.restore(data),
      }),
    );
    let first = true;
    sub.add(
      effect(() => {
        store.list.value;
        if (first) first = false;
        else persistence.scheduleSave();
        return undefined;
      }),
    );
    sub.add(workspace.onDidClose(() => store.restore([])));

    const out = (b: Bookmark) => ({
      id: b.id,
      path: rel(b.path),
      line: b.line,
      ...(b.label ? { label: b.label } : {}),
    });
    const go = async (b: Bookmark | null) => {
      if (!b) throw new Error("No bookmarks (Ctrl+Alt+K adds one).");
      await dispatcher.execute("editor.openFile", { path: b.path, line: b.line });
      return out(b);
    };
    const target = async (path?: string, line?: number) => {
      const active = path && line ? null : await activeEditor();
      const p = path ? abs(path) : active?.path;
      const l = line ?? active?.line;
      if (!p || !l) throw new Error("No file: open one or pass `path` and `line`.");
      return { path: p, line: l };
    };

    register({
      id: "bookmarks.toggle",
      title: "Toggle bookmark",
      description:
        "Bookmarks a line (default: the active editor's cursor line), or removes the bookmark there.",
      input: s.object({
        path: s.string().describe("File (relative to the workspace or absolute)").optional(),
        line: s.integer({ min: 1 }).optional(),
        label: s.string().describe("A name for it, shown in the list").optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ path, line, label }) => {
        const t = await target(path, line);
        if (label) return { added: true, bookmark: out(store.add(t.path, t.line, label)) };
        const b = store.toggle(t.path, t.line);
        return b ? { added: true, bookmark: out(b) } : { added: false };
      },
    });
    register({
      id: "bookmarks.toggleLabeled",
      title: "Toggle labeled bookmark…",
      description: "Asks for a label and bookmarks the cursor's line with it (or removes it).",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        const t = await target();
        const existing = store.at(t.path, t.line);
        if (existing && !existing.label) {
          store.remove(existing.id);
          return { added: false };
        }
        const label = await quickInput.prompt({
          prompt: `Label for the bookmark at line ${t.line}`,
          value: existing?.label ?? "",
          placeholder: "e.g. where the request is parsed",
        });
        if (label === undefined) return { added: false };
        if (!label.trim() && existing) {
          store.remove(existing.id);
          return { added: false };
        }
        return { added: true, bookmark: out(store.add(t.path, t.line, label.trim() || undefined)) };
      },
    });
    for (const [id, title, direction] of [
      ["bookmarks.next", "Next bookmark", 1],
      ["bookmarks.previous", "Previous bookmark", -1],
    ] as const)
      register({
        id,
        title,
        description: `Goes to the ${direction === 1 ? "next" : "previous"} bookmark after the cursor, across files (wraps around).`,
        input: s.empty(),
        effects: [],
        agent: "discoverable",
        run: async () => {
          const here = await activeEditor();
          const list = store.list.peek();
          return go(here ? store.next(here.path, here.line, direction) : (list[0] ?? null));
        },
      });
    register({
      id: "bookmarks.list",
      title: "List bookmarks…",
      description:
        "Lists the bookmarks (path, line, label, the line's text). For the user, a picker that goes to the chosen one.",
      input: s.empty(),
      effects: ["read"],
      agent: "discoverable",
      run: async (_input, ctx) => {
        const list = store.list.peek();
        const rows = await Promise.all(
          list.map(async (b) => ({ ...out(b), text: await lineText(b.path, b.line) })),
        );
        if (ctx.caller.kind !== "user") return { bookmarks: rows };
        if (!rows.length) {
          services.notifications.show("info", "No bookmarks yet. Ctrl+Alt+K bookmarks a line.");
          return { bookmarks: [] };
        }
        const picked = await quickInput.pick(
          rows.map((r, i) => ({
            id: String(i),
            label: r.label ? `${r.label} · ${r.text || "(empty line)"}` : r.text || "(empty line)",
            description: `${basename(r.path)}:${r.line}`,
            icon: "bookmark" as const,
          })),
          { placeholder: "Go to a bookmark", matchOn: (i) => `${i.label} ${i.description ?? ""}` },
        );
        const b = picked ? list[Number(picked.id)] : undefined;
        if (b) await go(b);
        return { bookmarks: rows };
      },
    });
    register({
      id: "bookmarks.clear",
      title: "Clear bookmarks",
      description: "Removes every bookmark (or those of one file).",
      input: s.object({ path: s.string().optional() }),
      effects: ["write"],
      agent: "discoverable",
      run: ({ path }) => ({ removed: store.clear(path ? abs(path) : undefined) }),
    });
    register({
      id: "bookmarks.clearFile",
      title: "Clear bookmarks in this file",
      description: "Removes the active file's bookmarks.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        const here = await activeEditor();
        return { removed: here ? store.clear(here.path) : 0 };
      },
    });

    sub.add(
      state.register("ide://bookmarks", {
        description: "Bookmarked lines: id, path, line and label, in file order.",
        get: () => ({ bookmarks: store.list.peek().map(out) }),
      }),
    );
  },
};
