// VS Code's `type` command override (Vim keymaps; extensions/runtimeHooks.ts) (D248): while an extension owns
// typing, Monaco's "type" command (each typed character or composed text, in every full editor)
// goes to it instead of into the text, and the extension's `default:type` types as the editor
// would have (auto-closing, auto-indent and all: `trigger("type")` runs the editor's own typing,
// not the command). Monaco runs "type" through its command service exactly so it can be
// overridden: the newest registration wins, and disposing it gives typing back.
import * as monaco from "./core";

export class TypeOverride {
  private registration: monaco.IDisposable | null = null;
  /** The editor the last overridden keystroke was typed in. */
  private target: monaco.editor.ICodeEditor | null = null;

  /** `handler` gets what's typed (null: the editor types it again). */
  set(handler: ((text: string) => void) | null): void {
    this.registration?.dispose();
    this.registration = null;
    this.target = null;
    if (!handler) return;
    this.registration = monaco.editor.registerCommand("type", (_accessor, args: unknown) => {
      const text = (args as { text?: unknown } | null)?.text;
      if (typeof text !== "string") return;
      const editor = focusedEditor();
      if (!editor?.getModel()) return;
      this.target = editor;
      handler(text);
    });
  }

  /** Types `text` into the editor of the last keystroke (or the focused one) as Monaco would. */
  typeDefault(text: string): boolean {
    const focused = focusedEditor();
    const editor = this.target?.hasTextFocus() ? this.target : (focused ?? this.target);
    if (!editor?.getModel()) return false;
    editor.trigger("keyboard", "type", { text });
    return true;
  }

  dispose(): void {
    this.set(null);
  }
}

function focusedEditor(): monaco.editor.ICodeEditor | null {
  return monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? null;
}
