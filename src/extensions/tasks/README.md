# extensions/tasks

Tasks in VS Code's format (D95, D134): `.vscode/tasks.json`, the IDE's own
`<workspaceFolderName>/tasks.json` (wins for the same label), the user's tasks.json (next to the
user settings), plus package.json scripts with the project's package manager (npm, pnpm, yarn,
bun), plus tasks detected from build files (D201).

- `tasks.ts` (tested) — parsing: `shell` / `process` / `npm` tasks, args, `options` (`cwd`, `env`,
  `shell`) at the top level and per task, `windows` / `osx` / `linux` blocks (a WSL folder opened
  on Windows uses `linux`, as VS Code's WSL window does: `taskPlatform`, m7.12), groups, `dependsOn`
  / `dependsOrder`, `isBackground`, `presentation`, `problemMatcher`, `runOptions.runOn`, `hide`,
  `inputs`; variables (`${workspaceFolder}`, `${file}`…, `${config:…}`; `${env:…}` is expanded by
  the Rust side; `${input:…}` and `${command:…}` at run time).
- `problemMatchers.ts` (tested) — VS Code's built-in matchers ($tsc, $tsc-watch, $eslint-stylish,
  $eslint-compact, $gcc, $msCompile, $go, $rustc, $jshint, $lessCompile, $esbuild,
  $esbuild-watch), extensions' named ones (`contributes.problemMatchers` / `problemPatterns`, D229,
  from `services.contributions`: `"$name"`, a `base`, or a matcher's `pattern`), custom ones and
  `base`, multi-line patterns with `loop`, background matchers
  (`beginsPattern` / `endsPattern`); `ProblemCollector` turns output into problems.
- `detect.ts` (tested) — detected tasks (VS Code's task providers), in the root and its
  subfolders down to `task.autoDetectDepth` levels (D203: 0–3, default 2, so `packages/app`;
  `foldersToScan` lists level by level, at most 80 folders in all, shallow ones first; not
  node_modules, target, build…, hidden, ignored or linked ones; a subfolder's
  label ends in ` - <folder>` and runs there): `tsc: build - <tsconfig>` / `tsc: watch - …` per
  tsconfig*.json (the project's `node_modules/.bin/tsc` if it has one; `$tsc` / `$tsc-watch`),
  `make: <target>` per Makefile target (rules, not assignments, pattern rules, special targets or
  file targets unless `.PHONY`; `$gcc`; in a trusted folder with `make` on PATH the targets come
  from `make -p -n -q -r .DEFAULT 2>/dev/null` (its database: targets made by `$(foreach)` /
  `$(eval)` and included makefiles too; `makeDatabaseTargets`, tested; 5 s timeout, at most 8
  runs per detection, kept per folder while the Makefile's text is the same; the text is read
  when make isn't there, fails or prints no GNU database), `cargo: build / check / test / run` (`run` for a package
  with `src/main.rs` or `[[bin]]`; `$rustc`), `gradle: build / test / run` (`run` with the
  application plugin; `./gradlew` when there), `maven: compile / test / package` (`./mvnw`),
  `gulp: <task>` / `grunt: <task>` from their files. Build and test groups as VS Code. A subfolder
  matcher reads paths from its folder (`fileLocation: ["relative", "${workspaceFolder}/<dir>"]`).
  A Cargo / Gradle / Maven folder hides its subfolders' own (at any level). `detectFolders.ts`
  reads the files; a detection is reused for 4 s (its key: platform, depth, trust, root listing).
  `task.autoDetect` ("on" / "off").
- `runner.ts` — runs a task: dependencies (parallel or in sequence; a background dependency is
  done when its matcher sees a build finish, else when its output settles), inputs, workspace
  trust, the terminal (`services.taskTerminals`; its automation profile, D209, is the shell of
  shell tasks without `options.shell`, else the default terminal profile's shell (D229, VS Code's rule), and their arguments are quoted for it (bash quoting in a WSL folder); its `env` null
  removes a variable from the task's process), problems into `services.problems`
  (owner `task:<label>`), terminate / restart, the running list. A task's terminal taken back
  after Developer: Reload window is linked to its task again (`adopt`, from
  `services.taskTerminals.onDidReattach`): exit tracking, problem matchers on what it prints next.

**Commands:** `tasks.run {label, wait}` ("Run task…"), `tasks.runBuild` (Ctrl/Cmd+Shift+B),
`tasks.runTest`, `tasks.rerun`, `tasks.terminate`, `tasks.restart`, `tasks.showRunning`,
`tasks.list`, `tasks.configure` (opens the project's tasks.json, `<workspace folder>/tasks.json`
or `.vscode`'s, and creates it from a template if needed), `tasks.openUserTasks`,
`tasks.configureDefaultBuild` / `tasks.configureDefaultTest {label?}` (VS Code's "Configure
default build / test task", D200: `defaultTask.ts`, tested — the picked task gets
`"group": { "kind", "isDefault": true }` in the tasks.json it comes from; a package.json script
gets an entry of its own (`"type": "npm"`, or a shell task for pnpm / yarn / bun) in the project's
tasks.json, or in a new `.vscode/tasks.json` when the folder has `.vscode`, else the IDE's folder;
the old default stays in the group, in every one of the folder's tasks.json files; comments outside
the `tasks` array are kept). A detected Make / Cargo / tsc… task gets a shell task with its
`options.cwd` and problem matcher.
**State:** `ide://tasks` (running tasks, recent labels). **Settings:** `task.allowAutomaticTasks`,
`task.autoDetect`, `task.autoDetectDepth`.
**Tests:** `tasks.test.ts`, `problemMatchers.test.ts`, `detect.test.ts`, `tests/scripts/tasks-m7-2.jsonc`, `tests/scripts/gaps-m7-4.jsonc`, `tests/scripts/workspace-config.jsonc`,
`tests/scripts/features-m6-33.jsonc`.

**Multi-root workspaces (D251).** `load()` reads every folder's tasks.json files (`folders.ts`
`configFilesOf`: sources like `api/.vscode/tasks.json`), the workspace file's `tasks`, the user's,
then each folder's package.json scripts and build files (`detectFolders.ts` caches per folder).
A folder's tasks know it (`workspaceFolder`, `folderName`; the tasks.json `file` and its `inputs`):
`${workspaceFolder}`, `${workspaceFolderBasename}`, `${relativeFile}`, `${fileWorkspaceFolder}`,
the default and relative cwd (`taskCwd`) and problem matchers' `fileLocation` are that folder's;
`${workspaceFolder:Name}` works everywhere (`substitute`, `resolveMatchers`). User and
workspace-file tasks use the active editor's folder, else the first. With several folders a
folder's task is labelled "build (api)" (`name` keeps "build"); a plain label is found when it's
clear, in the editor's folder for the user, in `folder` for `tasks.run {label, folder?}`, and a
dependency in its task's folder first (`findNamed`). `tasks.configure {folder?}` (a name or path;
else the editor's folder, else asks: `chooseFolder.ts`, also used by debug and terminals).
`tasks.list` and `ide://tasks` add `folder` in multi-root. `runOn: "folderOpen"` runs per folder,
also for a folder added later (trusted only). With one folder nothing changes. Labels get the
folder's name only with several folders (as VS Code), so going from one folder to two and back
renames them; nothing stored keeps a label — the recent tasks (`TaskRunner.recent`, this session
only) are found again by name for Rerun last task. Tests: `folders.test.ts`.
