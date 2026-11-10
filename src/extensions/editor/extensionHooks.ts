// What extensions plug into the editor beside their providers and decorations (D248)
// (workbench/extensionHooks.ts): the `type` override (typed text goes to the extension; its
// `default:type` is `editor.typeDefault`), the cursor style it sets for every editor, and its
// will-save participants (edits applied before a text file is written).
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { SaveReason } from "../../workbench/extensionHooks";
import type { WorkbenchServices } from "../../workbench/services";
import { applyTextEdits } from "../../workbench/textEdits";
import type { EditorDocument, EditorService } from "./service";
import type { EditorSettings } from "./settings";

/** The editor settings with an extension's cursor style over `editor.cursorStyle`. */
export function withExtensionCursor(
  settings: EditorSettings,
  services: WorkbenchServices,
): EditorSettings {
  const style = services.extensionFeatures.hooks.cursorStyle.peek()?.style;
  if (!style) return settings;
  return {
    ...settings,
    editor: { ...settings.editor, advanced: { ...settings.editor.advanced, cursorStyle: style } },
  };
}

export function registerEditorExtensionHooks(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { hooks } = services.extensionFeatures;
  // Typed text to the extension that owns typing; when it fails, the editor types it.
  sub.add(
    effect(() => {
      const owner = hooks.typeOwner.value;
      editors.whenEngine((engine) =>
        engine.setTypeHandler?.(
          owner
            ? (text) =>
                void owner.type(text).catch(() => {
                  engine.typeDefault?.(text);
                })
            : null,
        ),
      );
      return undefined;
    }),
  );
  sub.add({ dispose: () => editors.loadedEngine?.setTypeHandler?.(null) });
  // The owner's `default:type` (runtimeHooks.ts calls it directly).
  hooks.typeDefault = async (text) => (await editors.ensureEngine()).typeDefault?.(text) ?? false;
  sub.add({ dispose: () => (hooks.typeDefault = null) });
  // Extensions' vscode.execute…Provider: every provider the editor has, asked through the engine.
  hooks.executeProvider = async (query) => {
    const engine = await editors.ensureEngine();
    if (!engine.executeProvider) throw new Error("The editor can't answer provider queries.");
    return engine.executeProvider(query);
  };
  sub.add({ dispose: () => (hooks.executeProvider = null) });
  let firstStyle = true;
  sub.add(
    effect(() => {
      hooks.cursorStyle.value;
      if (firstStyle) firstStyle = false;
      else editors.applySettings();
      return undefined;
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "editor.typeDefault",
      title: "Type (without the extension's override)",
      category: "Editor",
      description:
        "Types `text` into the focused editor as the editor itself would (auto-closing brackets, indentation), bypassing an extension that overrides typing (what its `default:type` does).",
      input: s.object({ text: s.string().describe("What to type") }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ text }, ctx) => {
        const owner = hooks.typeOwner.peek();
        if (
          ctx.caller.kind !== "user" &&
          !(ctx.caller.kind === "ext" && ctx.caller.id === owner?.owner)
        )
          throw new Error("Only the extension that handles typing can use default:type.");
        const engine = await editors.ensureEngine();
        return { typed: engine.typeDefault?.(text) ?? false };
      },
    }),
  );
}

/**
 * Extensions' onWillSaveTextDocument (VS Code's, 1.5 s each): their edits go into the document
 * before it's written, one undoable edit each.
 */
export async function runWillSave(
  services: WorkbenchServices,
  doc: EditorDocument,
  languageId: string,
  reason: SaveReason,
): Promise<void> {
  const { hooks } = services.extensionFeatures;
  const model = doc.model.peek();
  if (!model || model.readOnly || !hooks.hasWillSave("text")) return;
  await hooks.runWillSave("text", { path: doc.path.peek(), languageId, reason }, (edits) => {
    const now = doc.model.peek();
    if (now && !now.readOnly) now.replaceText(applyTextEdits(now.getText(), edits));
  });
}
