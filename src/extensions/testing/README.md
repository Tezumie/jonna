# extensions/testing

The Testing view (D149, D204), like VS Code's Test Explorer for the common frameworks, without
extensions: run, debug, coverage, expected / actual diffs and the run history.

- `model.ts` (DOM-free, tested): finds tests in a file's text and works out each one's command.
  - Discovery: JavaScript / TypeScript `describe` / `it` / `test` (nested by braces), pytest
    functions and `Test*` classes, Rust `#[test]` with module paths, Go `TestX`. It also picks
    the JavaScript runner (`jsFramework`: Playwright by its import, Vitest, node:test, Jest,
    Mocha by its dependency or config).
  - Commands per framework and scope (all, a file, a test), quoted for POSIX shells or
    PowerShell, with coverage when asked (`runCommand(…, coverageDir)`, `coverageReport`).
  - Result parsers: Vitest / Jest JSON, pytest `-rA`, cargo test, `go test -json`, node:test TAP,
    each failure's expected / actual when reported (`assertions.ts`).
  - `testAt`: the test at the cursor.
- `frameworks.ts` (DOM-free, tested): Mocha (`.mocharc.*` / package.json `spec`, the JSON
  reporter), Playwright (`playwright test --list --reporter=json` and the same JSON for results,
  one tree level per project when there are several) and unittest (a listing script run with
  `python -c`, `-v` output and its FAIL / ERROR sections, TestCase classes from the text).
- Extensions' coverage runs (D255): a controller's coverage profile reports files with
  `run.addCoverage`; when its run ends with coverage, `index.ts` makes it the coverage report
  (`extensionCoverageFiles`), and the view's controller row has Run with coverage.
- `coverage.ts` (DOM-free, tested): lcov (node:test, c8, cargo llvm-cov), Istanbul's
  coverage-final.json (Jest, Vitest), coverage.py JSON (pytest-cov, coverage run) and Go's
  `-coverprofile`, into hits per line, branches per line and functions; merged across commands;
  totals, percentages, uncovered ranges, line states for the margin. Functions by name where
  the report names them (lcov `FN`/`FNDA`, Istanbul's `fnMap`, coverage.py 7.5+'s `functions`;
  D229: `declarations`), and the next / previous line that didn't run fully (`nextUncovered`).
- `assertions.ts` (DOM-free, tested): a failure's expected and actual values, from reported
  values (Jest's `failureDetails`, Mocha's `err`, node:test's YAML) or the printed diff (Jest /
  Vitest / Playwright, Node's assert, pytest's rewriting and "Full diff", unittest's `a != b`).
- `history.ts` (DOM-free, tested): the last runs (testing.resultsHistory, default 20) with what
  they ran, counts and each test's result and own output (D209); a test's results across them.
- `persist.ts` (DOM-free, tested; D209, VS Code's `testing.keepResults`): the history, each
  test's last result and the last coverage as JSON, in `<IDE folder>/testing/results.json` and
  `<IDE folder>/coverage/last.json` (git-ignored), written after each run and read back when the
  folder opens (`testing.keepResults`, default on).
- Each test's own output (D209, `TestResult.output`): Go's events, pytest's captured output
  (`-rA` PASSES and FAILURES sections), cargo's stdout block, node:test's diagnostics, Jest /
  Vitest's full failure with its stack. The Test results tab shows it beside the runs when a
  test is selected (`tests.showTestOutput {test, run?}`), in color: the output keeps its ANSI
  escape sequences (Jest / Vitest's failure messages and Go's output as printed; the other
  parsers read plain text) and the pane draws SGR colors with the terminal palette's tokens
  (the notebook's parser, `editor/notebook/ansi.ts`); the command returns the text without them
  (`plainOutputText`).
- `debugConfig.ts` (DOM-free, tested): the launch configuration that debugs a test — node:test
  runs the file itself with `--test-name-pattern`, Jest `--runInBand`, Mocha `_mocha`, pytest and
  unittest as debugpy modules. Vitest, Playwright, cargo and go say what to do instead.
- `controller.ts`: discovery and runs.
  - Discovery: text searches for test files (plus each Mocha project's spec), then each file is
    read and scanned. Each test is tied to its project (the nearest package.json /
    pyproject.toml / Cargo.toml / go.mod). Python files are pytest's unless they're unittest
    TestCases in a project not set up for pytest (testing.pythonRunner). In a trusted folder,
    Playwright and unittest then list their own tests (testing.listWithRunner).
  - Runs: one command per project and framework (node:test per file) through `execIpc`. Results
    are merged, file load errors recorded, and tests the run found that discovery missed are
    added. One run at a time; `cancel`; workspace trust is required. Each run goes into the
    history.
  - Coverage runs write their reports under `<root>/<IDE folder>/coverage/<n>/` (git-ignored,
    replaced each run), read back and merged into `coverage`; a command that wrote nothing says
    what to install (`@vitest/coverage-v8`, `c8`, `pytest-cov`, `coverage`, `cargo-llvm-cov`).
- `view.ts`: the `testing.view` sidebar view.
  - Groups by framework and project, then file, suite and test, each with a status icon, plus
    the failure message (hover: Compare expected with actual, Show the whole message).
  - A filter, "failed only", hover actions (continuous run, run with coverage, debug, run), a
    summary line; a test's tooltip shows its last results.
- `coverageView.ts` / `coverageUi.ts`: the Test coverage tab (`testCoverage`: files by folder
  with a bar and a percentage, totals, sort by coverage, Show inline coverage, Clear), covered /
  uncovered / partly covered lines in the margin (`gutterMarks`, owner "coverage"; a partly
  covered line's hover says how many branches ran), percentages in the explorer
  (testing.showCoverageInExplorer) and the coverage commands. A file opens to its functions
  (VS Code's declarations: how often each ran, "Not run"), each opening the file at its line.
  The editor's title bar has VS Code's coverage toolbar actions while a report is loaded
  (context key `testCoverageLoaded`): previous / next uncovered line, inline coverage on / off.
- `resultsView.ts` / `resultsUi.ts`: the Test results tab (`testResults`: runs newest first, each
  opening to its tests), Compare expected with actual (a diff tab: `editor.openDiff` with the
  `testExpected:` / `testActual:` content sources), Debug test (`debug.start {configuration}`),
  and the history commands.
- `continuous.ts` (DOM-free, tested) and `continuousRun.ts`: continuous run (D201, VS Code's
  "Turn on continuous run"), for every test or for files and tests. A save runs what it affects:
  a test file its tests; a source file the tests named after it (`util.ts` → `util.test.ts`,
  `test_util.py`, `util_test.go`), for Go and Rust also its folder's, else its project's tests;
  files that aren't code nothing. Saves are collected for 800 ms; runs never overlap (saves
  during a run run once after it); turning it off stops a run it started; without trust nothing
  runs. Not kept across restarts or folder changes.
- `index.ts`: the view, margin dots (`gutterMarks`, owner "testing"), the status bar item,
  commands and state.

- **Per-test coverage (D233):** pytest coverage runs record each line's tests
  (`--cov-context=test`, then `coverage json --show-contexts`; the data file goes to the run's
  coverage folder through `COVERAGE_FILE`), and lcov's `TN:` records name a test. `coverage.ts`
  keeps them as `contexts` (line → test keys, tested); `coverageForTest` is one test's coverage.
  `tests.showCoverageForTest {test?, all?}` shows it in the margin, the explorer and the tab
  (`TestController.coverageTest`, `shownCoverage`); `tests.coveredBy {path?, line?}` lists a
  line's tests (the margin's hover says "Covered by …" too).
- **Branch columns:** Istanbul's arms keep their columns (`branchArms`); the hover names the
  columns not taken and the margin mark carries them as `columns` for the editor to draw.
- **The floating coverage toolbar** (`coverageToolbar.ts`, VS Code's; `testing.coverageToolbarEnabled`,
  `tests.toggleCoverageToolbar`): over the active editor of a file in the report: its coverage,
  the test shown (All tests ▾), Covered by, previous / next uncovered line, inline coverage.
- **Colors (D233):** runs get `FORCE_COLOR=1` and `CARGO_TERM_COLOR=always` (`testRunEnv`),
  pytest `--color=yes`. pytest, cargo, TAP and unittest are parsed from the plain text
  (`plainOutput`, tested) and a test's own output is cut from the colored original.

- **Extensions' tests** (VS Code's test controllers, `ide.tests.createTestController`): each
  controller (`services.extensionFeatures.tests`, `workbench/extensionTests.ts`) is a group of the
  view after the frameworks' (`extensionTestsView.ts`): its items as the extension nests them,
  each with its last result (failures' messages in the tooltip), Run and Debug on hover through
  its run profiles, a test with a file opening at its line; opening an item that can resolve
  children asks the extension. They count in the summary line, show the Testing icon, run with
  `tests.runAll` and stop with `tests.cancel`. Coverage profiles aren't offered (the IDE's
  coverage reads reports, not an extension's FileCoverage).

**Commands:**
- `tests.showView`, `tests.refresh`, `tests.list {file?, status?}`
- `tests.run {file?, test?, framework?, project?}` (agents; returns counts and failures with
  expected / actual), `tests.runAll` (Ctrl+; A), `tests.runFailed` (Ctrl+; E), `tests.runFile`
  (Ctrl+; F), `tests.runAtCursor` (Ctrl+; C)
- Coverage: `tests.runWithCoverage {file?, test?, framework?, project?}`,
  `tests.runAllWithCoverage`, `tests.rerunWithCoverage`, `tests.showCoverage`,
  `tests.showCoverageForTest {test?, all?}`, `tests.coveredBy {path?, line?}`,
  `tests.toggleCoverageToolbar {on?}`,
  `tests.toggleInlineCoverage {on?}`, `tests.clearCoverage`, `tests.coverage {file?}` (agents;
  with `file`, its `functions` too), `tests.goToNextUncoveredLine` / `tests.goToPreviousUncoveredLine
  {path?}` (D229)
- Results: `tests.compareExpected {id}`, `tests.showResults`, `tests.history {test?}`,
  `tests.rerunFromHistory {run}`, `tests.clearHistory`
- Debug: `tests.debug {test?, file?}`, `tests.debugAtCursor` (Ctrl+; Ctrl+C), `tests.debugFile`
  (Ctrl+; Ctrl+F)
- `tests.cancel`, `tests.showOutput`, `tests.showMessage {id}`
- Extensions' tests (`extensionTestCommands.ts`): `tests.runExtension {controller?, item?, profile?}`
  (agents; counts and failures once the run handler is done), `tests.cancelExtension`
- `tests.toggleContinuousRun {file?, test?, on?}` (the eye in the view's filter row, and on a
  file's or test's row), `tests.stopContinuousRun`

**Settings:** `testing.timeoutSeconds`, `testing.gutterMarks`, `testing.discoverOnOpen`,
`testing.alwaysShow` (the activity bar icon even before tests are found),
`testing.showInlineCoverage`, `testing.showCoverageInExplorer`, `testing.resultsHistory`,
`testing.pythonRunner`, `testing.listWithRunner`, `testing.keepResults` (D209),
`testing.coverageToolbarEnabled` (D233).
**State:** `ide://tests` (failures with `comparable`, `coverage`, `history`, and `continuous`:
all, files, tests, runs, the last run); `ide://tests/extensions` (extensions' controllers: key,
profiles, running, items with their last status, the end of their output).
**Tests:** `*.test.ts` here (and `workbench/extensionTests.test.ts`); `tests/scripts/testing-m6-48.jsonc`, `tests/scripts/testing-m7-5.jsonc`, `tests/scripts/extensions-panels-tests.jsonc`
(fixtures: `tests/fixtures/setup/testing-m7-5.cjs`).

**Multi-root workspaces** (D251, `folders.ts`, DOM-free and tested): with several folders a test's
file, id and project start with its folder's name (`workspace.relative`: "api/src/sum.test.ts"),
projects never reach above their folder, reports are read relative to the folder they ran in and
given its name (`prefixRun`), and coverage reports go in that folder's `<IDE folder>/coverage/`
(the merged last.json and results.json stay in the first folder's). Adding or removing a folder
finds the tests again. Names by folder only with several folders (as VS Code): going from one
folder to two and back, or renaming a folder, renames every test's file and id, so the last
results and the history are renamed with them (`TestController.rename`, `renameTestId` /
`renameTestFile`, `RunHistory.rename`; a gone folder's results drop, a rerun target keeps a name
it can't rename). results.json records the naming its ids use (`naming`) and is renamed when read
under another (a file without one is the first folder's own naming).
