# Tasks

Tasks run your project's tools (build, test, lint, a dev server, a watcher) from inside the IDE,
each in a terminal tab, with their errors collected in **Problems**. Tasks use VS Code's
`tasks.json` format, so a project's `.vscode/tasks.json` works as it is, and the IDE also finds
tasks on its own: package.json scripts and the targets of your build files. This page covers
running tasks, where they come from, writing `tasks.json`, build and test tasks, problem
matchers, background tasks and the shell tasks run in.

## Run a task

1. Choose **Terminal → Run task…** (or run **Run task…** from the Command Palette).
   [Run task](command:tasks.run)
2. Pick a task. The list has your `tasks.json` tasks, package.json scripts and the tasks detected
   in your build files.

The task runs in its own terminal tab: a line saying the task is executing above its output, and
its exit code below, with "press any key to close". While tasks run, the status bar shows them
(the task's name, or how many); click it to show one.

| Command | Keys | What it does |
|---|---|---|
| Run task… | | Picks a task and runs it |
| Run build task | Ctrl+Shift+B | Runs the default build task (or asks among the build tasks) |
| Run test task | | Runs the default test task (or asks among the test tasks) |
| Rerun last task | | Runs the last task again |
| Show running tasks… | | Shows a running task's terminal |
| Restart running task… | | Stops a running task and starts it again |
| Terminate task… | | Stops a running task |
| Configure tasks | | Opens the folder's `tasks.json`, creating it if needed |
| Configure default build task… | | Chooses what Ctrl+Shift+B runs |
| Configure default test task… | | Chooses what Run test task runs |
| Open user tasks | | Opens your own `tasks.json`, for every folder |

The **Terminal** menu has all of these except Run test task, and the gear menu's **Tasks** submenu
has Run task…, Show running tasks…, Configure tasks and Open user tasks.

## Where tasks come from

| Source | Labels look like |
|---|---|
| The folder's `.vscode/tasks.json` | Your `label` |
| A `tasks.json` in the IDE's own folder in the project (wins over `.vscode`'s for the same label) | Your `label` |
| A workspace file's `tasks` (several folders, see [Workspaces and trust](20-workspaces.md)) | Your `label` |
| Your user `tasks.json`, next to your user settings (**Open user tasks**) | Your `label` |
| `package.json` scripts, run with the project's package manager (npm, pnpm, yarn or bun, from its lock file) | `npm: dev`, `pnpm: test` |
| Build files (see below) | `make: test`, `cargo: build` |
| Extensions | As the extension names them |

A package.json script named `build` is in the build group and one named `test` in the test group.

### Detected tasks

Besides `tasks.json` and package.json scripts, the IDE finds tasks in your build files, as VS
Code's task providers do:

| Build file | Tasks | Problem matcher |
|---|---|---|
| `tsconfig*.json` | `tsc: build - tsconfig.json` and `tsc: watch - tsconfig.json` | `$tsc`, `$tsc-watch` |
| `Makefile` | `make: <target>` for each target | `$gcc` |
| `Cargo.toml` | `cargo: build`, `check`, `test`, and `run` for a package with a binary | `$rustc` |
| `build.gradle` | `gradle: build`, `test`, and `run` with the application plugin | |
| `pom.xml` | `maven: compile`, `test`, `package` | |
| gulpfile, Gruntfile | `gulp: <task>`, `grunt: <task>` | |

- The project's own tools are used when it has them: `node_modules/.bin/tsc`, `./gradlew`,
  `./mvnw`.
- Makefile targets come from make itself (in a trusted folder, when make is installed), so
  targets made with `$(foreach)` or `$(eval)`, or in included makefiles, show up too. Otherwise
  the Makefile's text is read.
- Tasks are found in the folder and the folders below it, down to `task.autoDetectDepth` levels
  (2 by default, so `packages/app`; at most 80 folders). A task from a subfolder is named after it,
  like `make: test - packages/native`, and runs there. Dependency, build output, hidden and
  ignored folders are skipped, and a Cargo, Gradle or Maven project hides its subfolders' own.
- Turn detection off with `task.autoDetect`. package.json scripts are always listed.

To make one of them what Ctrl+Shift+B runs, use [Configure default build
task…](#build-and-test-tasks).

## Configure tasks

Run **Configure tasks** to open the folder's `tasks.json`. It opens `.vscode/tasks.json` or the
one in the IDE's own folder if there is one, and otherwise creates one in the IDE's folder from a
template. [Configure tasks](command:tasks.configure)

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "npm run build",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": ["$tsc"]
    },
    {
      "label": "test",
      "type": "shell",
      "command": "npm",
      "args": ["test", "--", "--reporter=dot"],
      "group": "test",
      "dependsOn": ["build"]
    }
  ]
}
```

### Task properties

| Property | What it does |
|---|---|
| `label` | The task's name, shown in Run task… and used by `dependsOn` |
| `type` | `shell` (the command line runs in a shell), `process` (the program runs directly, with `args`), or `npm` (with `script`) |
| `command`, `args` | What to run; `args` are quoted for the shell |
| `options.cwd`, `options.env`, `options.shell` | The folder (relative to the workspace folder), extra environment variables, and a shell (`executable`, `args`) for this task; also at the top level for every task |
| `group` | `"build"` or `"test"`, or `{ "kind": "build", "isDefault": true }` for the default one |
| `dependsOn`, `dependsOrder` | Tasks to run first: all at once, or one after another with `"sequence"` |
| `isBackground` | The task keeps running (a watcher, a dev server); see [Background tasks](#background-tasks) |
| `problemMatcher` | How to read errors out of the output; see [Problem matchers](#problem-matchers) |
| `presentation` | How its terminal behaves; see [Presentation](#presentation) |
| `runOptions` | `{ "runOn": "folderOpen" }` runs it when the folder opens |
| `windows`, `osx`, `linux` | Fields that replace the task's own on that system |
| `detail` | A description shown in Run task… |
| `hide` | Leaves it out of Run task… (it still runs as a dependency or by name) |

### Variables

Commands, arguments, `options` and problem matchers can use VS Code's variables:

- `${workspaceFolder}`, `${workspaceFolderBasename}`, `${workspaceFolder:Name}` (a folder of a
  multi-root workspace by name)
- `${file}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`, `${fileDirname}`,
  `${relativeFile}`, `${relativeFileDirname}`, `${fileWorkspaceFolder}`, `${lineNumber}`
- `${cwd}`, `${pathSeparator}` (or `${/}`)
- `${env:NAME}` (an environment variable), `${config:key}` (a setting's value)
- `${input:id}` (asks you; see below) and `${command:id}` (the result of a command)

### Inputs

`${input:id}` asks for a value when the task runs. Define what it asks in `inputs`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "deploy",
      "type": "shell",
      "command": "./deploy.sh ${input:target} ${input:tag}"
    }
  ],
  "inputs": [
    {
      "id": "target",
      "type": "pickString",
      "description": "Where to deploy",
      "options": ["staging", "production"],
      "default": "staging"
    },
    { "id": "tag", "type": "promptString", "description": "Release tag" }
  ]
}
```

`promptString` asks for text (`"password": true` hides what you type), `pickString` offers
`options`, and `command` runs a command and uses its result.

## Build and test tasks

Ctrl+Shift+B (**Terminal → Run build task**) runs the default build task. With no default, it
runs the only build task, or asks among the build tasks (or all tasks when none is in the build
group).

To choose the default, run **Terminal → Configure default build task…** and pick a task. The IDE
writes `"group": { "kind": "build", "isDefault": true }` into the `tasks.json` the task comes
from:

- A package.json script gets an entry of its own in the project's `tasks.json` (`"type": "npm"`,
  or a shell task for pnpm, yarn or bun).
- A detected task (Make, Cargo, tsc…) gets a shell task with its folder and problem matcher.
- The old default stays in the build group, and comments outside the `tasks` list are kept.

**Configure default test task…** does the same for **Run test task**.

## Problem matchers

A problem matcher reads errors and warnings out of a task's output and puts them in **Problems**
(Ctrl+Shift+M), underlined in the files. Name a built-in one:

| Matcher | For |
|---|---|
| `$tsc`, `$tsc-watch` | TypeScript |
| `$eslint-stylish`, `$eslint-compact` | ESLint |
| `$gcc` | GCC, Clang and make |
| `$msCompile` | MSBuild and the Microsoft compilers |
| `$rustc` | Rust and Cargo |
| `$go` | Go |
| `$jshint` | JSHint |
| `$lessCompile` | Less |
| `$esbuild`, `$esbuild-watch` | esbuild |

Extensions can add named matchers too. Or write your own, or extend one with `base`:

```json
"problemMatcher": {
  "owner": "mylint",
  "fileLocation": ["relative", "${workspaceFolder}"],
  "pattern": {
    "regexp": "^(.+):(\\d+):(\\d+): (warning|error): (.+)$",
    "file": 1,
    "line": 2,
    "column": 3,
    "severity": 4,
    "message": 5
  }
}
```

A pattern can also take `location`, `endLine`, `endColumn` and `code`. For errors that span
several lines, give a list of patterns; `"loop": true` on the last one repeats it for each further
match. `fileLocation` is `absolute`, `relative` (to a folder you give) or `autoDetect`.

## Background tasks

A background task keeps running: a watcher (`tsc --watch`) or a dev server. Mark it with
`"isBackground": true`. A task whose command looks like one (`dev`, `serve`, `start`, `watch`,
`preview`, `--watch`, `nodemon`) counts as one unless you say otherwise.

A background task that another task depends on counts as ready when its problem matcher sees a
build finish, or else when its output settles. A watch matcher marks each rebuild with
`background.beginsPattern` and `background.endsPattern`, as in VS Code (`$tsc-watch` and
`$esbuild-watch` already do).

```json
{
  "label": "watch",
  "type": "shell",
  "command": "npx tsc --watch",
  "isBackground": true,
  "problemMatcher": "$tsc-watch"
},
{
  "label": "serve",
  "type": "shell",
  "command": "npm run dev",
  "dependsOn": ["watch"]
}
```

## Presentation

`presentation` says how a task's terminal behaves:

| Property | Values | What it does |
|---|---|---|
| `reveal` | `always` (default), `silent`, `never` | When the terminal comes forward; `silent` only when the task fails or finds problems |
| `focus` | `false` (default), `true` | Puts the keyboard focus in the terminal |
| `panel` | `shared` (default), `dedicated`, `new` | Reuse a finished task's terminal, keep one per task, or always open a new one |
| `close` | `false` (default), `true` | Closes the terminal when the task ends |

A task's terminal opens next to your other terminals. Closing its tab ends the task.

## Run tasks when a folder opens

A task with `"runOptions": { "runOn": "folderOpen" }` starts when a trusted folder opens (and,
with several folders, when a folder with such a task is added). `task.allowAutomaticTasks` set to
`off` stops it.

## Choose the shell tasks run in

Shell tasks run their command line in a shell:

- `options.shell` on the task (or at the top of `tasks.json`) wins.
- Else the **automation profile**: `terminal.automationProfile.windows` (`.osx`, `.linux`), which
  also runs debug launches' commands. For example, to run tasks in Git Bash on Windows:

  ```json
  "terminal.automationProfile.windows": {
    "path": "C:\\Program Files\\Git\\bin\\bash.exe"
  }
  ```

  It takes `path`, `args` and `env` (`null` removes a variable from what the task runs). The flags
  that run one command (`-c`, `-Command`, `/d /c`) are added for you.
- Else the default terminal profile's shell, with its arguments and environment (VS Code's rule),
  and otherwise the IDE's default shell.

The task's arguments are quoted for that shell. A folder's settings may set the automation profile
once the folder is trusted.

> **Note:** On Windows, `.bat` and `.cmd` programs in `process` tasks (and `npm`, which is
> `npm.cmd`) run through `cmd.exe` with their arguments quoted safely; an argument with a line
> break is refused.

In a WSL folder (**File → Open WSL folder…**) tasks run inside the distribution: the `linux`
blocks of `tasks.json` apply, and the shell is `terminal.automationProfile.linux` (or
`options.shell`), else bash.

## Workspace trust

Tasks come from the folder's files, so they run only in a trusted folder. Running one in a folder
you haven't trusted yet asks first. See [Workspaces and trust](20-workspaces.md).

## Several folders

In a workspace with several folders each folder's tasks are its own: `${workspaceFolder}`, the
default and relative `cwd` and problem matchers' paths are that folder's. Their labels get the
folder's name, like `build (api)`. **Configure tasks** asks which folder (or uses the active
editor's). User and workspace-file tasks use the active editor's folder, else the first.

## Settings

| Setting | Default | Description |
|---|---|---|
| `task.autoDetect` | `on` | List tasks found in build files (tsc, Make, Cargo, Gradle, Maven, gulp, Grunt) |
| `task.autoDetectDepth` | `2` | How many folder levels below the root detection looks (0–3) |
| `task.allowAutomaticTasks` | `on` | Run `folderOpen` tasks when a trusted folder opens |
| `terminal.automationProfile.windows` | `{}` | The shell tasks and debug launches run in (also `.osx`, `.linux`) |

## Next steps

- [Terminal](10-terminal.md): the terminals tasks run in, and their profiles.
- [Debugging](13-debugging.md): run a task before a launch with `preLaunchTask`.
- [Testing](14-testing.md): the Testing view runs your tests one by one.
- [Workspaces and trust](20-workspaces.md): why tasks need a trusted folder.

## Common questions

### My `.vscode/tasks.json` doesn't show up.

Check that the folder is trusted and that the file is valid JSON (comments are allowed). A task
without a `command` (and no `dependsOn`) is skipped.

### Ctrl+Shift+B asks every time.

No build task is marked as the default. Run **Configure default build task…** and pick one.

### Errors from my task don't show in Problems.

Add a `problemMatcher` that fits the tool's output, such as `$tsc` or `$gcc`, or write your own.
Detected tsc, Make and Cargo tasks have one already.

### How do I run a task in Git Bash, WSL or another shell?

Set the [automation profile](#choose-the-shell-tasks-run-in), or `options.shell` on the task.
