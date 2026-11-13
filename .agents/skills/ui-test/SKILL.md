---
name: ui-test
description: Prove a change in this repository works in the real app - build the test app, run a UI test script, look at its screenshots. Use after changing anything the user sees, before saying it's done.
---

# Testing a change in the real app

Unit tests (`npm test`) cover the DOM-free code. What the user sees is checked by a UI test
script run against a test build of the app. Do both before calling a change done.

## 1. Build the test app (once per change set, several minutes)

The test build has the `dev.*` helpers; the installed app doesn't. Build into its own folder so a
running dev build doesn't lock the exe. Run it in the background and wait for it.

PowerShell:
```
$env:CARGO_TARGET_DIR = "$PWD\src-tauri\target-uitest"; npx tauri build --debug --no-bundle --config '{\"build\":{\"beforeBuildCommand\":\"node build.mjs --prod --with-dev\"}}'
```
bash:
```
CARGO_TARGET_DIR="$PWD/src-tauri/target-uitest" npx tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":"node build.mjs --prod --with-dev"}}'
```
The path is absolute on purpose: cargo runs inside `src-tauri`, so a relative one builds into
`src-tauri/src-tauri/target-uitest`, which git doesn't ignore. The exe is in
`src-tauri/target-uitest/debug/` (named after product.json's name). Rebuild after
every source change you want to test: the app is bundled, nothing reloads.

## 2. Write a script

`tests/scripts/<feature>-m7-NN.jsonc`; copy a nearby one. Start with a comment naming the
decision (D-number) and what it proves. Each step is one of:
- `{ "run": "<command id>", "input": {…}, "expect": …, "save": "name", "timeoutMs": n }`: any IDE
  command; `save` keeps its result for later steps as `${name.field}`.
- `{ "state": "ide://…", "expect": … }`: read state (retried until `timeoutMs`).
- `{ "wait": ms }`.

`expect` matches JSON partially. Matchers: `$contains` (a string, matched against the value's
JSON text), `$length`, `$not`, `$exists`, `$gte`, `$lte`. UI helpers: `dev.inspectDom` (a CSS
selector, returns the elements with their `html`), `dev.click` (`right`, `hover`), `dev.type`
(`text`, `key`, `code`), `dev.setWindowSize`, `workbench.screenshot { "save": true }`. Mock
servers: Ollama on 127.0.0.1:11999 (set `agent.ollama.url`), a dev server on 11998.

## 3. Run it and look

PowerShell: `$env:UI_TEST_KEEP = "1"; node scripts/ui-test.mjs <exe> <script file name>`
bash: `UI_TEST_KEEP=1 node scripts/ui-test.mjs <exe> <script file name>`

The filter is part of the script's file name. A failing step prints what didn't match.
With `UI_TEST_KEEP=1` the run's folder is kept (`=== kept: <folder>`): the screenshots are in
its `sample/` folder, in the IDE's data folder's `screenshots/`. Read each PNG with read_file
to see it, and check what the user asked for is really there (layout, colors, small windows).
Delete the folder when done.

Then run the other scripts that cover the same area (search `tests/scripts` for the commands
you touched) to catch regressions.

## On Windows

- Bash heredocs and `node -e` eat backslashes: write files with write_file / edit_file.
- Python writes CRLF in text mode: open files with `newline="\n"`.
- Write test paths next to the run's folder (`${ws.root}/..` from a saved `ide://workspace`),
  never `/tmp`.

## Finish

`npm run check`, `npm test`, `cargo clippy` when Rust changed. Log the decision in
`docs/decisions.md`, add manual steps to `docs/manual-test.md`, then commit.
