# extensions/keybindings

The user's `keybindings.json` (config dir; JSONC array of `{ key, mac?, command, when?, args? }`,
`"-command"` removes defaults) loaded into `KeyboardService` after the manifest defaults and
reloaded when the file changes; problems are reported (toast, the tab, `ide://keybindings`).
`view.ts` is the "Keyboard shortcuts" dock tab: search, sources, ⚠ on conflicting keys
(`core/keybindings/effective.ts`), double-click or Enter to record new keys.

**Shortcuts reference** (D200; VS Code's Help → Keyboard shortcuts reference, a PDF there):
`reference.ts` (tested) builds VS Code's sheet sections from the effective keybinding table for
this platform (so the user's own keys show) plus a fixed list of Monaco's own editing keys, which
aren't in the table; `referenceView.ts` is the `keybindingsReference` dock tab (columns that
reflow) and its printout (a copy in a page-level container, `styles/reference.css` hides the rest
and prints in light colors). `keybindings.showReference` (also returns the sheet as text),
`keybindings.printReference`.

**The editor's own keys (D204).** Once Monaco has loaded, its default keybindings (Ctrl+D,
Alt+Up, Ctrl+/, F12…, read from its keybinding service with their `when` clauses and action
titles) are in the table as "Editor" rows, with its unbound actions; `rows.ts` (tested) builds
the rows and the search (text, or a key in quotes: `"ctrl+d"`, any spelling or the label).
keybindings.json rules for Monaco commands (`editor.action.*`, `cursorDown`…, VS Code's ids) are
handed to Monaco as its own user rules (`editor/engineKeybindings.ts`), so its `when` contexts and
`-command` removals work as in VS Code; the IDE's capture listener lets those keys through while an
editor has focus, and runs the second key of an engine chord whose first key it took (Ctrl+K
Ctrl+C), with the rule's `args`. Monaco's commands without an action (cursorDown, deleteLeft…) get
readable titles (`engineTitles.ts`, tested: a table, else the id in words; D207). Row menu: Change keybinding (that binding only), Add keybinding, Change when expression,
Show same keybindings, Remove keybinding, Reset keybinding, copy. Edits keep the file's comments
(`core/keybindings/edit.ts`).

**D209.** Change when expression edits the clause in the row (an input in the When column: Enter
saves, Escape cancels, leaving it saves; `keybindings.changeWhen` without `when` from the user
or a test opens it, an agent's call or a closed tab falls back to the prompt). A key the IDE's
default and an editor default share is *resolved*, not a conflict (`core/keybindings/effective.ts`:
`resolved` with a note; an info mark in the row): in an editor the editor's binding runs when its
own `when` holds (the keyboard service asks Monaco, `engine.handlesKey`, before running the IDE's
command), the IDE's everywhere else, and a user's keybinding wins over both. Clauses that can't
hold together (`explorerFocus` vs the editor's, `isMac` vs `!isMac`) aren't flagged at all.
Monaco's standalone quick command (F1), quick outline (Ctrl+Shift+O) and go to line (Ctrl+G) are
taken from the editor (`engineKeybindings.ts`): the IDE's palette, go to symbol and go to line
run there as in VS Code.

**D219.** Two-key chords too: an IDE default (or an extension's) on a Monaco chord runs the
editor's command in an editor when its binding holds (`engine.chordCommand`, a lookup on Monaco's
resolver with both keys; the IDE took the first key, so it runs the command itself). When-clause
logic is `core/keybindings/whenLogic.ts`: overlap understands `!=`, regex, `in` / `not in`,
numeric ranges and negated groups; a "-command" removal with a `when` takes only the binding with
that clause (`whensEqual`: order, spacing and quotes don't matter), as in VS Code.

**D229.** Conflicts are found with VS Code's constant substitution: `isMac`, `isWindows`,
`isLinux`, `isWeb`… are replaced by their value on this platform first (`platformConstants`), so a
binding whose clause says `isMac` conflicts with nothing on Windows, and `isWindows && editorFocus`
there is the same clause as `editorFocus`. `!(n < 2)` is understood (a number outside the range,
or no number), and two regexes that can't match the same string don't overlap (anchored literal
ends `/\.ts$/` vs `/\.md$/`, or a literal set `/^(ts|js)$/` checked against the other). Three-key
chords aren't compared with the editor's keys: Monaco binds two keys at most, so there's nothing
to share (an IDE three-key chord that starts with an editor chord shadows it, as in VS Code).

**Commands:** `keybindings.show` (Ctrl/Cmd+K Ctrl/Cmd+S), `keybindings.openJson`, `keybindings.set`,
`keybindings.remove {command, key?, when?}`, `keybindings.reset`, `keybindings.changeKey {command,
key, newKey, when?}`, `keybindings.changeWhen {command, key, when?, currentWhen?}`,
`keybindings.add {command, key, when?}`, `keybindings.list`. **State:** `ide://keybindings`
(with `engineBindings`).
