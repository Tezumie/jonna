// The editor engine's own keybindings in the IDE's keyboard table (D204): once Monaco has loaded,
// its defaults (Ctrl+D, Alt+Up, Ctrl+/, F12…) are listed in the keyboard shortcuts editor and
// can be rebound like the IDE's; the user's keybindings.json rules for Monaco commands are handed
// to Monaco, which honours them with its own `when` contexts.
import type { KeybindingRule } from "../../core/keybindings/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { EditorService } from "./service";

/**
 * Monaco's standalone actions the IDE has its own command for on the same key (VS Code's
 * workbench has these too, and no such editor actions): the editor's binding is taken away so the
 * IDE's runs in an editor as well (D209).
 */
const REPLACED_BY_IDE = new Set([
  "editor.action.quickCommand", // F1: the IDE's command palette
  "editor.action.quickOutline", // Ctrl+Shift+O: the IDE's go to symbol
  "editor.action.gotoLine", // Ctrl+G: the IDE's go to line
]);

export function connectEngineKeybindings(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { keyboard, dispatcher } = services;
  void editors
    .ensureEngine()
    .then((engine) => {
      if (sub.isDisposed || !engine.keybindings || !engine.setUserKeybindings) return;
      const setUser = engine.setUserKeybindings.bind(engine);
      let lastSkipped = "[]";
      const bindings = engine.keybindings();
      const actions = engine.actions?.() ?? [];
      const titles = new Map<string, string>();
      for (const a of actions) titles.set(a.id, a.title);
      for (const b of bindings) if (b.title) titles.set(b.command, b.title);
      const defaults: KeybindingRule[] = bindings
        .filter((b) => !REPLACED_BY_IDE.has(b.command))
        .map((b) => ({
          key: b.key,
          command: b.command,
          ...(b.when && { when: b.when }),
          ...(b.args !== undefined && { args: b.args }),
        }));
      const removals: KeybindingRule[] = bindings
        .filter((b) => REPLACED_BY_IDE.has(b.command))
        .map((b) => ({ key: b.key, command: `-${b.command}` }));
      sub.add(
        keyboard.setEngine({
          defaults,
          has: (id) => engine.hasCommand?.(id) ?? false,
          title: (id) => titles.get(id),
          actions: () => actions,
          handles: (e) => engine.handlesKey?.(e) ?? false,
          chordCommand: (first, second) => engine.chordCommand?.(first, second) ?? null,
          apply: (rules) => {
            // The replaced actions' keys go first, so the user can still bind them again.
            const skipped = setUser([...removals, ...rules], keyboard.platformName);
            // Rules are re-applied on every keybinding change: tell about the same ones once.
            const said = JSON.stringify(skipped);
            if (said === lastSkipped) return;
            lastSkipped = said;
            if (skipped.length)
              services.notifications.show(
                "warning",
                `keybindings.json: the editor can't use ${skipped.map((r) => `"${r.key}"`).join(", ")} (one or two keys the editor knows).`,
              );
          },
          // The second key of a chord the IDE resolved: the rule's `args` go along (D207).
          run: (command, args) =>
            void dispatcher
              .execute("editor.runAction", { action: command, ...(args !== undefined && { args }) })
              .catch(() => {}),
        }),
      );
    })
    .catch(() => {});
}
