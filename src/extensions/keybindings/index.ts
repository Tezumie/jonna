// Built-in Keybindings: the user's keybindings.json (JSONC array of { key, command, when?, args?,
// mac? }; "-command" removes a default), loaded at start and live-reloaded, plus the "Keyboard
// shortcuts" dock tab with conflict flags. Writes keep the file's comments when appending.
import type { Caller } from "../../core/dispatcher/types";
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import {
  addBinding,
  applyRuleEdits,
  type BindingRef,
  changeKey,
  changeWhen,
  type RuleEdit,
  removeBinding,
} from "../../core/keybindings/edit";
import {
  effectiveBindings,
  type KeybindingRule,
  parseKeybinding,
  validateUserKeybindings,
} from "../../core/keybindings/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { appendJsoncArrayItem } from "../../core/settings/jsoncEdit";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { referenceText } from "./reference";
import { printReference, referenceViewDescriptor, shortcutsReference } from "./referenceView";
import { keybindingsViewDescriptor } from "./view";

export interface KeybindingsState {
  problems: string[];
  /**
   * The open shortcuts tab edits a binding's `when` in its row (D209, VS Code's inline input);
   * false when the row isn't there (the command asks in a prompt instead).
   */
  editWhenInline?: (ref: { command: string; key: string; when: string }) => boolean;
  /** The when clause being edited in a row, if one is. */
  editingWhen?: () => { command: string; key: string; value: string } | null;
}

export const keybindingsExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, settings, keyboard, dock, state, notifications } = services;
    const status: KeybindingsState = { problems: [] };

    const read = async (): Promise<string> => {
      const path = settings.keybindingsPath;
      if (!path) return "";
      return fsIpc.read(path).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => "",
      );
    };
    const load = async () => {
      const text = await read();
      if (!text.trim()) {
        status.problems = [];
        keyboard.setUserRules([]);
        return;
      }
      const parsed = parseJsonc(text);
      if (!parsed.ok) {
        // Keep the previous rules while the file has a syntax error (typing in progress).
        status.problems = [`${parsed.error.message} (line ${parsed.error.line})`];
        return;
      }
      const { rules, problems } = validateUserKeybindings(parsed.value);
      status.problems = problems;
      keyboard.setUserRules(rules);
      if (problems.length > 0)
        notifications.show("warning", `keybindings.json: ${problems.slice(0, 2).join("; ")}`);
    };
    sub.add(settings.onDidChangeKeybindingsFile(() => void load()));
    void load();

    const write = async (next: string) => {
      const path = settings.keybindingsPath;
      if (!path) throw new Error("Keybindings are only available in the desktop app.");
      await fsIpc.write(path, new TextEncoder().encode(next));
      await load();
    };
    const append = async (...rules: KeybindingRule[]) => {
      let next = await read();
      for (const rule of rules) next = appendJsoncArrayItem(next, rule);
      await write(next);
    };
    /**
     * Extensions don't edit the user's keybindings.json (they contribute keys in their manifest):
     * a key the user presses runs its command as the user, without the extension's permissions.
     */
    const notFromExtension = (caller: Caller) => {
      if (caller.kind === "ext")
        throw new Error("Extensions can't change your keybindings (contribute them instead).");
    };
    // A dispatcher command, or one of the editor's own (Monaco's, D204).
    const checkCommand = (command: string) => {
      if (!dispatcher.has(command) && !keyboard.engineOwns(command))
        throw new Error(`Unknown command: ${command}`);
    };
    /** The binding of `command` on `key` (and `when`, when given) in the effective table. */
    const bindingRef = (command: string, key: string, when?: string): BindingRef => {
      let chords: string;
      try {
        chords = parseKeybinding(key).join(" ");
      } catch {
        throw new Error(`Can't read the key "${key}".`);
      }
      const found = effectiveBindings(keyboard.allRules, keyboard.platformName).filter(
        (b) =>
          b.command === command &&
          b.chords.join(" ") === chords &&
          (when === undefined || (b.when ?? "") === when.trim()),
      );
      const b = found[found.length - 1];
      if (!b) throw new Error(`${command} isn't bound to ${key}${when ? ` when ${when}` : ""}.`);
      return {
        command,
        key: chords,
        when: b.when,
        source: b.source,
        ...(b.args !== undefined && { args: b.args }),
      };
    };
    /** Applies per-binding edits to keybindings.json (comments kept). */
    const editFile = async (make: (entries: unknown[]) => RuleEdit[]) => {
      const text = await read();
      const parsed = parseJsonc(text || "[]");
      if (!parsed.ok || !Array.isArray(parsed.value))
        throw new Error("keybindings.json has errors; fix them first.");
      const edits = make(parsed.value);
      if (edits.length) await write(applyRuleEdits(text, edits));
      return edits.length;
    };

    sub.add(dock.views.register(keybindingsViewDescriptor(services, status)));
    sub.add(dock.views.register(referenceViewDescriptor(services)));

    // VS Code's Help → Keyboard shortcuts reference (a PDF there; a tab built from our table here).
    sub.add(
      dispatcher.register({
        id: "keybindings.showReference",
        title: "Keyboard shortcuts reference",
        category: "Help",
        description:
          "Opens a printable sheet of the main keyboard shortcuts for this platform (general, editing, navigation, search, multi-cursor, languages, editors, display, debug, terminal), with the user's own keys. Returns the sheet as text too.",
        input: s.empty(),
        effects: [],
        agent: "discoverable",
        run: (_input, ctx) => {
          const text = referenceText(shortcutsReference(services));
          if (ctx.caller.kind === "agent" || ctx.caller.kind === "mcp") return { text };
          const tabId = dock.openView("keybindingsReference", null, "main", true);
          return { tabId, text };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.printReference",
        title: "Print keyboard shortcuts reference",
        category: "Help",
        description: "Opens the print dialog for the keyboard shortcuts reference sheet.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: (_input, ctx) => {
          // A test run can't answer a print dialog.
          if (ctx.caller.kind === "test") return { printed: false };
          printReference(services);
          return { printed: true };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "keybindings.show",
        title: "Keyboard shortcuts",
        category: "Preferences",
        description: "Opens the keyboard shortcuts tab (all commands, their keys, conflicts).",
        input: s.object({ query: s.string().describe("Filter text").optional() }),
        effects: [],
        agent: "hidden",
        run: ({ query }) => {
          const tabId = dock.openView("keybindings", query ? { query } : null, "main", true);
          return { tabId };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.openJson",
        title: "Open keyboard shortcuts (JSON)",
        category: "Preferences",
        description: "Opens keybindings.json in an editor tab (created empty if missing).",
        input: s.empty(),
        effects: ["write"],
        agent: "discoverable",
        run: async (_input, ctx) => {
          const path = settings.keybindingsPath;
          if (!path) throw new Error("Keybindings are only available in the desktop app.");
          if (!(await read())) await write("[\n]\n");
          await ctx.execute("editor.openFile", { path });
          return { path };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.set",
        title: "Change keybinding",
        category: "Preferences",
        description:
          "Binds `key` (e.g. 'ctrl+alt+t' or 'ctrl+k ctrl+t') to `command` in keybindings.json, replacing the command's other bindings unless `keepExisting`.",
        input: s.object({
          command: s.string().describe("Command id"),
          key: s.string().describe("Key or chord sequence"),
          when: s.string().describe("Context clause, e.g. editorFocus").optional(),
          keepExisting: s.boolean().describe("Add instead of replacing").optional(),
        }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ command, key, when, keepExisting }, ctx) => {
          notFromExtension(ctx.caller);
          checkCommand(command);
          const rules: KeybindingRule[] = keepExisting ? [] : [{ key: "", command: `-${command}` }];
          rules.push({ key, command, ...(when && { when }) });
          await append(...rules);
          return { label: keyboard.labelFor(command) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.remove",
        title: "Remove keybinding",
        category: "Preferences",
        description:
          "Unbinds `command`: with `key` (and `when`), only that binding (the user's entry is deleted, a default one gets a '-command' rule for that key, VS Code's way); without, every key of the command.",
        input: s.object({
          command: s.string().describe("Command id"),
          key: s.string().describe("The binding's key, e.g. 'ctrl+d'").optional(),
          when: s
            .string()
            .describe("The binding's when clause, to tell same-key bindings apart")
            .optional(),
        }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ command, key, when }, ctx) => {
          notFromExtension(ctx.caller);
          checkCommand(command);
          if (!key) {
            await append({ key: "", command: `-${command}` });
            return { removed: "all" };
          }
          const ref = bindingRef(command, key, when);
          await editFile((entries) => removeBinding(entries, ref, keyboard.platformName));
          return { removed: ref.key, source: ref.source };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.changeKey",
        title: "Change one keybinding",
        category: "Preferences",
        description:
          "Moves one binding of `command` from `key` (its current key; `when` tells same-key ones apart) to `newKey`: the user's entry is changed in place, a default one is replaced by a removal rule plus the new rule (VS Code's keyboard shortcuts editor). Works for the editor's own commands too (editor.action.*).",
        input: s.object({
          command: s.string().describe("Command id"),
          key: s.string().describe("Current key, e.g. 'ctrl+d'"),
          newKey: s.string().describe("New key or chord sequence"),
          when: s.string().describe("The binding's when clause").optional(),
        }),
        effects: ["write"],
        agent: "discoverable",
        palette: false,
        run: async ({ command, key, newKey, when }, ctx) => {
          notFromExtension(ctx.caller);
          checkCommand(command);
          parseKeybinding(newKey);
          const ref = bindingRef(command, key, when);
          await editFile((entries) => changeKey(entries, ref, newKey, keyboard.platformName));
          return { label: keyboard.labelForKeys(newKey) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.changeWhen",
        title: "Change when expression",
        category: "Preferences",
        description:
          "Sets the `when` clause of one binding of `command` (on `key`; `currentWhen` tells same-key ones apart); asked when `when` is omitted, empty removes it. A default binding is replaced by a removal rule plus the same key with the new clause.",
        input: s.object({
          command: s.string().describe("Command id"),
          key: s.string().describe("The binding's key, e.g. 'ctrl+d'"),
          when: s.string().describe("New when clause ('' for always)").optional(),
          currentWhen: s.string().describe("The binding's current when clause").optional(),
        }),
        effects: ["write"],
        agent: "discoverable",
        palette: false,
        run: async ({ command, key, when, currentWhen }, ctx) => {
          notFromExtension(ctx.caller);
          checkCommand(command);
          const ref = bindingRef(command, key, currentWhen);
          // The user, from the shortcuts tab: the row's when column becomes an input (D209).
          if (
            when === undefined &&
            (ctx.caller.kind === "user" || ctx.caller.kind === "test") &&
            status.editWhenInline?.({ command, key, when: currentWhen ?? ref.when ?? "" })
          )
            return { editing: true };
          const next =
            when ??
            (await services.quickInput.prompt({
              prompt: `When expression for ${command} (empty: always)`,
              placeholder: "e.g. editorTextFocus && !editorReadonly",
              value: ref.when ?? "",
            }));
          if (next === undefined) return null;
          const changed = await editFile((entries) =>
            changeWhen(entries, ref, next, keyboard.platformName),
          );
          return { when: next.trim() || null, changed: changed > 0 };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.add",
        title: "Add keybinding",
        category: "Preferences",
        description:
          "Adds `key` for `command` (with an optional `when`), keeping its other keys. Works for the editor's own commands too (editor.action.*).",
        input: s.object({
          command: s.string().describe("Command id"),
          key: s.string().describe("Key or chord sequence"),
          when: s.string().describe("Context clause").optional(),
        }),
        effects: ["write"],
        agent: "discoverable",
        palette: false,
        run: async ({ command, key, when }, ctx) => {
          notFromExtension(ctx.caller);
          checkCommand(command);
          parseKeybinding(key);
          await editFile(() => addBinding(command, key, when));
          return { label: keyboard.labelForKeys(key) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.reset",
        title: "Reset keybinding",
        category: "Preferences",
        description:
          "Removes the user's rules for `command` from keybindings.json, restoring the default keys. Rewrites the file (comments are not kept).",
        input: s.object({ command: s.string().describe("Command id") }),
        effects: ["write"],
        agent: "discoverable",
        run: async ({ command }, ctx) => {
          notFromExtension(ctx.caller);
          const parsed = parseJsonc((await read()) || "[]");
          if (!parsed.ok || !Array.isArray(parsed.value))
            throw new Error("keybindings.json has errors; fix them first.");
          const kept = parsed.value.filter((e) => {
            const c = (e as { command?: unknown } | null)?.command;
            return c !== command && c !== `-${command}`;
          });
          await write(`${JSON.stringify(kept, null, 2)}\n`);
          return { removed: parsed.value.length - kept.length };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "keybindings.list",
        title: "List keybindings",
        category: "Preferences",
        description:
          "Returns effective keybindings (command, key label, when, source default/user, engine: the editor's own such as Ctrl+D or Alt+Up, conflicts), optionally filtered by text.",
        input: s.object({ query: s.string().describe("Filter by command id or key").optional() }),
        effects: ["read"],
        agent: "discoverable",
        run: ({ query }) => {
          const q = query?.toLowerCase();
          return effectiveBindings(keyboard.allRules, keyboard.platformName).filter(
            (b) => !q || b.command.toLowerCase().includes(q) || b.label.toLowerCase().includes(q),
          );
        },
      }),
    );
    sub.add(
      state.register("ide://keybindings", {
        description:
          "keybindings.json path, problems in it, user rule count, how many of the editor's own bindings are listed (engineBindings, once the editor has loaded), keys bound to more than one command (conflicts), keys the IDE and the editor share and how each is settled (resolved: in an editor the editor's binding runs when its condition holds; a user's keybinding wins), and the when clause being edited in the shortcuts tab (editingWhen).",
        get: () => {
          const table = effectiveBindings(keyboard.allRules, keyboard.platformName);
          return {
            file: settings.keybindingsPath,
            problems: status.problems,
            userRules: keyboard.allRules.filter((r) => r.source === "user").length,
            engineBindings: table.filter((b) => b.engine).length,
            conflicts: table
              .filter((b) => b.conflicts.length > 0)
              .map((b) => ({ key: b.label, command: b.command, with: b.conflicts, when: b.when })),
            resolved: table
              .filter((b) => b.resolved.length > 0)
              .map((b) => ({
                key: b.label,
                command: b.command,
                with: b.resolved.map((r) => r.command),
                note: b.resolved.map((r) => r.note).join(" "),
              })),
            editingWhen: status.editingWhen?.() ?? null,
          };
        },
      }),
    );
  },
};
