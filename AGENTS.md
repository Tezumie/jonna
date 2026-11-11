# AGENTS.md — Rules for AI agents working in this repo

Read `PLAN.md` first. It is the source of truth for architecture and decisions. If you need to deviate, add an entry to `docs/decisions.md` explaining why.

A few working documents named below were left behind when this repository started (`docs/feature-gaps.md`, `docs/long-term-goals.md`, audits and the owner's checklists; D418). They don't exist here: skip a step that needs one and use the issue tracker for priorities.

## Hard rules
1. **No product name in the code.** The name (Jonna today) lives only in `product.json`, so a rename stays a one-line change. Never write a name into code, comments, identifiers, file names, UI strings or config. Read names from `product.json` (via the generated `src/core/product.ts` in TS, or the build-injected config in Rust). In prose say "the IDE", except in the repository's root `README.md` (the public page), which uses the product's name.
2. **No UI framework.** Vanilla TypeScript + DOM only. Use `core/reactive`, `core/lifecycle`, `core/dom`.
3. **No new runtime dependency** without stating its size, license and why the platform or a small in-house module can't do it — and logging it in `docs/decisions.md`. Licenses must be permissive (MIT/Apache-2.0/BSD/ISC/Zlib/MPL-2.0). **Never GPL/AGPL/LGPL.**
4. **No CDN or network loading at runtime.** Everything is bundled. No telemetry.
5. **Never copy code from GPL/AGPL projects.** The design is our own; VS Code (and Cursor for AI
   features) are the references for behavior.
6. **Every user-visible action is a dispatcher command** with a clear model-readable `description`, an input schema, and correct `effects`. Don't wire UI buttons to logic directly; they call commands.
7. **Every new feature exposes state** through a state-tree path (`ide://…`) where it makes sense, not only UI.
8. **AI is opt-in outside the agent's chat.** The agent panel is on by default; every other
   feature that calls a model (inline edit, completions, anything new) has an `….enabled`
   setting that defaults to false, and its commands / buttons / keys only appear when it's on
   (D172). The owner's exceptions so far: Generate commit message is on, since it runs only
   when pressed and every IDE has it (D173); the agent's automatic memory tidy-up is on, since
   it's the agent's own upkeep and only proposes changes for review (D194). Ask the owner before
   making another.
9. **Everything visual follows `DESIGN.md`.** Semantic tokens only (no hex/rgb outside theme/token files), sentence case, motion tokens, the component specs. Every new view lives in the dock as a tab (no fixed panels except the sidebar).

## TypeScript conventions
- Strict mode, no `any`, `noUncheckedIndexedAccess`. Prefer `unknown` + narrowing.
- Files < ~1200 lines; split by responsibility, not by size alone, and don't split what's read together (D77).
- One feature per folder. A short `README.md` per extension and per area (`src/core`, `src/ui`, `src/workbench`, `src/workbench/dock`, `src-tauri/src`): purpose, public exports, commands, state paths — areas use one section per subfolder instead of a README in each.
- Components are classes: `constructor(host: HTMLElement, deps)`, optional `update()`, required `dispose()`.
- Every listener, effect, timer, IPC subscription and child component is registered to the owner's `DisposableStore`. No exceptions.
- Core logic (dispatcher, schema, state, keybindings, jsonc, layout model) stays **DOM-free** and unit-tested.
- All Tauri calls go through typed wrappers in `src/core/ipc/`. No raw `invoke` elsewhere.
- Streams use Tauri Channels, not repeated events.
- Explicit, descriptive names. No clever metaprogramming. Comment the *why*, not the *what*.
- CSS: semantic tokens only (`var(--bg-surface)`, `var(--space-4)`…), never primitives or hard-coded values outside theme/token files.
- Inputs, selects, checkboxes and key chips use `--bg-input` / `--bg-chip`: never a dark field on a lighter surface (the user's standing preference).

## Rust conventions
- One service per module folder under `src-tauri/src/`. Public Tauri commands in `ipc/`, one file per domain (mirrors `src/core/ipc/`).
- `rustfmt`, `clippy -D warnings`. Errors via `thiserror`, converted to serializable IPC errors.
- No `unwrap()`/`expect()` on fallible runtime paths.
- File writes are atomic (temp → fsync → rename) via the `store` module.
- fs access is scoped to the open workspace and app dirs.

## Workflow
- A new Tauri command goes in `lib.rs`, `src-tauri/build.rs` COMMANDS and `capabilities/default.json` (`npm run check` fails otherwise).
- Work in small, runnable steps. After each step: `npm run check` (tsc + biome), `npm test`, `cargo check`, `cargo clippy`.
- If you can't run the GUI (e.g. a headless sandbox), still make sure everything compiles and tests pass, and give the owner exact steps to verify by hand.
- Update the relevant `README.md` and `docs/decisions.md` when behavior or decisions change.
- Commit in logical units with clear messages.
- When a spike or library doesn't behave as `PLAN.md` assumes, stop guessing: check the library's current docs/source, choose the documented fallback, and log the decision.

## How this repo has been built (and what works)
The IDE grew in many small, shippable releases (`ide-m6.N`, D111 onward), each the same loop. New
sessions should keep it:
1. **Read before writing:** the folder's `README.md`, the relevant `docs/decisions.md` entries,
   `docs/feature-gaps.md` for priorities (industry gaps first, cheapest-valuable first).
2. **Build the DOM-free part first, with unit tests** (parsers, models, layout math), then the
   view, then the commands and the `ide://` state. Agents use the same commands.
3. **Prove it in the real app** (the `ui-test` skill in `.agents/skills` has the steps) with a command-script UI test (`tests/scripts/*.jsonc`, run with
   `node scripts/ui-test.mjs <binary> [filter]`), plus screenshots (`workbench.screenshot`). Test
   helpers that exist: `dev.inspectDom`, `dev.click` (`hover`, `x`), `dev.type`,
   `dev.setWindowSize`, `{ "wait": ms }`, mock Ollama (11999), a mock dev server (11998), a fake
   GitHub CLI (`"fakeGh": true`), `"platforms": ["linux"]` for what only some OSes have. Setup
   lines run in bash on every OS (Git Bash on Windows); write paths next to the test folder
   (`${ws.root}/..` from a saved `ide://workspace`), never `/tmp`, and helpers that need more go in
   `tests/fixtures/setup/` (D228). The binary for UI tests needs the dev commands: `npx tauri
   build --debug --no-bundle --config '{"build":{"beforeBuildCommand":"node build.mjs --prod
   --with-dev"}}'`. On the owner's Windows machine, Python writes CRLF in text mode and bash
   heredocs can eat backslashes: edit with the editor tools, or check the files afterwards (D229).
4. **Audit regularly:** before a larger step, review the code for infinite loops, leaks, races and
   edge cases (Windows paths, huge files, non-UTF-8, empty repos, pages that reload mid-call), and
   fix what's verified. D120, D138 and D149 are such passes; for the agent, follow
   `docs/agent-audit.md` (D161).
5. **Log the decision** (`docs/decisions.md`, next number), update the area README, the guide
   (`docs/guide/`) and `docs/manual-test.md`. Then run everything: `npm run check`, `npm test`,
   `cargo clippy`, `cargo test --lib`, all UI scripts. Then commit.

## Upkeep (keep the repo easy to work in)

The structure above is why changes land fast; it only stays that way with upkeep. Pace it to the
owner's batches, not to every change:
- **Each change:** its own unit tests and the UI scripts that touch it, `npm run check`, and
  clippy when Rust changed. Update the area README, the guide page and `docs/manual-test.md` in
  the same commit, and log the decision.
- **Batches:** the owner often has a list of things to get done first. Don't run the full UI
  suite, a full audit or a docs pass after each item; offer them after a large change or a run
  of several, or when the owner asks ("audit", "run the suite", "check the docs").
- **Pushing:** commit each logical unit; push only when asked (an earlier "push" doesn't carry
  over). Offer it now and then, after something large or after several commits.
- **Every ~10 decisions or before a release** (offer it, don't just start):
  - a docs pass: every `docs/*.md` and `PLAN.md` against the code, plus a release-notes entry
    in `docs/release-notes.md` (the IDE shows it after an update);
  - a code-health pass: files past the soft cap split by responsibility, dead code;
  - a `docs/feature-gaps.md` review.
- **History stays history:** past entries in `docs/decisions.md` and `docs/manual-test.md` are
  never reworded; add a new entry instead. Add each milestone's range to the table at the top of
  `decisions.md`.
- **CI** (`.github/workflows/ci.yml`) runs the checks, unit and Rust tests on each push (Linux
  and Windows; `gh run list` shows the latest). A red run gets fixed before the next feature.
- **The full UI suite** (every `tests/scripts` script) runs in CI only when started, and the owner
  doesn't start it: ask first ("run the full UI suite in CI?"), after a batch of changes or
  before a release, then `gh workflow run ci --ref main` and read the result with `gh run list`
  / `gh run view`. Never on every push. The scripts a change touches still run locally as part
  of that change. Changing what CI runs is the owner's decision.

**Windows hazards** (the owner's machine; `core.autocrlf` is on):
- Never `git stash` to compare before / after: it rewrites the touched files as CRLF and
  `npm run check` fails. Compare with `git show HEAD:<path>` or an older build.
- `docs/decisions.md` and `docs/manual-test.md` had line endings converted again and again into
  `\r\r\r\n`, which showed as blank lines between every line; since D412 they're plain `\n`. Keep
  them so: after editing either, `git diff --stat` must show only your lines and
  `git ls-files --eol` must not say `mixed`.
- After a scripted edit, check `git ls-files --eol <file>`; working copies with CRLF are fine
  (git stores LF), mixed ones aren't.
- Rust only some OSes use (Windows APIs) needs `#[cfg(windows)]` or
  `#[cfg_attr(not(windows), allow(dead_code))]`: CI's Linux job fails on dead code otherwise.

**The owner's standing preferences:**
- VS Code's behavior is the reference, and Chrome's for DevTools.
- Inputs on light fields (`--bg-input` / `--bg-chip`). Sentence case. Quiet color: no accent edges
  or bars, and status colors only where they mean something.
- Everything must hold up in small windows.
- Errors the user would hit on Windows (PowerShell, `.cmd` shims, WebView2) matter most: the
  owner runs Windows.

