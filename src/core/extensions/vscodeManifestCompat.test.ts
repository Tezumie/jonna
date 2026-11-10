// VS Code packages' contributions as VS Code reads them: keybindings for commands they don't
// declare, configurationDefaults, views in other extensions' containers, setting scopes, shared
// settings, and workspaceContains globs. Fixtures modeled on the real packages (Jupyter Keymap,
// ms-python, Pyrefly, Jupyter Cell Tags).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsModel } from "../settings/model";
import { SettingsRegistry } from "../settings/schema";
import { extensionMayWriteSetting, parseManifest } from "./thirdParty";
import { builtinCommand, isVscodeBuiltinId } from "./vscode/builtinCommands";
import {
  type KeybindingTargets,
  parseViewContainers,
  placeInContainer,
  resolveVscodeKeybindings,
} from "./vscodePackage";
import { expandBraces, globSearchTerms } from "./workspaceContains";

const FOCUS = "notebookEditorFocused && !inputFocus && !notebookOutputInputFocused";

/** ms-toolsai.jupyter-keymap 1.1.2: no code, 18 rules for VS Code's own commands. */
const JUPYTER_KEYMAP = {
  name: "jupyter-keymap",
  publisher: "ms-toolsai",
  version: "1.1.2",
  displayName: "Jupyter Keymap",
  contributes: {
    keybindings: [
      { key: "F", when: FOCUS, command: "notebook.find" },
      { key: "K", when: FOCUS, command: "list.focusUp" },
      { key: "J", when: FOCUS, command: "list.focusDown" },
      { key: "A", when: FOCUS, command: "notebook.cell.insertCodeCellAboveAndFocusContainer" },
      { key: "B", when: FOCUS, command: "notebook.cell.insertCodeCellBelowAndFocusContainer" },
      { key: "D D", when: FOCUS, command: "notebook.cell.delete" },
      { key: "Z", when: FOCUS, command: "undo" },
      { key: "S", when: FOCUS, command: "workbench.action.files.save" },
      { key: "C", when: FOCUS, command: "notebook.cell.copy" },
      { key: "X", when: FOCUS, command: "notebook.cell.cut" },
      { key: "V", when: FOCUS, command: "notebook.cell.paste" },
      { key: "shift+L", when: FOCUS, command: "notebook.toggleLineNumbers" },
      { key: "O", when: FOCUS, command: "notebook.cell.toggleOutputs" },
      { key: "L", when: FOCUS, command: "notebook.cell.toggleLineNumbers" },
      {
        key: "ctrl+shift+-",
        when: "editorTextFocus && inputFocus && notebookEditorFocused",
        command: "notebook.cell.split",
      },
      {
        key: "ctrl+enter",
        when: "editorTextFocus && inputFocus && notebookEditorFocused || notebookCellListFocused",
        command: "notebook.cell.executeAndFocusContainer",
      },
      {
        key: "shift+enter",
        when: "notebookCellListFocused && notebookCellType == 'code'",
        command: "notebook.cell.executeAndSelectBelow",
      },
      {
        win: "ctrl+alt+enter",
        linux: "ctrl+alt+enter",
        when: "interactiveEditorHasProvider && interactiveEditorVisible",
        command: "interactive.acceptChanges",
      },
    ],
  },
};

/** The IDE's commands these resolve to (what the dispatcher has). */
const IDE_COMMANDS = new Set([
  "notebook.find",
  "notebook.insertCell",
  "notebook.deleteCell",
  "notebook.copyCell",
  "notebook.cutCell",
  "notebook.pasteCell",
  "notebook.toggleLineNumbers",
  "notebook.toggleOutput",
  "notebook.splitCell",
  "notebook.runCell",
  "edit.undo",
  "editor.save",
  "editor.runAction",
]);

const targets = (extra: Partial<KeybindingTargets> = {}): KeybindingTargets => ({
  has: (id) => IDE_COMMANDS.has(id),
  declaredElsewhere: () => undefined,
  ...extra,
});

test("Jupyter Keymap: every rule kept with VS Code's id, then resolved to the IDE's commands", () => {
  const m = parseManifest(JUPYTER_KEYMAP, "package.json");
  const rules = m.contributes.keybindings;
  assert.equal(rules.length, 18);
  assert.ok(rules.every((r) => r.vscodeCommand === r.command));
  // `win` first on Windows (the last rule has no `key`).
  assert.equal(rules[17]?.key, "ctrl+alt+enter");

  const { rules: out, warnings } = resolveVscodeKeybindings(rules, targets());
  const by = (key: string) => out.find((r) => r.key === key);
  assert.equal(by("F")?.command, "notebook.find");
  assert.deepEqual(by("A")?.args, { where: "above", kind: "code" });
  assert.equal(by("A")?.command, "notebook.insertCell");
  assert.deepEqual(by("B")?.args, { where: "below", kind: "code" });
  assert.equal(by("D D")?.command, "notebook.deleteCell");
  assert.equal(by("Z")?.command, "edit.undo");
  assert.equal(by("S")?.command, "editor.save");
  assert.equal(by("C")?.command, "notebook.copyCell");
  // VS Code's notebook-wide toggle, and the cell's.
  assert.deepEqual(by("shift+L")?.args, { all: true });
  assert.equal(by("L")?.args, undefined);
  assert.equal(by("O")?.command, "notebook.toggleOutput");
  assert.equal(by("ctrl+shift+-")?.command, "notebook.splitCell");
  assert.equal(by("ctrl+enter")?.command, "notebook.runCell");
  assert.deepEqual(by("shift+enter")?.args, { advance: true });
  // The `when` stays VS Code's (the keys apply only where it holds).
  assert.equal(by("F")?.when, FOCUS);
  assert.ok(out.every((r) => !("vscodeCommand" in r)));
  // List focus and the inline chat's accept have nothing here: skipped, each with a warning.
  assert.deepEqual(
    rules.filter((r) => !out.some((o) => o.key === r.key)).map((r) => r.vscodeCommand),
    ["list.focusUp", "list.focusDown", "interactive.acceptChanges"],
  );
  assert.equal(warnings.length, 3);
  assert.match(warnings[0] ?? "", /list\.focusUp/);
});

/** ms-python.python's keys: declared commands and ones its code registers. */
const PYTHON = {
  name: "python",
  publisher: "ms-python",
  version: "2025.1.0",
  main: "./out/client/extension",
  contributes: {
    commands: [{ command: "python.execSelectionInTerminal", title: "Run selection" }],
    keybindings: [
      {
        command: "python.execSelectionInTerminal",
        key: "shift+enter",
        when: "editorTextFocus && editorLangId == python",
      },
      {
        command: "python.execInREPLEnter",
        key: "enter",
        when: "isCompositeNotebook && activeEditor == 'workbench.editor.repl'",
      },
      { command: "jupyter.runcurrentcell", key: "ctrl+alt+r", args: { x: 1 } },
      { command: "interactive.input.clear", key: "ctrl+l" },
      { command: "-editor.action.commentLine", key: "shift+alt+f" },
      { command: "-somebody.else", key: "ctrl+q" },
    ],
  },
};

test("ms-python: code-registered commands go through its hidden command, others resolve or warn", () => {
  const m = parseManifest(PYTHON, "package.json");
  const rules = m.contributes.keybindings;
  assert.equal(rules[0]?.command, "python.execSelectionInTerminal");
  assert.equal(rules[0]?.vscodeCommand, undefined);
  const { rules: out, warnings } = resolveVscodeKeybindings(
    rules,
    targets({
      shim: "python.runVscodeCommand",
      declaredElsewhere: (id) =>
        id === "jupyter.runcurrentcell" ? "jupyter.runCurrentCell" : undefined,
    }),
  );
  assert.deepEqual(out[1], {
    key: "enter",
    command: "python.runVscodeCommand",
    when: "isCompositeNotebook && activeEditor == 'workbench.editor.repl'",
    args: { id: "python.execInREPLEnter", arguments: [], resolve: true },
  });
  // Another extension's declared command: its dispatcher id, VS Code's argument kept.
  assert.deepEqual(out[2]?.command, "jupyter.runCurrentCell");
  assert.deepEqual(out[2]?.args, { arguments: [{ x: 1 }] });
  // A removal of VS Code's own command removes the IDE's binding of it.
  assert.deepEqual(out[3], { key: "shift+alt+f", command: "-editor.runAction" });
  assert.equal(out.length, 4);
  // VS Code's interactive window command: nothing here, and its code can't have it either.
  assert.ok(warnings.some((w) => w.includes("interactive.input.clear")));
  assert.ok(warnings.some((w) => w.includes("-somebody.else")));
});

test("VS Code's built-in command ids: notebook, editor and workbench ones map to the IDE's", () => {
  assert.deepEqual(builtinCommand("notebook.cell.changeToMarkdown"), {
    command: "notebook.changeCellType",
    input: { kind: "markdown" },
  });
  assert.equal(builtinCommand("workbench.action.files.save")?.command, "editor.save");
  assert.equal(builtinCommand("redo")?.command, "edit.redo");
  assert.equal(builtinCommand("outline.focus")?.command, "outline.show");
  assert.deepEqual(builtinCommand("editor.action.commentLine"), {
    command: "editor.runAction",
    input: { action: "editor.action.commentLine" },
  });
  assert.equal(builtinCommand("python.execInREPL"), undefined);
  assert.ok(isVscodeBuiltinId("undo"));
  assert.ok(isVscodeBuiltinId("list.focusUp"));
  assert.ok(!isVscodeBuiltinId("python.execInREPLEnter"));
  assert.ok(!isVscodeBuiltinId("jupyter.runcurrentcell"));
});

/** meta.pyrefly's configurationDefaults. */
const PYREFLY = {
  name: "pyrefly",
  publisher: "meta",
  version: "0.40.0",
  main: "./dist/extension",
  contributes: {
    configurationDefaults: {
      "basedpyright.disableLanguageServices": true,
      "editor.semanticTokenColorCustomizations": {
        rules: { "variable.readonly:python": { bold: true } },
      },
      "[python]": { "editor.formatOnType": true, "editor.tabSize": 4 },
      "not a key": 1,
    },
  },
};

test("Pyrefly's configurationDefaults: other extensions' and the IDE's keys, language blocks", () => {
  const m = parseManifest(PYREFLY, "package.json");
  const defaults = m.contributes.configurationDefaults ?? {};
  assert.deepEqual(Object.keys(defaults), [
    "basedpyright.disableLanguageServices",
    "editor.semanticTokenColorCustomizations",
    "[python]",
  ]);

  const registry = new SettingsRegistry();
  registry.register({
    "editor.semanticTokenColorCustomizations": {
      type: "object",
      default: { enabled: true },
      description: "x",
    },
    "editor.tabSize": { type: "number", default: 2, description: "x" },
    "editor.formatOnType": { type: "boolean", default: false, description: "x" },
    "terminal.shellPath": { type: "string", default: "", description: "x", scope: "user" },
  });
  const model = new SettingsModel(registry);
  const undo = registry.registerDefaults("meta.pyrefly", {
    ...defaults,
    "terminal.shellPath": "evil.exe",
  });
  // An object setting's defaults merge into the declared one.
  assert.deepEqual(model.get("editor.semanticTokenColorCustomizations"), {
    enabled: true,
    rules: { "variable.readonly:python": { bold: true } },
  });
  assert.equal(registry.defaultSource("editor.semanticTokenColorCustomizations"), "meta.pyrefly");
  // Not for a user-only setting (it starts a program).
  assert.equal(model.get("terminal.shellPath"), "");
  // A key not registered yet gets its default once it is (basedpyright loads later).
  registry.register({
    "basedpyright.disableLanguageServices": { type: "boolean", default: false, description: "x" },
  });
  assert.equal(model.get("basedpyright.disableLanguageServices"), true);
  // The language block: above the plain default, below the user's settings.
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 4);
  assert.equal(model.getForLanguage("editor.tabSize", "rust"), 2);
  model.replace("user", { "editor.tabSize": 8 });
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 8);
  model.replace("user", { "[python]": { "editor.tabSize": 3 } });
  assert.equal(model.getForLanguage("editor.tabSize", "python"), 3);
  // A later extension's default wins; taking one back restores what was before.
  const later = registry.registerDefaults("other.ext", { "editor.formatOnType": true });
  assert.equal(model.get("editor.formatOnType"), true);
  later();
  undo();
  assert.equal(model.get("editor.formatOnType"), false);
  assert.deepEqual(model.get("editor.semanticTokenColorCustomizations"), { enabled: true });
  assert.equal(model.getForLanguage("editor.formatOnType", "python"), false);
});

test("a folder's setting beats an extension's language default (multi-root)", () => {
  const registry = new SettingsRegistry();
  registry.register({ "editor.tabSize": { type: "number", default: 2, description: "x" } });
  const model = new SettingsModel(registry);
  registry.registerDefaults("a.b", { "[python]": { "editor.tabSize": 4 } });
  assert.equal(model.getForLanguageAt("editor.tabSize", "python", "f1"), 4);
  model.setFolderLayer("f1", { "editor.tabSize": 6 });
  assert.equal(model.getForLanguageAt("editor.tabSize", "python", "f1"), 6);
});

/** ms-toolsai.vscode-jupyter-cell-tags: its view in Jupyter's panel container. */
const CELL_TAGS = {
  name: "vscode-jupyter-cell-tags",
  publisher: "ms-toolsai",
  version: "0.1.9",
  main: "./out/extension-node.js",
  contributes: {
    views: {
      "jupyter-variables": [
        {
          id: "cell-tag",
          name: "Cell Tags",
          type: "tree",
          icon: "$(tag)",
          when: "jupyter:showTagsExplorer",
        },
      ],
      debug: [{ id: "cellTags.debug", name: "Tags in debug" }],
      test: [{ id: "cellTags.test", name: "Tags in tests" }],
    },
  },
};

test("Cell Tags: a view in Jupyter's container goes to Jupyter's panel; VS Code's own containers map", () => {
  const m = parseManifest(CELL_TAGS, "package.json");
  const [tag, debug, testing] = m.contributes.views;
  // Until the container is found (and when no extension has it): the Explorer, as VS Code does.
  assert.equal(tag?.container, "jupyter-variables");
  assert.equal(tag?.sectionOf, "explorer.view");
  assert.equal(debug?.sectionOf, "debug.view");
  assert.equal(debug?.container, undefined);
  assert.equal(testing?.sectionOf, "testing.view");

  const jupyter = parseViewContainers({
    activitybar: [{ id: "jupyter", title: "Jupyter", icon: "$(notebook)" }],
    panel: [
      {
        id: "jupyter-variables",
        title: "Jupyter",
        icon: "$(notebook)",
        when: "isWorkspaceTrusted",
      },
    ],
  });
  const panel = jupyter.find((c) => c.id === "jupyter-variables");
  assert.ok(panel);
  assert.equal(panel.where, "panel");
  const placed = placeInContainer(tag as NonNullable<typeof tag>, panel);
  assert.equal(placed.location, "panel");
  assert.equal(placed.title, "Jupyter: Cell Tags");
  // Its own icon stays; the container's `when` joins its own.
  assert.equal(placed.icon, "tag");
  assert.equal(placed.when, "(isWorkspaceTrusted) && (jupyter:showTagsExplorer)");
  assert.equal(placed.sectionOf, undefined);
  assert.equal(placed.container, undefined);
});

test("setting scopes: machine-overridable and program paths need a trusted folder; blocked areas warn", () => {
  const m = parseManifest(
    {
      name: "python",
      publisher: "ms-python",
      version: "1.0.0",
      main: "./out/extension",
      capabilities: { untrustedWorkspaces: { restrictedConfigurations: ["python.venvFolders2"] } },
      contributes: {
        configuration: {
          properties: {
            "python.defaultInterpreterPath": {
              type: "string",
              default: "python",
              scope: "machine-overridable",
            },
            "python.useEnvironmentsExtension": {
              type: "boolean",
              default: false,
              scope: "machine-overridable",
            },
            "python.condaPath": { type: "string", default: "", scope: "machine" },
            "python.analysis.typeCheckingMode": { type: "string", default: "off" },
            "python.venvFolders2": { type: "array", default: [] },
            "agent.pythonHelper": { type: "boolean", default: true },
            "debug.javascript.autoAttach": { type: "boolean", default: true },
          },
        },
      },
    },
    "package.json",
  );
  const s = m.contributes.settings;
  assert.equal(s["python.defaultInterpreterPath"]?.scope, undefined);
  assert.equal(s["python.defaultInterpreterPath"]?.restricted, true);
  assert.equal(s["python.useEnvironmentsExtension"]?.restricted, true);
  assert.equal(s["python.condaPath"]?.scope, "user");
  assert.equal(s["python.analysis.typeCheckingMode"]?.restricted, undefined);
  assert.equal(s["python.venvFolders2"]?.restricted, true);
  // VS Code reserves no names: js-debug's `debug.javascript.*` is declared…
  assert.ok(s["debug.javascript.autoAttach"]);
  // …but the agent's area isn't, with a warning for the extension's log.
  assert.equal(s["agent.pythonHelper"], undefined);
  assert.ok(m.warnings?.some((w) => w.startsWith("Setting agent.pythonHelper skipped")));
});

test("a shared setting: every extension that declared it may change it", () => {
  const registry = new SettingsRegistry();
  registry.register({
    "python.defaultInterpreterPath": {
      type: "string",
      default: "",
      description: "x",
      extension: "ms-python.python",
    },
  });
  const drop = registry.addOwner("python.defaultInterpreterPath", "meta.pyrefly");
  assert.deepEqual(registry.owners("python.defaultInterpreterPath"), [
    "ms-python.python",
    "meta.pyrefly",
  ]);
  const owners = registry.owners("python.defaultInterpreterPath");
  assert.ok(
    extensionMayWriteSetting("meta.pyrefly", "python.defaultInterpreterPath", "user", owners),
  );
  assert.ok(
    !extensionMayWriteSetting("evil.python", "python.defaultInterpreterPath", "user", owners),
  );
  drop();
  assert.deepEqual(registry.owners("python.defaultInterpreterPath"), ["ms-python.python"]);
});

test("workspaceContains globs: what the index's quick search is asked first", () => {
  assert.deepEqual(expandBraces("**/*.{py,ipynb}"), ["**/*.py", "**/*.ipynb"]);
  assert.deepEqual(globSearchTerms("**/*.{py,ipynb}"), [".py", ".ipynb"]);
  assert.deepEqual(globSearchTerms("**/requirements*.txt"), ["requirements.txt"]);
  assert.deepEqual(globSearchTerms("**/.venv/**"), [".venv"]);
  assert.deepEqual(globSearchTerms("**/*"), []);
  assert.deepEqual(globSearchTerms("src/[ab]*.ts"), [".ts"]);
});

test("audit: a keybinding whose key can't be read is skipped with a warning", () => {
  const { rules: out, warnings } = resolveVscodeKeybindings(
    [
      { key: "ctrl+shift+", command: "editor.save", vscodeCommand: "workbench.action.files.save" },
      { key: "ctrl+s", mac: "cmd+a+b", command: "editor.save" },
      { key: "ctrl+k ctrl+o", command: "editor.save" },
    ],
    targets(),
  );
  assert.deepEqual(
    out.map((r) => [r.key, r.mac]),
    [
      ["ctrl+s", undefined],
      ["ctrl+k ctrl+o", undefined],
    ],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /"ctrl\+shift\+".*can't read the key/);
  assert.match(warnings[1] ?? "", /macOS/);
});
