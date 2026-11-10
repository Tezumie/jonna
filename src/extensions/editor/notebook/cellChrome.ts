// A cell's controls (D204, VS Code's notebook layout in the IDE's look): the toolbar floating at
// the cell's top right on hover or selection (run above / run and below for code, edit or
// preview for Markdown, split, extensions' buttons, "…", delete), the "…" menu (cut, copy,
// paste, insert, change the type or language, join, copy down, move, line numbers, output), and
// the "+ Code / + Markdown" bar in the gap below each cell. Every control runs a command.
import { h, on } from "../../../core/dom/index";
import type { CellKind } from "../../../core/notebook/types";
import { type IconName, icon, knownIcon } from "../../../ui/Icon";
import type { MenuItem } from "../../../ui/Menu";
import { setTooltip } from "../../../ui/Tooltip";

/** An extension's command on cells (`menus` "notebook/cell/title"). */
export interface CellTitleItem {
  command: string;
  title: string;
  icon?: string;
}

/** What a cell's controls need to know (the notebook view answers). */
export interface CellChromeState {
  kind: CellKind;
  index: number;
  count: number;
  editingMarkdown: boolean;
  hasOutputs: boolean;
  outputsCollapsed: boolean;
  lineNumbers: boolean;
  /** Cells copied with Copy / Cut (Paste is off without them). */
  canPaste: boolean;
  /** How many cells are selected when this one is among several (D209), else 1. */
  selectedCount: number;
  /** Extensions' items for this cell (their `when` already checked). */
  extensionItems: readonly CellTitleItem[];
  /** The keybinding label of a command (empty when it has none). */
  keyFor(command: string): string;
}

type Run = (command: string, input?: Record<string, unknown>) => void;

/** Names of common cell languages whose ids don't read well capitalized (VS Code's names). */
const LANGUAGE_NAMES: Record<string, string> = {
  markdown: "Markdown",
  python: "Python",
  sql: "SQL",
  r: "R",
  julia: "Julia",
  javascript: "JavaScript",
  typescript: "TypeScript",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  yaml: "YAML",
  shellscript: "Shell script",
  powershell: "PowerShell",
  csharp: "C#",
  cpp: "C++",
  fsharp: "F#",
  plaintext: "Plain text",
  raw: "Raw",
};

/** A language's name for a cell's label ("python" → "Python"): VS Code's, the engine's, or the id. */
export function languageName(
  engine: { languages(): { id: string; aliases: string[] }[] } | undefined,
  language: string,
): string {
  const named = LANGUAGE_NAMES[language];
  if (named) return named;
  const alias = engine?.languages().find((l) => l.id === language)?.aliases[0];
  if (alias) return alias;
  return language ? `${language[0]?.toUpperCase() ?? ""}${language.slice(1)}` : "Plain text";
}

function toolButton(glyph: IconName, tip: string, onClick: () => void): HTMLElement {
  const b = h(
    "button",
    { class: "icon-button nb-cell-tool", type: "button", "aria-label": tip },
    icon(glyph),
  );
  setTooltip(b, tip);
  on(b, "click", (e) => {
    e.stopPropagation();
    onClick();
  });
  // A press here doesn't take the cell's editor focus or select text.
  on(b, "mousedown", (e) => e.preventDefault());
  return b;
}

const withKey = (label: string, key: string) => (key ? `${label} (${key})` : label);

/** The toolbar's buttons for the cell's state. `menu` opens the "…" menu under its button. */
export function cellToolbarButtons(
  s: CellChromeState,
  run: Run,
  menu: (anchor: HTMLElement) => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (s.kind === "code") {
    out.push(
      toolButton("arrow-up-from-dot", "Run the cells above", () => run("notebook.runAbove")),
      toolButton("arrow-down-to-dot", "Run this cell and the ones below", () =>
        run("notebook.runBelow"),
      ),
    );
  } else if (s.kind === "markdown") {
    out.push(
      s.editingMarkdown
        ? toolButton(
            "check",
            withKey("Stop editing the cell", s.keyFor("notebook.previewCell")),
            () => run("notebook.previewCell"),
          )
        : toolButton("pencil", "Edit the cell (Enter, or double-click)", () =>
            run("notebook.editCell"),
          ),
    );
  }
  // Splitting needs a cursor: a Markdown cell's editor is there only while it's edited.
  if (s.kind !== "markdown" || s.editingMarkdown)
    out.push(
      toolButton(
        "rows-2",
        withKey("Split the cell at the cursor", s.keyFor("notebook.splitCell")),
        () => run("notebook.splitCell"),
      ),
    );
  for (const item of s.extensionItems.filter((i) => i.icon).slice(0, 3))
    out.push(toolButton(knownIcon(item.icon, "circle-dot"), item.title, () => run(item.command)));
  const more = toolButton("ellipsis", "More actions", () => menu(more));
  out.push(
    more,
    toolButton("trash-2", withKey("Delete the cell", "D D"), () => run("notebook.deleteCell")),
  );
  return out;
}

/** The "…" menu's items (VS Code's cell menu). */
export function cellMenuItems(s: CellChromeState, run: Run): MenuItem[] {
  const item = (
    label: string,
    command: string,
    input: Record<string, unknown> = {},
    more: Partial<MenuItem> = {},
  ): MenuItem => ({
    label,
    keybinding: s.keyFor(command) || undefined,
    run: () => run(command, input),
    ...more,
  });
  const insert = (kind: "code" | "markdown", where: "above" | "below"): MenuItem => ({
    label: `${kind === "code" ? "Code" : "Markdown"} cell ${where}`,
    run: () => run("notebook.insertCell", { kind, where }),
  });
  const kinds: [CellKind, string][] = [
    ["code", "Code"],
    ["markdown", "Markdown"],
    ["raw", "Raw"],
  ];
  // Several selected (D209): the menu acts on all of them; these two only make sense then.
  const several: MenuItem[] =
    s.selectedCount > 1
      ? [
          item("Run selected cells", "notebook.runCell", {}, { icon: "play" }),
          item("Join selected cells", "notebook.joinSelectedCells", {}, { separatorBefore: false }),
        ]
      : [];
  const items: MenuItem[] = [
    ...several,
    item(
      "Cut cell",
      "notebook.cutCell",
      {},
      { icon: "scissors", separatorBefore: several.length > 0 },
    ),
    item("Copy cell", "notebook.copyCell", {}, { icon: "copy" }),
    item(
      "Paste cell",
      "notebook.pasteCell",
      {},
      { icon: "clipboard-paste", disabled: !s.canPaste },
    ),
    {
      label: "Insert cell",
      icon: "plus",
      separatorBefore: true,
      submenu: [
        insert("code", "above"),
        insert("code", "below"),
        insert("markdown", "above"),
        insert("markdown", "below"),
      ],
    },
    {
      label: "Change cell to",
      separatorBefore: true,
      submenu: kinds.map(([kind, label]) => ({
        label,
        checked: s.kind === kind,
        run: () => run("notebook.changeCellType", { kind }),
      })),
    },
    ...(s.kind === "code" ? [item("Change cell language…", "notebook.changeCellLanguage")] : []),
    item(
      "Join with previous cell",
      "notebook.joinCells",
      { with: "previous" },
      {
        disabled: s.index === 0,
        keybinding: s.keyFor("notebook.joinCells:previous") || undefined,
      },
    ),
    item(
      "Join with next cell",
      "notebook.joinCells",
      { with: "next" },
      {
        disabled: s.index >= s.count - 1,
        keybinding: s.keyFor("notebook.joinCells:next") || undefined,
      },
    ),
    item(
      "Copy cell down",
      "notebook.duplicateCell",
      {},
      {
        icon: "copy-plus",
        keybinding: s.keyFor("notebook.duplicateCell:down") || undefined,
      },
    ),
    item(
      "Move cell up",
      "notebook.moveCell",
      { by: -1 },
      {
        disabled: s.index === 0,
        keybinding: s.keyFor("notebook.moveCell:up") || undefined,
      },
    ),
    item(
      "Move cell down",
      "notebook.moveCell",
      { by: 1 },
      {
        disabled: s.index >= s.count - 1,
        keybinding: s.keyFor("notebook.moveCell:down") || undefined,
      },
    ),
    item(
      "Show cell line numbers",
      "notebook.toggleLineNumbers",
      {},
      {
        separatorBefore: true,
        checked: s.lineNumbers,
      },
    ),
  ];
  if (s.kind === "code")
    items.push(
      item(
        "Format cell",
        "notebook.formatCell",
        {},
        { keybinding: s.keyFor("notebook.formatCell") || undefined },
      ),
      item(
        "Collapse cell output",
        "notebook.toggleOutput",
        {},
        {
          checked: s.outputsCollapsed,
          disabled: !s.hasOutputs,
        },
      ),
      item("Clear cell output", "notebook.clearOutputs", {}, { disabled: !s.hasOutputs }),
    );
  const fromExtensions = s.extensionItems.filter((i) => !i.icon);
  for (const [i, x] of fromExtensions.entries())
    items.push({ label: x.title, run: () => run(x.command), separatorBefore: i === 0 });
  return items;
}

/**
 * The bar in the gap below a cell (or above the first): "+ Code" and "+ Markdown", shown when
 * the pointer is over the gap (VS Code's between-cell insert toolbar).
 */
export function insertBar(at: () => number, run: Run, extraClass = ""): HTMLElement {
  const add = (kind: "code" | "markdown", label: string) => {
    const b = h(
      "button",
      { class: "nb-insert-button", type: "button" },
      icon("plus"),
      h("span", null, label),
    );
    setTooltip(b, `Add a ${kind === "code" ? "code" : "Markdown"} cell here`);
    on(b, "mousedown", (e) => e.preventDefault());
    on(b, "click", (e) => {
      e.stopPropagation();
      run("notebook.insertCell", { index: at(), kind });
    });
    return b;
  };
  return h(
    "div",
    { class: `nb-insert ${extraClass}`.trim(), role: "toolbar", "aria-label": "Add a cell" },
    h("div", { class: "nb-insert-line" }),
    h("div", { class: "nb-insert-buttons" }, add("code", "Code"), add("markdown", "Markdown")),
  );
}
