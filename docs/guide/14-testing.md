# Testing

The IDE finds your project's tests, runs and debugs them, shows their results in the editor, and
measures their coverage, with nothing to install or configure for the common frameworks. This
page covers the Testing view, how tests are found, running and debugging them, failures and
their expected / actual diffs, the run history, continuous run, coverage, and the settings.

## Supported frameworks

| Language | Frameworks |
|---|---|
| JavaScript and TypeScript | Vitest, Jest, Node's test runner (`node:test`), Mocha, Playwright |
| Python | pytest, unittest |
| Rust | `cargo test` |
| Go | `go test` |

Extensions can add more: a VS Code extension's test controllers show as groups of their own in
the Testing view, with Run and Debug through the extension's profiles.

## The Testing view

The **Testing** view is the flask in the activity bar. It appears by itself once tests are found
in the folder; `testing.alwaysShow` keeps the icon there even before.

The view groups tests by framework and project, then by file, suite and test, each with an icon
for its last result. Under a failed test is its failure message. At the top:

- A filter box, and **Show only failed tests**.
- The eye, which turns on [continuous run](#continuous-run).
- A summary line with the last run's counts (also in the status bar).

The header's buttons:

| Button | Command | What it does |
|---|---|---|
| Play | Run all tests | Runs every test |
| Rerun | Rerun failed tests | Runs the tests that failed last time |
| Shield | Run all tests with coverage | Runs every test and records coverage |
| Square | Stop the test run | Stops the run in progress |
| Refresh | Refresh tests | Finds the tests again |
| History | Show test results | Opens the run history |
| Terminal | Show test output | Shows the commands that ran and what they printed |

Hover a row for its own buttons: continuous run, run with coverage, debug and run. A test's
tooltip shows its last results.

[Show testing](command:tests.showView)

## How tests are found

Tests are found from their files, before anything runs:

- `*.test.*`, `*.spec.*` and `__tests__` files: `describe` / `it` / `test`, nested as written.
- `test_*.py` and `*_test.py`: `test_*` functions and `Test*` classes.
- `#[test]` functions in Rust, with their module path.
- `func TestX(t *testing.T)` in `*_test.go`.

Saving a test file updates its tests. Tests are looked for when a folder opens
(`testing.discoverOnOpen`; off: when the Testing view is first shown).

### Projects and runners

Each test runs from its project's folder: the nearest `package.json`, `pyproject.toml` (or
`pytest.ini`, `setup.cfg`), `Cargo.toml` or `go.mod`. In a monorepo, every package uses its own
runner.

- **JavaScript:** the runner comes from the package's dependencies (Vitest or Jest), a
  `node:test` import, or Mocha's configuration (a `.mocharc` file or `mocha` in `package.json`,
  whose `spec` says where its tests are).
- **Playwright:** tests are the files that import `@playwright/test`. In a trusted folder the IDE
  also asks Playwright for its list, so each project (chromium, firefox…) shows as its own group.
- **Python:** test classes that subclass `unittest.TestCase` run with unittest when the project
  isn't set up for pytest; `testing.pythonRunner` chooses. In a trusted folder unittest is also
  asked for its exact list.

`testing.listWithRunner` turns off asking Playwright and unittest for their lists.

In a workspace with several folders, a test's file and project start with its folder's name, and
adding or removing a folder finds the tests again.

## Run tests

- **Run all** with the play button in the view's header, or Ctrl+; A.
- Run a framework's tests, a file, a suite or one test with the play button on its row.
- In the editor, **Run test at cursor** (Ctrl+; C) and **Run tests in current file** (Ctrl+; F).
- **Rerun failed tests** (Ctrl+; E).
- **Stop the test run** ends a run.

Runs don't overlap: one runs at a time. A command that runs longer than `testing.timeoutSeconds`
(600 seconds) is stopped.

> **Note:** running tests runs the project's code, so the folder must be trusted first. See
> [Workspaces and trust](20-workspaces.md).

| Command | Keys | What it does |
|---|---|---|
| Testing: Run all tests | Ctrl+; A | Runs every test |
| Testing: Run tests in current file | Ctrl+; F | Runs the active file's tests |
| Testing: Run test at cursor | Ctrl+; C | Runs the test the cursor is in |
| Testing: Rerun failed tests | Ctrl+; E | Runs the tests that failed last time |
| Testing: Debug test at cursor | Ctrl+; Ctrl+C | Debugs the test the cursor is in |
| Testing: Debug tests in current file | Ctrl+; Ctrl+F | Debugs the active file's tests |
| Testing: Stop the test run | | Stops the run |
| Testing: Refresh tests | | Finds the tests again |
| Testing: Show test output | | The commands that ran and what they printed |

### Results in the editor

Each test's last result shows as a mark in the editor's margin, on the test's line: passed,
failed or skipped (`testing.gutterMarks`). The status bar shows the last run's counts.

### Test output

**Show test output** shows the commands that ran and what they printed. Output keeps its colors
(pytest, cargo, Jest, Vitest, Go, node:test, and unittest on Python 3.13 and newer): runs set
`FORCE_COLOR=1`.

## Failures

A failed test shows its message under it in the Testing view. Click the message (**Show the whole
message**) to read all of it.

### Compare expected with actual

When a failed assertion's expected and actual values are known, hovering its message offers
**Compare expected with actual**: both open side by side in a diff tab. The values come from what
the framework reports (Jest, Mocha, node:test) or from the printed diff (Jest, Vitest, Playwright,
Node's assert, pytest, unittest).

## Debug a test

**Debug test** starts the debugger on a test, so breakpoints in the test and in the code it calls
stop it:

- The bug button on a test or file row.
- **Debug test at cursor** (Ctrl+; Ctrl+C) and **Debug tests in current file** (Ctrl+; Ctrl+F).
- **Debug test** in a run's list in Test results.

| Framework | Debugged with |
|---|---|
| node:test, Jest, Mocha | Node's inspector |
| pytest, unittest | debugpy (`pip install debugpy`) |
| Vitest, Playwright, cargo test, go test | Not yet: the IDE says what to run instead |

Vitest runs its tests in worker threads and Playwright in worker processes, so they can't be
debugged from the view yet: run `npx vitest --inspect-brk --no-file-parallelism` and attach, or
`npx playwright test --debug` in a terminal. For Rust and Go, add a launch configuration
(lldb-dap, or Delve). See [Debugging](13-debugging.md).

## Results and history

**Test results** (the history button in the view's header, or **Testing: Show test results**)
lists the last runs, newest first (`testing.resultsHistory`, 20 by default). Open a run to see
its tests; hover a run to run it again. Select a test to see its own output beside the runs:
what Go, pytest, cargo, node:test, Jest or Vitest printed for that test, in color.

Test results, the run history and the last coverage are kept when the window reloads or the IDE
restarts (`testing.keepResults`). They're stored in the IDE's folder in the project and ignored
by git. **Testing: Clear test results** empties the history.

## Continuous run

Continuous run runs tests again each time you save, as VS Code's does.

1. Click the eye in the Testing view's filter row, or run **Testing: Toggle continuous run**.
2. Edit and save:
   - Saving a test file runs its tests.
   - Saving a source file runs the tests named after it (`util.ts` → `util.test.ts`,
     `test_util.py`, `util_test.go`); for Go and Rust also its folder's tests; else its
     project's tests.
   - Saving a file that isn't code runs nothing.
3. Click the eye again to stop.

To watch only one file or test, hover its row and click its eye. Saves are collected for a moment
and runs wait for each other, so saving often doesn't pile them up. **Testing: Turn off all
continuous runs** stops every one. Continuous run isn't kept across restarts or folder changes.

## Coverage

**Run with coverage** runs tests and records which lines they ran:

- The shield on a row, or in the view's header (all tests).
- **Testing: Run all tests with coverage**, **Run tests with coverage**, or **Rerun the last
  coverage run**.

### What each framework needs

| Framework | Needs |
|---|---|
| Jest, node:test, go test | Nothing |
| Vitest | `@vitest/coverage-v8` |
| Mocha | `c8` |
| pytest | `pytest-cov` |
| unittest | `coverage` |
| cargo test | `cargo-llvm-cov` |

When a run writes no report, the coverage tab says what's missing.

### The Test coverage tab

The **Test coverage** tab lists the files by folder, each with a bar and how much of it ran, and
the totals. Hover a file for its lines, branches and functions; click it to open the file. A file
opens to its functions, with how often each ran ("Not run" for those that didn't). You can sort by
coverage, turn **Show inline coverage** off and on, and **Clear** the report.

### Coverage in the editor

- In the margin, a green bar marks lines that ran, red ones that never did, and yellow ones where
  a branch wasn't taken. The hover on a partly covered line says how many branches ran; for Jest
  and Vitest it names the columns of the branches not taken.
- A small toolbar floats over the editor of a covered file: its coverage, the test whose coverage
  is shown, **Covered by**, previous / next uncovered line, inline coverage on or off, and a close
  button (`testing.coverageToolbarEnabled`). The editor's title bar has the previous / next and
  inline coverage buttons too.
- `testing.showCoverageInExplorer` shows each file's percentage in the explorer.

### Coverage per test

With pytest (or lcov reports that name their tests) the run also records which tests ran each
line:

- **All tests ▾** in the coverage toolbar (**Show coverage for test…**) shows one test's coverage.
- **Covered by** lists the tests that ran the cursor's line; the margin's hover names them too.

| Command | What it does |
|---|---|
| Testing: Run all tests with coverage | Runs every test and records coverage |
| Testing: Rerun the last coverage run | Runs the last coverage run again |
| Testing: Show test coverage | Opens the Test coverage tab |
| Testing: Show inline coverage | Turns the margin's coverage marks on or off |
| Testing: Go to next uncovered line | Moves to the next line that didn't fully run |
| Testing: Go to previous uncovered line | Moves to the previous one |
| Testing: Clear test coverage | Removes the report |

## Settings

The **Testing** page in Settings has these:

| Setting | Default | Description |
|---|---|---|
| `testing.alwaysShow` | `false` | Show the Testing icon even before tests are found |
| `testing.discoverOnOpen` | `true` | Look for tests when a folder opens (off: when the view is first shown) |
| `testing.timeoutSeconds` | `600` | Stop a test command that runs longer than this |
| `testing.gutterMarks` | `true` | Each test's last result in the editor's margin |
| `testing.pythonRunner` | `"auto"` | `auto`, `pytest` or `unittest` |
| `testing.listWithRunner` | `true` | In a trusted folder, ask Playwright and unittest for their tests |
| `testing.resultsHistory` | `20` | How many runs Test results keeps (1 to 200) |
| `testing.keepResults` | `true` | Keep results, history and coverage across reloads and restarts |
| `testing.showInlineCoverage` | `true` | Covered and uncovered lines in the margin after a coverage run |
| `testing.coverageToolbarEnabled` | `true` | The floating coverage toolbar over the editor |
| `testing.showCoverageInExplorer` | `false` | Coverage percentages in the explorer |

[Open settings](command:settings.open)

## For agents

The agent uses the same commands. `tests.run` runs all tests, a `file`, a `test` or a
`framework`'s tests, and returns the counts and each failure's file, line, name and message (with
`expected` / `actual` when known), so an agent can fix and rerun. `tests.list` lists the tests,
`tests.runFailed` reruns the failed ones, `tests.runWithCoverage` adds coverage totals and the
least covered files with their uncovered lines, `tests.coverage {file}` gives a file's uncovered
lines, `tests.history` lists past runs and `tests.debug` starts the debugger on a test. The state
is at `ide://tests`.

## Common questions

### The Testing icon isn't in the activity bar.

It appears once tests are found. If your tests don't match the patterns above, they aren't found
from their files; turn on `testing.alwaysShow` to keep the view available, and check that the
project has its `package.json`, `pyproject.toml`, `Cargo.toml` or `go.mod`.

### Nothing happens when I run tests.

Running tests runs the project's code, so the folder must be trusted. **Show test output** shows
the commands that ran and what they printed.

### A coverage run shows no coverage.

The framework's coverage tool is probably missing; the Test coverage tab names it. See
[What each framework needs](#what-each-framework-needs).

## Next steps

- [Debugging](13-debugging.md): breakpoints and stepping.
- [Tasks](12-tasks.md): run build and test scripts.
- [The agent](05-agent.md): let the agent run and fix tests.
