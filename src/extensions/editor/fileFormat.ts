// Line endings and encodings from the status bar (D199, VS Code's): change a file's end of line
// sequence, reopen it with another encoding (a Windows-1252 file that opened read-only becomes
// editable), save it with another. Each is a command, for the status bar items and agents.

import { encodingIpc, fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { isUtf8 } from "./diskText";
import {
  bomEncoding,
  ENCODINGS,
  encodingForWhatwgName,
  encodingInfo,
  unencodable,
} from "./encodings";
import type { EditorDocument, EditorService } from "./service";

export function registerFileFormatCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  activePath: () => string | undefined,
  /** Kept read-only by the session or `files.readonlyInclude` (D393), whatever the file allows. */
  keptReadOnly: (path: string) => boolean = () => false,
): void {
  const { dispatcher, quickInput, workspace } = services;
  const docFor = (path?: string): EditorDocument => {
    const p = path ? workspace.resolve(path) : activePath();
    const doc = p ? editors.find(p) : undefined;
    if (!doc || doc.kind !== "text") throw new Error("Open a text file first.");
    return doc;
  };
  const pickEncoding = async (
    placeholder: string,
    current: string,
    saving: boolean,
    guessed?: string,
  ) => {
    // The detector's guess first (VS Code's "Guessed from content"), then the list.
    const list = ENCODINGS.filter((e) => !saving || e.canSave);
    const ordered = guessed
      ? [...list.filter((e) => e.id === guessed), ...list.filter((e) => e.id !== guessed)]
      : list;
    const picked = await quickInput.pick(
      ordered.map((e) => ({
        id: e.id,
        label: e.label,
        description: [
          e.id === current ? "current" : "",
          e.id === guessed ? "guessed from content" : "",
          e.canSave ? "" : "read-only",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      { placeholder },
    );
    return picked?.id ?? null;
  };
  /** The detector's guess for a file on disk (D204), as one of our ids. */
  const guessFor = async (path: string): Promise<string | undefined> => {
    try {
      const bytes = await fsIpc.read(path);
      if (isUtf8(bytes)) return bomEncoding(bytes) ?? "utf8";
      const name = await encodingIpc.guess(bytes);
      return name ? encodingForWhatwgName(name)?.id : undefined;
    } catch {
      return undefined;
    }
  };
  const pathInput = s.string().describe("File (default: the active editor)").optional();

  sub.add(
    dispatcher.register({
      id: "editor.changeEol",
      title: "Change end of line sequence",
      category: "File",
      description:
        "Sets a file's line endings to LF or CRLF (asked when `eol` is omitted). The change is one edit (undo restores the old ones) and the file needs saving.",
      input: s.object({ eol: s.enum(["LF", "CRLF"]).optional(), path: pathInput }),
      effects: ["write"],
      run: async ({ eol, path }) => {
        const doc = docFor(path);
        const model = doc.model.peek();
        if (!model) throw new Error("The file isn't loaded yet.");
        // Set read-only in the session too (D407), as VS Code refuses for a read-only editor.
        if (model.readOnly || keptReadOnly(doc.path.peek()))
          throw new Error("The file is read-only.");
        let pick = eol;
        if (!pick) {
          const current = model.eol === "\r\n" ? "CRLF" : "LF";
          const chosen = await quickInput.pick(
            [
              { id: "LF", label: "LF", description: `\\n${current === "LF" ? " · current" : ""}` },
              {
                id: "CRLF",
                label: "CRLF",
                description: `\\r\\n (Windows)${current === "CRLF" ? " · current" : ""}`,
              },
            ],
            { placeholder: "Select end of line sequence" },
          );
          if (!chosen) return null;
          pick = chosen.id as "LF" | "CRLF";
        }
        model.setEol(pick === "CRLF" ? "\r\n" : "\n");
        return { eol: pick };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.selectEncoding",
      title: "Change file encoding…",
      category: "File",
      description:
        "Reopen the file with another encoding, or save it with another (VS Code's encoding picker).",
      input: s.object({ path: pathInput }),
      effects: [],
      agent: "hidden",
      run: async ({ path }) => {
        const doc = docFor(path);
        const how = await quickInput.pick(
          [
            {
              id: "reopen",
              label: "Reopen with encoding",
              description: "Read the file again in another encoding",
            },
            {
              id: "save",
              label: "Save with encoding",
              description: "Write the file in another encoding",
            },
          ],
          { placeholder: `${encodingInfo(doc.encoding)?.label ?? doc.encoding}: select an action` },
        );
        if (!how) return null;
        return dispatcher.execute(
          how.id === "reopen" ? "editor.reopenWithEncoding" : "editor.saveWithEncoding",
          { path: doc.path.peek() },
        );
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.reopenWithEncoding",
      title: "Reopen with encoding…",
      category: "File",
      description: `Reads a file again in another encoding (\`encoding\`: ${ENCODINGS.map((e) => e.id).join(", ")}; asked when omitted). The pick list starts with the encoding guessed from the content. Refused while it has unsaved changes.`,
      input: s.object({ encoding: s.string().optional(), path: pathInput }),
      effects: ["read"],
      run: async ({ encoding, path }) => {
        const doc = docFor(path);
        const enc =
          encoding ??
          (await pickEncoding(
            "Reopen with encoding",
            doc.encoding,
            false,
            await guessFor(doc.path.peek()),
          ));
        if (!enc) return null;
        await editors.reopenWithEncoding(doc, enc);
        return { encoding: enc, readOnly: !encodingInfo(enc)?.canSave };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.saveWithEncoding",
      title: "Save with encoding…",
      category: "File",
      description:
        "Saves a file in another encoding (`encoding`; asked when omitted): UTF-8 with or without a BOM, UTF-16, a single-byte code page, or a Japanese, Chinese or Korean one (Shift JIS, EUC-JP, ISO-2022-JP, GBK, GB 18030, Big5, EUC-KR). Refused when the text has characters that encoding can't hold.",
      input: s.object({ encoding: s.string().optional(), path: pathInput }),
      effects: ["write"],
      run: async ({ encoding, path }) => {
        const doc = docFor(path);
        const enc = encoding ?? (await pickEncoding("Save with encoding", doc.encoding, true));
        if (!enc) return null;
        const info = encodingInfo(enc);
        if (!info?.canSave) throw new Error(`Saving in ${info?.label ?? enc} isn't supported.`);
        const model = doc.model.peek();
        if (!model) throw new Error("The file isn't loaded yet.");
        const bad = unencodable(model.getText(), enc);
        if (bad.length)
          throw new Error(
            `${info.label} can't hold ${bad.map((c) => `"${c}"`).join(", ")}: keep UTF-8, or remove them.`,
          );
        // The document takes the encoding once it's written in it.
        await editors.save(doc, { encoding: enc });
        editors.encodingChanged.fire(doc.path.peek());
        return { encoding: enc, saved: doc.path.peek() };
      },
    }),
  );

  // VS Code's "Select indentation" (D204: the main status bar's Spaces item runs it).
  sub.add(
    dispatcher.register({
      id: "editor.selectIndentation",
      title: "Change indentation…",
      category: "File",
      description:
        "Indent with spaces or tabs, change the tab size, or convert the file's indentation (VS Code's indentation picker). `choice`: spaces | tabs | size2 | size4 | size8 | toSpaces | toTabs (default: the user picks).",
      input: s.object({
        path: pathInput,
        choice: s
          .enum(["spaces", "tabs", "size2", "size4", "size8", "toSpaces", "toTabs"])
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ path, choice }) => {
        const doc = docFor(path);
        const model = doc.model.peek();
        if (!model) throw new Error("Open a text file first.");
        const { insertSpaces, tabSize } = model.indentation();
        let picked = choice;
        if (!picked) {
          const item = await quickInput.pick(
            [
              {
                id: "spaces",
                label: "Indent using spaces",
                description: insertSpaces ? "current" : "",
              },
              {
                id: "tabs",
                label: "Indent using tabs",
                description: insertSpaces ? "" : "current",
              },
              ...[2, 4, 8].map((n) => ({
                id: `size${n}`,
                label: `${insertSpaces ? "Indent size" : "Tab size"} ${n}`,
                description: tabSize === n ? "current" : "",
              })),
              { id: "toSpaces", label: "Convert indentation to spaces" },
              { id: "toTabs", label: "Convert indentation to tabs" },
            ],
            { placeholder: "Select indentation" },
          );
          picked = item?.id as typeof choice;
        }
        if (!picked) return null;
        if (picked === "toSpaces" || picked === "toTabs") {
          // The engine action converts the active editor's file, which `path` may not name.
          const active = activePath();
          if (!active || pathKey(doc.path.peek()) !== pathKey(active))
            throw new Error(
              "Converting indentation works on the active editor: open the file first.",
            );
          await dispatcher.execute("editor.runAction", {
            action:
              picked === "toSpaces"
                ? "editor.action.indentationToSpaces"
                : "editor.action.indentationToTabs",
          });
        } else if (picked === "spaces" || picked === "tabs")
          model.setIndentation({ insertSpaces: picked === "spaces" });
        else model.setIndentation({ tabSize: Number(picked.slice(4)) });
        // The status bar's format items listen to this (no cursor move follows a command).
        editors.encodingChanged.fire(doc.path.peek());
        return { indentation: model.indentation() };
      },
    }),
  );
}
