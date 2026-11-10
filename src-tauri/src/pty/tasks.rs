//! What a task terminal runs (D134): a command line through a shell or a program with its
//! arguments, quoted for the shell or program that reads it (cmd.exe, batch files, PowerShell,
//! WSL's bash). Pure where it can be, for the tests.

use std::collections::HashMap;
use std::path::PathBuf;

use portable_pty::CommandBuilder;
use serde::Deserialize;

#[cfg_attr(not(windows), allow(unused_imports))]
use super::profiles;

/// A task to run in the terminal instead of an interactive shell (VS Code's tasks, D134): a
/// command line through a shell (`-c`, `-Command`, `/d /c`) or a program with arguments. The
/// terminal ends when it does.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    /// "shell" or "process".
    pub kind: String,
    /// The command line (shell) or the program (process).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// A shell other than the default one (tasks.json `options.shell`).
    pub shell: Option<ShellSpec>,
    /// A null value removes the variable (an automation profile's `env: { "X": null }`, D209).
    #[serde(default)]
    pub env: HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// The flags that make `program` run one command line (given after them) and exit. Login shells
/// on Unix (`-l`), so PATH additions from the profile (nvm, cargo…) are there, as in a terminal.
pub fn shell_run_flags(program: &str) -> Vec<String> {
    let file = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    let name = file.strip_suffix(".exe").unwrap_or(&file);
    match name {
        "cmd" => vec!["/d".into(), "/c".into()],
        "pwsh" | "powershell" => vec!["-NoLogo".into(), "-Command".into()],
        "bash" | "zsh" | "fish" => vec!["-l".into(), "-c".into()],
        _ => vec!["-c".into()],
    }
}

/// `${env:NAME}` in a task's command, arguments or environment: the IDE process's variable (empty
/// when unset), as in VS Code.
pub fn expand_env(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${env:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 6..];
        match after.find('}') {
            Some(end) => {
                out.push_str(&std::env::var(&after[..end]).unwrap_or_default());
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// What a task terminal starts: the command, its program (for the tab's title) and, for cmd.exe, a
/// command-line tail passed exactly as written (see `cmd_verbatim_tail`).
pub struct TaskLaunch {
    pub cmd: CommandBuilder,
    pub program: String,
    pub verbatim: Option<String>,
}

impl TaskLaunch {
    fn plain(cmd: CommandBuilder, program: String) -> Self {
        Self {
            cmd,
            program,
            verbatim: None,
        }
    }
}

/// The command a task runs: the program itself (process tasks) or the command line through the
/// task's shell (`options.shell`) or the default one.
pub fn task_command(spec: &RunSpec) -> TaskLaunch {
    if spec.kind == "process" {
        let program = expand_env(&spec.command);
        #[cfg(windows)]
        let program = {
            let pathext = std::env::var("PATHEXT").unwrap_or_default();
            let exists = |p: &std::path::Path| p.is_file();
            windows_program(&program, &profiles::path_dirs(), &pathext, &exists)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(program)
        };
        #[cfg(windows)]
        if is_batch_file(&program) {
            let args: Vec<String> = spec.args.iter().map(|a| expand_env(a)).collect();
            return TaskLaunch::plain(batch_command(&program, &args), program);
        }
        let mut cmd = CommandBuilder::new(&program);
        for arg in &spec.args {
            cmd.arg(expand_env(arg));
        }
        return TaskLaunch::plain(cmd, program);
    }
    let (program, args) = match &spec.shell {
        Some(shell) if !shell.args.is_empty() => (shell.executable.clone(), shell.args.clone()),
        Some(shell) => (shell.executable.clone(), shell_run_flags(&shell.executable)),
        None => {
            let (_, program) = super::default_shell_command();
            let flags = shell_run_flags(&program);
            (program, flags)
        }
    };
    let line = expand_env(&spec.command);
    // cmd.exe reads its command line with its own rules: the line goes there as written (D229's
    // leftover). Windows only: that's where the pseudo-console takes a verbatim tail.
    if cfg!(windows) && is_cmd(&program) {
        if let Some(tail) = cmd_verbatim_tail(&args, &line) {
            return TaskLaunch {
                cmd: CommandBuilder::new(&program),
                program,
                verbatim: Some(tail),
            };
        }
    }
    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }
    let runs_command = args
        .last()
        .is_some_and(|a| a.eq_ignore_ascii_case("-Command") || a.eq_ignore_ascii_case("-c"));
    if is_powershell(&program) && runs_command {
        // Windows PowerShell 5.1 has no && / || (D261: a task's `a && b` failed there; pwsh 7 has
        // them, and the IDE's own commands already get this, exec::shell_command).
        let legacy = program
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|f| f.to_lowercase().starts_with("powershell"));
        let line = if legacy {
            super::chain::ps5_chain(&line).unwrap_or(line)
        } else {
            line
        };
        cmd.arg(powershell_keep_exit_code(&line));
    } else {
        cmd.arg(line);
    }
    TaskLaunch::plain(cmd, program)
}

/// cmd.exe (`cmd`, `cmd.exe`, a path to it).
pub fn is_cmd(program: &str) -> bool {
    let file = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    file.strip_suffix(".exe").unwrap_or(&file) == "cmd"
}

/// The end of cmd.exe's command line for a shell task: its flags, `/s`, the run flag (`/c` or
/// `/k`, the last flag) and the line in one pair of quotes. With `/s` cmd takes off exactly the
/// first and the last quote and runs what's between as typed, so `echo "a b"` and
/// `"C:\Program Files\x.exe" "arg"` reach it as written (C quoting turned each `"` into `\"`,
/// which cmd doesn't read). None when the flags don't end in `/c` or `/k`, or the line has a line
/// break (cmd would stop there): the line is then passed the old way.
pub fn cmd_verbatim_tail(flags: &[String], line: &str) -> Option<String> {
    let (run, before) = flags.split_last()?;
    let runs = run.eq_ignore_ascii_case("/c") || run.eq_ignore_ascii_case("/k");
    if !runs || line.contains(['\r', '\n', '\0']) {
        return None;
    }
    let mut parts: Vec<String> = before
        .iter()
        .filter(|f| !f.eq_ignore_ascii_case("/s"))
        .map(|f| quote_arg(f))
        .collect();
    parts.push("/s".into());
    parts.push(run.clone());
    parts.push(format!("\"{line}\""));
    Some(parts.join(" "))
}

/// One argument quoted for a program that reads its command line the Microsoft C way
/// (CommandLineToArgvW): as is unless it's empty or has a space, tab, newline or quote.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// A whole command line: the program and its arguments quoted the C way, then `verbatim` as is.
// Windows: a command line is one string there.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn command_line(program: &str, args: &[String], verbatim: Option<&str>) -> String {
    let mut line = quote_arg(program);
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    if let Some(tail) = verbatim.filter(|t| !t.is_empty()) {
        line.push(' ');
        line.push_str(tail);
    }
    line
}

/// The shell a task runs in inside WSL and its arguments, the command line last: the task's own
/// (`options.shell`, or the linux automation profile the frontend put there) or bash as a login
/// shell. Windows shells don't apply there.
pub(super) fn wsl_task_shell(spec: &RunSpec, line: String) -> (String, Vec<String>) {
    let (program, mut args) = match &spec.shell {
        Some(shell) if spec.kind != "process" && !shell.executable.trim().is_empty() => {
            let args = if shell.args.is_empty() {
                shell_run_flags(&shell.executable)
            } else {
                shell.args.clone()
            };
            (shell.executable.clone(), args)
        }
        _ => ("bash".to_string(), vec!["-lc".to_string()]),
    };
    let runs_command = args
        .last()
        .is_some_and(|a| a.eq_ignore_ascii_case("-Command"));
    args.push(if is_powershell(&program) && runs_command {
        powershell_keep_exit_code(&line)
    } else {
        line
    });
    (program, args)
}

/// The same in a remote window (D252): the task's own shell, else the user's login shell there
/// (`""`: the server runs `$SHELL -l` with these arguments).
pub(super) fn remote_task_shell(spec: &RunSpec, line: String) -> (String, Vec<String>) {
    match &spec.shell {
        // A shell of this machine's (`C:\Program Files\Git\bin\bash.exe`, the Windows automation
        // profile) means nothing there: the login shell runs it.
        Some(shell)
            if spec.kind != "process"
                && !shell.executable.trim().is_empty()
                && !is_local_windows_program(&shell.executable) =>
        {
            wsl_task_shell(spec, line)
        }
        _ => (String::new(), vec!["-c".to_string(), line]),
    }
}

/// A Windows program's path or name (`C:\…`, `…\bash.exe`, `pwsh.exe`): not one on a Linux
/// remote.
fn is_local_windows_program(program: &str) -> bool {
    let p = program.trim();
    p.contains('\\')
        || p.get(1..2) == Some(":")
        || p.to_ascii_lowercase().ends_with(".exe")
        || p.to_ascii_lowercase().ends_with(".cmd")
}

fn is_powershell(program: &str) -> bool {
    let file = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    matches!(
        file.strip_suffix(".exe").unwrap_or(&file),
        "pwsh" | "powershell"
    )
}

/// `-Command` exits with 1 for any failure; the program's own exit code (tsc's 2, a test
/// runner's) is the task's instead, as in exec (D227). On a new line, so a trailing `# comment`
/// can't swallow it; a failed cmdlet (no exit code of its own) still gives 1.
pub fn powershell_keep_exit_code(line: &str) -> String {
    format!(
        "{line}\nif (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }} }}"
    )
}

/// The variable a batch file's command line reaches cmd.exe in (see `batch_command`).
#[cfg_attr(not(windows), allow(dead_code))]
const BATCH_LINE_VAR: &str = "IDE_BATCH_COMMAND_LINE";

/// A `.bat` / `.cmd` file: Windows runs it through cmd.exe, whatever starts it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_batch_file(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// One argument of a batch file's command line, quoted the way Rust's standard library does it
/// since the "BatBadBut" fix (CVE-2024-24576): quoted unless it's only letters, digits and
/// `#$*+-./:?@\_`; `"` doubled; backslashes before a quote doubled. A line break can't be passed
/// (cmd ends the command there): None. `%` needs nothing here: the line reaches cmd through a
/// variable, and what a variable expands to isn't expanded again.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn batch_quote(arg: &str) -> Option<String> {
    if arg.contains(['\r', '\n', '\0']) {
        return None;
    }
    let quote = arg.is_empty()
        || arg.ends_with('\\')
        || arg.chars().any(|c| {
            (c.is_ascii() && !(c.is_ascii_alphanumeric() || r"#$*+-./:?@\_".contains(c)))
                || c.is_control()
        });
    let mut out = String::with_capacity(arg.len() + 2);
    if quote {
        out.push('"');
    }
    let mut backslashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
        } else {
            if c == '"' {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push('"');
            }
            backslashes = 0;
        }
        out.push(c);
    }
    if quote {
        out.extend(std::iter::repeat_n('\\', backslashes));
        out.push('"');
    }
    Some(out)
}

/// A batch file's whole command line for cmd.exe: the script in quotes, then its arguments; None
/// when one of them can't be passed safely.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn batch_command_line(script: &str, args: &[String]) -> Option<String> {
    if script.contains(['"', '\r', '\n', '\0']) {
        return None;
    }
    let mut line = format!("\"{script}\"");
    for arg in args {
        line.push(' ');
        line.push_str(&batch_quote(arg)?);
    }
    Some(line)
}

/// A `.bat` / `.cmd` process task (D229). CreateProcess hands a batch file to cmd.exe, which reads
/// the arguments with its own rules (`&`, `|`, `%VAR%`, quotes): an argument quoted the C way can
/// run a second command ("BatBadBut"). So cmd.exe is started explicitly (`/e:ON /v:OFF /d`) on a
/// line quoted for cmd, and the line goes in a variable (`/c %VAR%`): portable-pty would quote it
/// the C way as an argument, and an expanded variable isn't expanded again (a `%` in an argument
/// stays as it is). An argument with a line break can't be passed: the task says so and fails.
#[cfg(windows)]
fn batch_command(script: &str, args: &[String]) -> CommandBuilder {
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut cmd = CommandBuilder::new(&comspec);
    for a in ["/e:ON", "/v:OFF", "/d", "/c"] {
        cmd.arg(a);
    }
    match batch_command_line(script, args) {
        Some(line) => {
            cmd.arg(format!("%{BATCH_LINE_VAR}%"));
            cmd.env(BATCH_LINE_VAR, line);
        }
        None => {
            let message = "echo A batch file's arguments can't contain line breaks. & exit /b 1";
            for word in message.split(' ') {
                cmd.arg(word);
            }
        }
    }
    cmd
}

/// A bare program name (`npm`, `tsc`) as Windows would start it from a command prompt: the first
/// PATH folder with `name` + one of PATHEXT's extensions (`.COM;.EXE;.BAT;.CMD` when unset).
/// portable-pty tries the bare name first, which finds Node's extensionless `npm` shell script
/// next to `npm.cmd` — not a program Windows can start ("not a valid Win32 application"). None
/// for a name with a folder or an extension of its own (it's taken as given).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_program(
    name: &str,
    path_dirs: &[PathBuf],
    pathext: &str,
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains('.') {
        return None;
    }
    let exts: Vec<&str> = if pathext.trim().is_empty() {
        vec![".COM", ".EXE", ".BAT", ".CMD"]
    } else {
        pathext
            .split(';')
            .map(str::trim)
            .filter(|e| e.starts_with('.') && e.len() > 1)
            .collect()
    };
    path_dirs.iter().find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{name}{}", ext.to_ascii_lowercase())))
            .find(|p| exists(p))
    })
}

/// A word for `bash -c`: single-quoted unless it's plain.
pub(super) fn shell_quote(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:,+@%".contains(c))
    {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::apply_run_env;
    use std::path::Path;

    #[test]
    fn batch_arguments_are_quoted_for_cmd() {
        // Plain words stay as they are; anything cmd reads specially goes in quotes.
        assert_eq!(batch_quote("run").as_deref(), Some("run"));
        assert_eq!(
            batch_quote("--port=3000").as_deref(),
            Some("\"--port=3000\"")
        );
        assert_eq!(batch_quote("src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(batch_quote("").as_deref(), Some("\"\""));
        assert_eq!(batch_quote("a b").as_deref(), Some("\"a b\""));
        // BatBadBut: a quote can't end the quoted part and let `&` run a second command.
        assert_eq!(
            batch_quote("\" & calc.exe").as_deref(),
            Some("\"\"\" & calc.exe\"")
        );
        assert_eq!(batch_quote("x&y").as_deref(), Some("\"x&y\""));
        assert_eq!(batch_quote("%PATH%").as_deref(), Some("\"%PATH%\""));
        // A trailing backslash would escape the closing quote for a program that reads `%~1`.
        assert_eq!(batch_quote("C:\\dir\\").as_deref(), Some("\"C:\\dir\\\\\""));
        assert_eq!(batch_quote("a\\\"b").as_deref(), Some("\"a\\\\\"\"b\""));
        assert_eq!(batch_quote("two\nlines"), None);
        assert_eq!(
            batch_command_line(
                "C:\\Program Files\\nodejs\\npm.cmd",
                &["run".into(), "dev & echo hi".into()]
            )
            .as_deref(),
            Some("\"C:\\Program Files\\nodejs\\npm.cmd\" run \"dev & echo hi\"")
        );
        assert_eq!(batch_command_line("a.cmd", &["x\ry".into()]), None);
        assert!(is_batch_file("C:\\x\\Build.CMD"));
        assert!(is_batch_file("run.bat"));
        assert!(!is_batch_file("node.exe"));
    }

    #[test]
    fn wsl_tasks_use_their_own_shell_or_bash() {
        let spec = |shell: Option<ShellSpec>| RunSpec {
            kind: "shell".into(),
            command: "make".into(),
            args: vec![],
            shell,
            env: HashMap::new(),
        };
        assert_eq!(
            wsl_task_shell(&spec(None), "make".into()),
            (
                "bash".to_string(),
                vec!["-lc".to_string(), "make".to_string()]
            )
        );
        let zsh = ShellSpec {
            executable: "/usr/bin/zsh".into(),
            args: vec![],
        };
        assert_eq!(
            wsl_task_shell(&spec(Some(zsh)), "make".into()),
            (
                "/usr/bin/zsh".to_string(),
                vec!["-l".to_string(), "-c".to_string(), "make".to_string()]
            )
        );
        let fish = ShellSpec {
            executable: "fish".into(),
            args: vec!["-c".into()],
        };
        assert_eq!(
            wsl_task_shell(&spec(Some(fish)), "make".into()).1,
            ["-c", "make"]
        );
        let pwsh = ShellSpec {
            executable: "pwsh".into(),
            args: vec![],
        };
        let (_, args) = wsl_task_shell(&spec(Some(pwsh)), "make".into());
        assert!(args.last().is_some_and(|a| a.contains("LASTEXITCODE")));
        // A remote window (D252): the login shell there, unless the task names a shell of the
        // remote's; this machine's Git Bash isn't one.
        assert_eq!(
            remote_task_shell(&spec(None), "make".into()),
            (String::new(), vec!["-c".to_string(), "make".to_string()])
        );
        let git_bash = ShellSpec {
            executable: r"C:\Program Files\Git\bin\bash.exe".into(),
            args: vec![],
        };
        assert_eq!(
            remote_task_shell(&spec(Some(git_bash)), "make".into()).0,
            ""
        );
        let zsh = ShellSpec {
            executable: "/usr/bin/zsh".into(),
            args: vec![],
        };
        assert_eq!(
            remote_task_shell(&spec(Some(zsh)), "make".into()).0,
            "/usr/bin/zsh"
        );
    }

    #[test]
    fn task_shells_run_one_command_line() {
        assert_eq!(
            shell_run_flags(r"C:\Windows\System32\cmd.exe"),
            ["/d", "/c"]
        );
        assert_eq!(
            shell_run_flags("C:/Program Files/PowerShell/7/pwsh.exe"),
            ["-NoLogo", "-Command"]
        );
        assert_eq!(shell_run_flags("/bin/zsh"), ["-l", "-c"]);
        assert_eq!(shell_run_flags("/bin/sh"), ["-c"]);
        let spec = RunSpec {
            kind: "process".into(),
            command: "node".into(),
            args: vec!["a b.js".into()],
            shell: None,
            env: HashMap::new(),
        };
        let TaskLaunch { cmd, program, .. } = task_command(&spec);
        // On Windows `node` is looked up on PATH (PATHEXT): its full path, ending in node.exe.
        let name = std::path::Path::new(&program)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        assert_eq!(name, "node");
        assert_eq!(cmd.get_argv().len(), 2);
        std::env::set_var("IDE_TASK_TEST", "x");
        assert_eq!(
            expand_env("a${env:IDE_TASK_TEST}b${env:IDE_NOPE}c${env:"),
            "axbc${env:"
        );
    }

    #[test]
    fn powershell_tasks_keep_the_programs_exit_code() {
        let spec = RunSpec {
            kind: "shell".into(),
            command: "tsc -p . # check".into(),
            args: vec![],
            shell: Some(ShellSpec {
                executable: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
                args: vec![],
            }),
            env: HashMap::new(),
        };
        let cmd = task_command(&spec).cmd;
        let last = cmd.get_argv().last().cloned().unwrap_or_default();
        let last = last.to_string_lossy();
        assert!(last.starts_with("tsc -p . # check\nif (-not $?)"), "{last}");
        // Other shells get the line as written.
        let bash = RunSpec {
            shell: Some(ShellSpec {
                executable: "/bin/bash".into(),
                args: vec![],
            }),
            ..spec
        };
        let cmd = task_command(&bash).cmd;
        assert_eq!(
            cmd.get_argv()
                .last()
                .map(|a| a.to_string_lossy().into_owned()),
            Some("tsc -p . # check".to_string())
        );
    }

    #[test]
    fn a_null_task_variable_is_removed() {
        // An automation profile's `env: { "X": null }` removes X from the task's process.
        let spec: RunSpec = serde_json::from_str(
            r#"{ "kind": "shell", "command": "x", "env": { "IDE_SET": "1", "PATH": null } }"#,
        )
        .unwrap();
        let mut cmd = task_command(&spec).cmd;
        apply_run_env(&mut cmd, &spec.env);
        assert_eq!(cmd.get_env("IDE_SET"), Some(std::ffi::OsStr::new("1")));
        assert_eq!(cmd.get_env("PATH"), None);
    }

    #[test]
    fn windows_programs_resolve_through_pathext_not_the_bare_script() {
        let node = PathBuf::from("C:/nodejs");
        let tools = PathBuf::from("C:/tools");
        let dirs = vec![node.clone(), tools.clone()];
        // Node's folder has the extensionless `npm` (a sh script) next to `npm.cmd`.
        let files = [node.join("npm"), node.join("npm.cmd"), tools.join("rg.exe")];
        let exists = |p: &Path| files.iter().any(|f| f == p);
        let ext = ".COM;.EXE;.BAT;.CMD";
        assert_eq!(
            windows_program("npm", &dirs, ext, &exists),
            Some(node.join("npm.cmd"))
        );
        assert_eq!(
            windows_program("rg", &dirs, "", &exists),
            Some(tools.join("rg.exe"))
        );
        assert_eq!(windows_program("node.exe", &dirs, ext, &exists), None);
        assert_eq!(windows_program("C:/x/npm", &dirs, ext, &exists), None);
        assert_eq!(windows_program("missing", &dirs, ext, &exists), None);
    }

    #[test]
    fn cmd_tasks_get_their_line_verbatim() {
        let flags = |f: &[&str]| f.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // The quotes reach cmd as written; `/s` makes it take off only the outer pair.
        assert_eq!(
            cmd_verbatim_tail(
                &flags(&["/d", "/c"]),
                r#"echo "a b" & "C:\Program Files\x.exe" "y""#
            )
            .as_deref(),
            Some(r#"/d /s /c "echo "a b" & "C:\Program Files\x.exe" "y"""#)
        );
        assert_eq!(
            cmd_verbatim_tail(&flags(&["/D", "/S", "/K"]), "dir").as_deref(),
            Some(r#"/D /s /K "dir""#)
        );
        // Not ending in /c or /k, or a line break: the old way.
        assert_eq!(cmd_verbatim_tail(&flags(&["/d"]), "dir"), None);
        assert_eq!(cmd_verbatim_tail(&flags(&[]), "dir"), None);
        assert_eq!(cmd_verbatim_tail(&flags(&["/c"]), "a\nb"), None);
        assert!(is_cmd(r"C:\Windows\System32\CMD.EXE"));
        assert!(is_cmd("cmd"));
        assert!(!is_cmd("cmdx.exe"));
        let spec = RunSpec {
            kind: "shell".into(),
            command: r#"echo "hi there""#.into(),
            args: vec![],
            shell: Some(ShellSpec {
                executable: r"C:\Windows\System32\cmd.exe".into(),
                args: vec![],
            }),
            env: HashMap::new(),
        };
        let launch = task_command(&spec);
        if cfg!(windows) {
            assert_eq!(launch.cmd.get_argv().len(), 1);
            assert_eq!(
                launch.verbatim.as_deref(),
                Some(r#"/d /s /c "echo "hi there"""#)
            );
        } else {
            assert!(launch.verbatim.is_none());
        }
    }

    #[test]
    fn arguments_are_quoted_for_command_line_to_argv() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        // A trailing backslash before the closing quote is doubled; elsewhere they stay.
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote_arg(r"C:\no\space\"), r"C:\no\space\");
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(
            command_line(r"C:\Windows\cmd.exe", &[], Some(r#"/d /s /c "echo "a b"""#)),
            r#"C:\Windows\cmd.exe /d /s /c "echo "a b"""#
        );
        assert_eq!(
            command_line(
                r"C:\Program Files\x.exe",
                &["-a".into(), "b c".into()],
                None
            ),
            r#""C:\Program Files\x.exe" -a "b c""#
        );
    }
}
