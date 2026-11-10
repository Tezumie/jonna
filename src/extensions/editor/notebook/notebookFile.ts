// A notebook's file (from view.ts, m7.12): its format (the notebook type's serializer, waited
// for a little at startup), reading and writing it, the metadata a save adds (what ran it, the
// widgets' state), and changes made on disk by something else: taken as they are while there
// are no unsaved edits, else a banner offers "Load the file" or "Keep mine".
import { h, on } from "../../../core/dom/index";
import { fsIpc } from "../../../core/ipc/fs";
import type { NotebookType } from "../../../core/notebook/providers";
import type { KernelInfo } from "../../../core/notebook/types";
import type { WorkbenchServices } from "../../../workbench/services";
import type { Notebook } from "./model";
import { WIDGET_STATE_MIME } from "./widgets";

export interface NotebookFileHost {
  services: WorkbenchServices;
  path(): string;
  disposed(): boolean;
  isDirty(): boolean;
  /**
   * The file's notebook replaces what's shown: it changed on disk and there were no unsaved
   * edits, or (`clean`) the user chose the file over them.
   */
  reload(nb: Notebook, clean: boolean): void;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/^﻿/, "");

export class NotebookFile {
  /** The text last read or written (a change on disk to the same text isn't one). */
  savedText = "";
  /** The file format's id (D202): the IDE's Jupyter one or an extension's (looked up each use:
   * an extension that reloads registers a new serializer under the same id). */
  private typeId: string | null = null;
  /** "The file changed on disk while you have unsaved changes." */
  readonly banner = h("div", { class: "nb-banner", hidden: true });
  /** Bumped per change on disk (see changedOnDisk). */
  private reads = 0;

  constructor(private readonly host: NotebookFileHost) {}

  /** The notebook type's id ("jupyter.notebook"), once known. */
  get notebookType(): string {
    return this.typeId ?? this.host.services.notebooks.typeFor(this.host.path())?.id ?? "unknown";
  }

  format(): NotebookType {
    const { notebooks } = this.host.services;
    this.typeId ??= notebooks.typeFor(this.host.path())?.id ?? null;
    const type = this.typeId ? notebooks.type(this.typeId) : undefined;
    if (!type)
      throw new Error(
        "No notebook format is registered for this kind of file (is its extension enabled?).",
      );
    return type;
  }

  /**
   * The format, waiting a little for it at startup: a notebook tab restored with the window can
   * load before the extension that reads it has started.
   */
  private async formatReady(): Promise<NotebookType> {
    for (let waited = 0; ; waited += 250) {
      try {
        return this.format();
      } catch (err) {
        if (waited >= 10_000 || this.host.disposed()) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async deserialize(text: string): Promise<Notebook> {
    return (await this.formatReady()).serializer.deserialize(text);
  }

  /** The file's text (without a BOM). */
  async readText(): Promise<string> {
    return decode(await fsIpc.read(this.host.path()));
  }

  /** Writes `nb` in the file's format. */
  async write(nb: Notebook): Promise<void> {
    const text = await this.format().serializer.serialize(nb);
    await fsIpc.write(this.host.path(), new TextEncoder().encode(text), "save");
    this.savedText = text;
  }

  /** The file changed on disk (files.didChange). */
  async changedOnDisk(): Promise<void> {
    // Two changes in a row: only the latest read is used (an earlier one finishing last would
    // put the older text back).
    const read = ++this.reads;
    const text = await fsIpc.read(this.host.path()).then(decode, () => null);
    if (read !== this.reads || text === null || text === this.savedText) return;
    if (!this.host.isDirty()) {
      this.savedText = text;
      try {
        const nb = await this.deserialize(text);
        if (read !== this.reads || this.host.disposed() || this.host.isDirty()) return;
        this.host.reload(nb, false);
      } catch {
        // A half-written file: the next change brings the rest.
      }
      return;
    }
    this.banner.hidden = false;
    const reload = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      "Load the file",
    );
    const keep = h("button", { class: "button button-sm", type: "button" }, "Keep mine");
    on(reload, "click", () => {
      void this.deserialize(text).then(
        (nb) => {
          this.banner.hidden = true;
          this.savedText = text;
          this.host.reload(nb, true);
        },
        (err: unknown) =>
          this.host.services.notifications.show(
            "error",
            `The file can't be read: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
    });
    on(keep, "click", () => (this.banner.hidden = true));
    this.banner.replaceChildren(
      h("span", null, "The file changed on disk while you have unsaved changes."),
      reload,
      keep,
    );
  }
}

/**
 * The metadata a save writes: what ran the notebook (as Jupyter does, so another computer picks
 * the same kernel) and the widgets' state (so they show when it's opened again). The same
 * object when there's neither.
 */
export function savedMetadata(
  metadata: Record<string, unknown>,
  info: KernelInfo | null | undefined,
  widgetState: unknown,
): Record<string, unknown> {
  let out = metadata;
  if (info)
    out = {
      ...out,
      ...(info.mode === "jupyter" && {
        kernelspec: {
          ...(typeof out.kernelspec === "object" ? (out.kernelspec as object) : {}),
          name: info.kernel,
          display_name: info.display,
          language: info.language,
        },
      }),
      language_info: {
        ...(typeof out.language_info === "object" ? (out.language_info as object) : {}),
        name: info.language,
      },
    };
  if (widgetState)
    out = {
      ...out,
      widgets: {
        ...(typeof out.widgets === "object" ? (out.widgets as object) : {}),
        [WIDGET_STATE_MIME]: widgetState,
      },
    };
  return out;
}
