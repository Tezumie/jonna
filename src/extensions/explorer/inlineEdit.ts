// Inline rename / new file / new folder in the explorer tree (as in VS Code): an input takes the
// row's name slot; Enter commits, Escape cancels, clicking elsewhere commits. A new item shows as a
// placeholder row at the top of its folder until it's named. Invalid names keep the input open
// with the reason shown below it.
import { h, on } from "../../core/dom/index";
import type { DirEntry } from "../../core/ipc/fs";
import { joinPath, pathKey } from "../../core/paths/index";
import type { Tree } from "../../ui/Tree";

export interface InlineRequest {
  kind: "rename" | "file" | "dir";
  /** The item to rename, or the folder to create in. */
  path: string;
  initial: string;
  /** Selected part of the initial value (the name without its extension). */
  selection?: [number, number];
  /** The initial value is a proposal: Enter (or clicking away) takes it as is. */
  acceptInitial?: boolean;
  validate(value: string): string | undefined;
}

interface Pending {
  request: InlineRequest;
  input: HTMLInputElement;
  message: HTMLElement;
  wrap: HTMLElement;
  resolve(value: string | undefined): void;
}

const NEW = "\u0000new";

export class InlineEdit {
  private pending: Pending | null = null;

  constructor(
    private readonly tree: () => Tree<DirEntry> | undefined,
    private readonly root: () => string | null,
  ) {}

  get active(): boolean {
    return this.pending !== null;
  }

  /** Adds the placeholder row to the listing of the folder a new item is being created in. */
  withPlaceholder(parent: DirEntry, entries: DirEntry[]): DirEntry[] {
    const p = this.pending;
    if (!p || p.request.kind === "rename" || pathKey(p.request.path) !== pathKey(parent.path))
      return entries;
    const placeholder: DirEntry = {
      name: "",
      path: joinPath(parent.path, NEW),
      kind: p.request.kind === "dir" ? "dir" : "file",
      isSymlink: false,
      ignored: false,
    };
    // Folders first, like the listing itself.
    const firstFile = entries.findIndex((e) => e.kind !== "dir");
    const at = placeholder.kind === "dir" || firstFile < 0 ? 0 : firstFile;
    return [...entries.slice(0, at), placeholder, ...entries.slice(at)];
  }

  isPlaceholder(entry: DirEntry): boolean {
    return entry.path.endsWith(NEW);
  }

  /** The path being renamed, if a rename is in progress. */
  renaming(): string | null {
    return this.pending?.request.kind === "rename" ? this.pending.request.path : null;
  }

  /** The editor element for `entry`'s row, if it is being edited. */
  inputFor(entry: DirEntry): HTMLElement | null {
    const p = this.pending;
    if (!p) return null;
    const target = pathKey(p.request.path);
    const editing =
      p.request.kind === "rename"
        ? pathKey(entry.path) === target ||
          // A folder inside a compact row ("a/b/c"): edited in its place in the row (D191).
          ((entry as DirEntry & { segments?: string[] }).segments ?? []).some(
            (s) => pathKey(s) === target,
          )
        : this.isPlaceholder(entry);
    if (!editing) return null;
    // The row may be re-rendered (scroll, refresh): keep the same input and its focus.
    queueMicrotask(() => {
      if (this.pending === p && document.activeElement !== p.input)
        p.input.focus({ preventScroll: true });
    });
    return p.wrap;
  }

  /** Starts editing; resolves with the entered name, or undefined when cancelled. */
  async start(request: InlineRequest): Promise<string | undefined> {
    this.cancel();
    const tree = this.tree();
    if (!tree) return undefined;
    const input = h("input", {
      class: "input explorer-inline-input",
      type: "text",
      spellcheck: "false",
      "aria-label":
        request.kind === "rename"
          ? "New name"
          : request.kind === "dir"
            ? "Folder name"
            : "File name",
    });
    input.value = request.initial;
    const message = h("div", { class: "explorer-inline-message", hidden: true, role: "alert" });
    const wrap = h("span", { class: "explorer-inline" }, input, message);
    const result = new Promise<string | undefined>((resolve) => {
      this.pending = { request, input, message, wrap, resolve };
    });
    const p = this.pending as Pending | null;
    if (!p) return undefined;
    const finish = (value: string | undefined) => {
      if (this.pending !== p) return;
      this.pending = null;
      p.resolve(value);
      void this.redraw(request);
    };
    const check = () => {
      const error =
        input.value.trim() && (input.value.trim() !== request.initial || request.acceptInitial)
          ? request.validate(input.value)
          : undefined;
      message.hidden = !error;
      message.textContent = error ?? "";
      input.classList.toggle("is-invalid", !!error);
      return error;
    };
    const commit = () => {
      const value = input.value.trim();
      if (!value || (value === request.initial && !request.acceptInitial)) return finish(undefined);
      if (check()) return;
      finish(value);
    };
    on(input, "input", check);
    on(input, "keydown", (e) => {
      e.stopPropagation(); // the tree's keys (Enter opens, Delete deletes…) must not fire
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(undefined);
      }
    });
    on(input, "pointerdown", (e) => e.stopPropagation());
    on(input, "blur", () =>
      setTimeout(() => {
        // A re-render moves the input and focuses it again; only a real focus loss commits.
        if (this.pending === p && document.activeElement !== input) {
          if (check()) finish(undefined);
          else commit();
        }
      }, 0),
    );
    if (request.kind === "rename") tree.rerender();
    else {
      if (pathKey(request.path) !== pathKey(this.root() ?? "")) await tree.expand(request.path);
      await tree.refresh(request.path);
      tree.reveal(joinPath(request.path, NEW));
    }
    requestAnimationFrame(() => {
      input.focus();
      const [a, b] = request.selection ?? [0, input.value.length];
      input.setSelectionRange(a, b);
    });
    return result;
  }

  cancel(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(undefined);
    void this.redraw(p.request);
  }

  private async redraw(request: InlineRequest): Promise<void> {
    const tree = this.tree();
    if (!tree) return;
    if (request.kind === "rename") tree.rerender();
    else await tree.refresh(request.path);
  }
}
