//! Command-line arguments: `<binary> [folder | file.code-workspace] [file[:line[:column]]…]
//! [--add <folder>]… [--diff <a> <b>] [--wait] [--goto] [--new-window] [--verbose]
//! [--run-test-script <file>] [--user-data-dir <dir>] [--test-timeout <seconds>]
//! [--disable-extensions] [--help] [--version]` (VS Code's names, D209). Flags that take a
//! value consume it, so a value is never mistaken for the folder or a file to open. Files and
//! added folders are made absolute against the current folder (a running window gets them from
//! another process).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::instances::FileArg;

/// Kills a test run that never reports back (a hung UI must still fail CI).
const DEFAULT_TEST_TIMEOUT_S: u64 = 300;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CliArgs {
    /// The folder to open, or a `.code-workspace` file (the window opens it as a workspace).
    pub folder: Option<PathBuf>,
    /// `--add <folder>` (repeatable, absolute): folders added to the last focused window's
    /// workspace; with no window running, the first is the folder of a new one.
    pub add: Vec<PathBuf>,
    /// Files to open, with a line and column when given as `file:line[:column]`.
    pub files: Vec<FileArg>,
    /// `--diff <a> <b>`: the two files side by side.
    pub diff: Option<(String, String)>,
    /// `--wait` / `-w`: the command returns once the files' tabs are closed (git's editor).
    pub wait: bool,
    pub test_script: Option<PathBuf>,
    pub user_data_dir: Option<PathBuf>,
    pub test_timeout_s: u64,
    /// Started by "New window": don't reopen the last folder.
    pub new_window: bool,
    /// `--restored` (internal, D229): a window the last session's restore starts; it opens
    /// where that folder's window was, not at the default place.
    pub restored: bool,
    /// `--restore-empty <id>` (internal): a window the restore starts for the last session's
    /// empty window `id`, with the unsaved untitled text it kept.
    pub restore_empty: Option<String>,
    /// `--disable-extensions` (VS Code's flag, D204): this session runs no extensions.
    pub disable_extensions: bool,
    /// `--remote <authority>` (D252, `ssh:<host>` / `wsl:<distro>`), or a positional
    /// `ssh://<host>/<path>`: the window works on that remote.
    pub remote: Option<String>,
    /// The folder to open on the remote (its POSIX path), with `remote`.
    pub remote_folder: Option<String>,
    /// `--verbose`: stay attached to the terminal it was started from.
    pub verbose: bool,
    /// `--help` / `--version`: print it and exit, no window (D229).
    pub info: Option<CliInfo>,
    /// A link to the IDE (`<urlScheme>://<extension id>/…`, D255): an extension's URI handler
    /// takes it, in the window used last (or this one when none runs).
    pub open_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliInfo {
    Help,
    Version,
}

/// What `--help` prints: VS Code's layout, with only the flags the IDE has.
pub fn help_text(name: &str, version: &str) -> String {
    format!(
        "{name} {version}

Usage: {name} [options] [folder | workspace file | file[:line[:column]] ...]

Options:
  -a, --add <folder>         Add a folder to the last active window (repeatable).
  -d, --diff <file> <file>   Compare two files with each other.
  -g, --goto <file:line[:column]>
                             Open a file at the line and column (also for files that
                             don't exist yet).
  -n, --new-window           Open a new window.
      --remote <ssh:host>    Open the folder on another machine over SSH
                             (--remote ssh:me@box /home/me/app, or ssh://box/path).
  -w, --wait                 Wait for the files to be closed before returning.
      --disable-extensions   Run this session without extensions.
      --user-data-dir <dir>  Use this folder for settings and state (a separate profile).
      --verbose              Stay attached to the terminal.
  -v, --version              Print the version.
  -h, --help                 Print this help.
"
    )
}

/// `path[:line[:column]]` → the path and the position (only when what's before them exists, or
/// with `--goto`; a file named `a:1` stays itself).
pub fn parse_position(arg: &str, goto: bool, exists: &dyn Fn(&str) -> bool) -> FileArg {
    let whole = FileArg {
        path: arg.to_string(),
        line: None,
        column: None,
        missing: false,
    };
    if exists(arg) {
        return whole;
    }
    let number = |s: &str| -> Option<u32> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok().filter(|n| *n > 0)
    };
    let split = |s: &str| -> Option<(String, u32)> {
        let (head, tail) = s.rsplit_once(':')?;
        Some((head.to_string(), number(tail)?))
    };
    let Some((head, last)) = split(arg) else {
        return whole;
    };
    let (path, line, column) = match split(&head) {
        Some((path, line)) if !path.is_empty() && (goto || exists(&path)) => {
            (path, line, Some(last))
        }
        _ => (head, last, None),
    };
    // A drive letter is never a file ("C:12").
    if path.is_empty() || (path.len() == 1 && path.chars().all(|c| c.is_ascii_alphabetic())) {
        return whole;
    }
    if !goto && !exists(&path) {
        return whole;
    }
    FileArg {
        path,
        line: Some(line),
        column,
        missing: false,
    }
}

/// `ssh://box/home/me/app` → (`ssh:box`, `/home/me/app`): the frontend's remote location form
/// (`%20` and `%25` decoded; no `..`). None for anything else.
pub fn remote_location(arg: &str) -> Option<(String, String)> {
    let (scheme, rest) = arg.split_once("://")?;
    if !matches!(scheme, "ssh" | "wsl" | "container") {
        return None;
    }
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let authority = format!("{scheme}:{host}");
    crate::remote::Authority::parse(&authority).ok()?;
    let path = path.replace("%20", " ").replace("%25", "%");
    if path.split('/').any(|p| p == "..") {
        return None;
    }
    Some((authority, path))
}

/// `path` made absolute against `cwd` (as typed; `..` stays for the OS to resolve).
fn absolute(path: &str, cwd: Option<&Path>) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        return path.to_string();
    }
    match cwd {
        Some(dir) => dir.join(p).to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

impl CliArgs {
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Self {
        Self::parse_in(args, std::env::current_dir().ok().as_deref())
    }

    pub fn parse_in(args: impl IntoIterator<Item = OsString>, cwd: Option<&Path>) -> Self {
        let mut out = CliArgs {
            test_timeout_s: DEFAULT_TEST_TIMEOUT_S,
            ..CliArgs::default()
        };
        let mut goto = false;
        let mut positional: Vec<String> = Vec::new();
        let mut it = args.into_iter().skip(1);
        while let Some(arg) = it.next() {
            let s = arg.to_string_lossy();
            match s.as_ref() {
                "--run-test-script" => out.test_script = it.next().map(PathBuf::from),
                "--user-data-dir" => out.user_data_dir = it.next().map(PathBuf::from),
                "--new-window" | "-n" => out.new_window = true,
                "--restored" => out.restored = true,
                "--restore-empty" => {
                    out.restore_empty = it.next().map(|v| v.to_string_lossy().into_owned())
                }
                "--disable-extensions" => out.disable_extensions = true,
                "--remote" => {
                    out.remote = it
                        .next()
                        .map(|v| v.to_string_lossy().into_owned())
                        .filter(|v| crate::remote::Authority::parse(v).is_ok())
                }
                "--add" | "-a" => {
                    if let Some(dir) = it.next() {
                        let dir = dir.to_string_lossy();
                        out.add.push(PathBuf::from(absolute(&dir, cwd)));
                    }
                }
                "--wait" | "-w" => out.wait = true,
                "--goto" | "-g" => goto = true,
                "--verbose" => out.verbose = true,
                "--help" | "-h" => out.info = out.info.or(Some(CliInfo::Help)),
                "--version" | "-v" => out.info = out.info.or(Some(CliInfo::Version)),
                "--diff" | "-d" => {
                    let a = it.next().map(|v| v.to_string_lossy().into_owned());
                    let b = it.next().map(|v| v.to_string_lossy().into_owned());
                    if let (Some(a), Some(b)) = (a, b) {
                        out.diff = Some((absolute(&a, cwd), absolute(&b, cwd)));
                    }
                }
                "--test-timeout" => {
                    if let Some(n) = it.next().and_then(|v| v.to_string_lossy().parse().ok()) {
                        out.test_timeout_s = n;
                    }
                }
                "--" => positional.extend(it.by_ref().map(|a| a.to_string_lossy().into_owned())),
                _ if s.starts_with('-') => {} // unknown flags (e.g. from the OS) are ignored
                _ => positional.push(s.into_owned()),
            }
        }
        // A link to the IDE (the OS starts the program with it, D255): not a file.
        if let Some(at) = positional
            .iter()
            .position(|p| crate::url_scheme::is_link(p))
        {
            out.open_url = Some(positional.remove(at));
        }
        // A remote location (`ssh://box/home/me/app`): that remote and folder.
        if out.remote.is_none() {
            if let Some((authority, path)) = positional.first().and_then(|p| remote_location(p)) {
                out.remote = Some(authority);
                out.remote_folder = Some(path);
                positional.remove(0);
            }
        }
        // With a remote, the folder is the remote's (a POSIX path, never looked for here).
        if out.remote.is_some() {
            if out.remote_folder.is_none() {
                out.remote_folder = positional.iter().find(|p| p.starts_with('/')).cloned();
            }
            return out;
        }
        let exists = |p: &str| Path::new(&absolute(p, cwd)).exists();
        for arg in positional {
            let abs = absolute(&arg, cwd);
            let path = Path::new(&abs);
            // A folder, or a workspace file (`team.code-workspace`): what the window opens.
            let workspace_file = path.is_file() && crate::fs::is_workspace_file_name(path);
            if path.is_dir() || (workspace_file && out.folder.is_none()) {
                if out.folder.is_none() {
                    out.folder = Some(PathBuf::from(&arg));
                }
                continue;
            }
            let mut file = parse_position(&arg, goto, &exists);
            file.path = absolute(&file.path, cwd);
            // A file that doesn't exist yet opens as an untitled editor that saves there.
            file.missing = !Path::new(&file.path).exists();
            out.files.push(file);
        }
        out
    }

    pub fn current() -> Self {
        let mut args = Self::parse(std::env::args_os());
        // `npm run dev:fresh` (D164): a throwaway profile without passing flags through npm and
        // tauri dev (PowerShell eats the `--` they need).
        if args.user_data_dir.is_none() {
            args.user_data_dir = std::env::var_os("IDE_USER_DATA_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from);
        }
        args
    }

    /// Something to open in a window was asked for (a folder, files, a diff, folders to add,
    /// a remote).
    pub fn wants_something(&self) -> bool {
        self.folder.is_some()
            || self.remote.is_some()
            || !self.files.is_empty()
            || self.diff.is_some()
            || !self.add.is_empty()
            || self.open_url.is_some()
    }

    /// The arguments as the window this process becomes takes them: with no folder, the first
    /// `--add` folder is the folder (no window ran to add it to) and the rest are added to it.
    pub fn into_window(mut self) -> Self {
        if self.folder.is_none() && !self.add.is_empty() {
            self.folder = Some(self.add.remove(0));
        }
        self
    }

    /// `--add` handed to a running window: the folder argument too (VS Code adds every folder
    /// named with `--add`), then the added ones; a workspace file is never added.
    pub fn folders_to_add(&self) -> Vec<String> {
        // The folder argument exists (it's only taken when it does): canonical, so absolute.
        let folder = self
            .folder
            .iter()
            .filter(|f| !crate::fs::is_workspace_file_name(f))
            .map(|f| {
                std::fs::canonicalize(f)
                    .map(crate::store::simplify)
                    .unwrap_or_else(|_| f.clone())
            });
        folder
            .chain(self.add.iter().cloned())
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> CliArgs {
        CliArgs::parse(list.iter().map(OsString::from))
    }

    #[test]
    fn a_link_to_the_ide_is_not_a_file() {
        let Some(scheme) = crate::url_scheme::scheme() else {
            return;
        };
        let link = format!("{scheme}://pub.ext/open?x=1");
        let a = args(&["ide", &link]);
        assert_eq!(a.open_url.as_deref(), Some(link.as_str()));
        assert!(a.files.is_empty());
        assert!(a.wants_something());
    }

    #[test]
    fn values_are_not_taken_as_the_folder() {
        let tmp = std::env::temp_dir();
        let t = tmp.to_string_lossy();
        let a = args(&["ide", "--user-data-dir", &t, "--run-test-script", "x.json"]);
        assert_eq!(a.folder, None);
        assert!(a.files.is_empty());
        assert_eq!(a.user_data_dir.as_deref(), Some(tmp.as_path()));
        assert_eq!(a.test_script, Some(PathBuf::from("x.json")));
        let b = args(&["ide", &t, "--test-timeout", "9"]);
        assert_eq!(b.folder.as_deref(), Some(tmp.as_path()));
        assert_eq!(b.test_timeout_s, 9);
        assert!(!b.disable_extensions);
        assert!(args(&["ide", "--disable-extensions"]).disable_extensions);
        let restored = args(&["ide", "--new-window", "--restore-empty", "ab12"]);
        assert_eq!(restored.restore_empty.as_deref(), Some("ab12"));
        assert!(restored.folder.is_none() && restored.files.is_empty());
        assert_eq!(args(&["ide", "--version"]).info, Some(CliInfo::Version));
        assert_eq!(args(&["ide", "-h", "-v"]).info, Some(CliInfo::Help));
        assert!(help_text("x", "1.0").contains("--new-window"));
    }

    #[test]
    fn a_remote_window_and_its_folder() {
        let a = args(&["ide", "--remote", "ssh:me@box", "/home/me/app"]);
        assert_eq!(a.remote.as_deref(), Some("ssh:me@box"));
        assert_eq!(a.remote_folder.as_deref(), Some("/home/me/app"));
        assert!(a.folder.is_none() && a.files.is_empty() && a.wants_something());
        let b = args(&["ide", "ssh://box/home/me/my%20app"]);
        assert_eq!(b.remote.as_deref(), Some("ssh:box"));
        assert_eq!(b.remote_folder.as_deref(), Some("/home/me/my app"));
        // An authority that isn't one is ignored (never an ssh option).
        assert!(args(&["ide", "--remote", "ssh:-oProxyCommand=x"])
            .remote
            .is_none());
        assert_eq!(remote_location("ssh://box/a/../etc"), None);
        assert_eq!(remote_location("http://box/a"), None);
        assert_eq!(
            remote_location("wsl://Ubuntu"),
            Some(("wsl:Ubuntu".into(), "/".into()))
        );
        // A dev container's folder (D266).
        assert_eq!(
            remote_location("container://node@0123456789ab/workspaces/app"),
            Some((
                "container:node@0123456789ab".into(),
                "/workspaces/app".into()
            ))
        );
        assert_eq!(remote_location("container://node@-it/x"), None);
    }

    #[test]
    fn file_line_and_column() {
        let exists = |p: &str| p == "src/a.ts" || p == r"C:\w\b.ts" || p == "odd:1";
        let at = |a: &str, goto: bool| {
            let f = parse_position(a, goto, &exists);
            (f.path, f.line, f.column)
        };
        assert_eq!(
            at("src/a.ts:12", false),
            ("src/a.ts".into(), Some(12), None)
        );
        assert_eq!(
            at("src/a.ts:12:5", false),
            ("src/a.ts".into(), Some(12), Some(5))
        );
        assert_eq!(
            at(r"C:\w\b.ts:3:4", false),
            (r"C:\w\b.ts".into(), Some(3), Some(4))
        );
        assert_eq!(at(r"C:\w\b.ts", false), (r"C:\w\b.ts".into(), None, None));
        // A file whose name ends like a position is itself.
        assert_eq!(at("odd:1", false), ("odd:1".into(), None, None));
        // Not there: taken as typed, unless --goto says it's a position.
        assert_eq!(at("new.ts:7", false), ("new.ts:7".into(), None, None));
        assert_eq!(at("new.ts:7", true), ("new.ts".into(), Some(7), None));
        assert_eq!(at("C:12", true), ("C:12".into(), None, None));
        assert_eq!(at("a.ts:0", true), ("a.ts:0".into(), None, None));
    }

    #[test]
    fn files_diff_and_wait() {
        let dir = std::env::temp_dir().join(format!("ide-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a.txt");
        let _ = std::fs::write(&file, "x");
        let list = ["ide", "a.txt:3", "--wait", "--diff", "a.txt", "b.txt"];
        let a = CliArgs::parse_in(list.iter().map(OsString::from), Some(&dir));
        assert!(a.wait);
        assert_eq!(a.files.len(), 1);
        assert_eq!(a.files[0].path, file.to_string_lossy());
        assert_eq!(a.files[0].line, Some(3));
        let (left, right) = a.diff.clone().unwrap_or_default();
        assert_eq!(left, file.to_string_lossy());
        assert!(right.ends_with("b.txt"));
        assert!(a.wants_something());
        assert!(!a.files[0].missing);
        // A file that doesn't exist yet: marked, to open as an untitled editor that saves there.
        let b = CliArgs::parse_in(["ide", "new.md"].iter().map(OsString::from), Some(&dir));
        assert!(b.files[0].missing);
        assert!(b.files[0].path.ends_with("new.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_files_and_added_folders() {
        let dir = std::env::temp_dir().join(format!("ide-cli-ws-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("one"));
        let _ = std::fs::write(dir.join("team.code-workspace"), "{}");
        let parse = |list: &[&str]| CliArgs::parse_in(list.iter().map(OsString::from), Some(&dir));
        // An existing workspace file is the folder argument; a missing one is a file to open.
        let a = parse(&["ide", "team.code-workspace"]);
        assert_eq!(a.folder, Some(PathBuf::from("team.code-workspace")));
        assert!(a.files.is_empty());
        let b = parse(&["ide", "gone.code-workspace"]);
        assert!(b.folder.is_none() && b.files.len() == 1);
        // `--add` (repeatable) takes its value, made absolute; never the folder itself.
        let c = parse(&["ide", "--add", "one", "-a", "two"]);
        assert!(c.folder.is_none());
        assert_eq!(c.add, vec![dir.join("one"), dir.join("two")]);
        assert!(c.wants_something());
        assert_eq!(c.folders_to_add().len(), 2);
        // Started as the window (no window ran): the first is its folder, the rest are added.
        let window = c.clone().into_window();
        assert_eq!(window.folder, Some(dir.join("one")));
        assert_eq!(window.add, vec![dir.join("two")]);
        // A folder argument is added too; a workspace file never is.
        let d = parse(&["ide", "one", "--add", "two"]);
        assert_eq!(d.folders_to_add().len(), 2);
        assert_eq!(d.clone().into_window(), d);
        let e = parse(&["ide", "team.code-workspace", "--add", "two"]);
        assert_eq!(
            e.folders_to_add(),
            vec![dir.join("two").to_string_lossy().into_owned()]
        );
        assert!(help_text("x", "1.0").contains("--add <folder>"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
