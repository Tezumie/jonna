//! Project formatters (D140): format a file with the tool the project itself uses — Biome or
//! Prettier from the project's `node_modules`, Ruff or Black when `pyproject.toml` configures
//! them (or `ruff.toml`), rustfmt in a Cargo project, gofmt, clang-format with a
//! `.clang-format` — like VS Code with those extensions installed. The text goes in on stdin and
//! comes back on stdout; nothing is written to disk. Detection walks up from the file to the
//! workspace root, so a nested package (`web/`, `src-tauri/`) uses its own tool. Fixed argument
//! lists only; the frontend asks only in trusted workspaces (these run project code).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formatter {
    /// "biome", "prettier", "ruff", "black", "rustfmt", "gofmt", "clang-format".
    pub name: &'static str,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Where it runs (the folder with the project's config).
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatted {
    pub formatter: &'static str,
    pub text: String,
}

const JS_LIKE: &[&str] = &[
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "jsonc", "css", "scss", "less",
    "html", "vue", "svelte", "md", "mdx", "yaml", "yml", "graphql", "gql",
];
/// What Biome formats (it skips the rest, which then fall to Prettier).
const BIOME: &[&str] = &[
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "jsonc", "css", "graphql", "gql",
];
const C_LIKE: &[&str] = &[
    "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "proto",
];

/// A local `node_modules/.bin/<name>` (the `.cmd` shim on Windows).
fn node_bin(dir: &Path, name: &str) -> Option<PathBuf> {
    let bin = dir.join("node_modules").join(".bin");
    let path = if cfg!(windows) {
        bin.join(format!("{name}.cmd"))
    } else {
        bin.join(name)
    };
    path.is_file().then_some(path)
}

/// The folders from `file`'s up to `root` (inclusive), nearest first.
fn ancestors<'a>(root: &'a Path, file: &'a Path) -> impl Iterator<Item = &'a Path> {
    file.parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(move |d| d.starts_with(root))
}

fn contains(path: &Path, needle: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|t| t.contains(needle))
}

/// The project's formatter for `file`, if it has one. `find` locates a program on the user's
/// PATH (injected for tests).
pub fn detect(
    root: &Path,
    file: &Path,
    find: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<Formatter> {
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let path_arg = file.to_string_lossy().into_owned();
    let make = |name, program, args: Vec<String>, cwd: &Path| Formatter {
        name,
        program,
        args,
        cwd: cwd.to_path_buf(),
    };
    for dir in ancestors(root, file) {
        if JS_LIKE.contains(&ext.as_str()) {
            let biome_config =
                dir.join("biome.json").is_file() || dir.join("biome.jsonc").is_file();
            if biome_config && BIOME.contains(&ext.as_str()) {
                if let Some(bin) = ancestors(root, file).find_map(|d| node_bin(d, "biome")) {
                    return Some(make(
                        "biome",
                        bin,
                        vec!["format".into(), format!("--stdin-file-path={path_arg}")],
                        dir,
                    ));
                }
            }
            if let Some(bin) = node_bin(dir, "prettier") {
                return Some(make(
                    "prettier",
                    bin,
                    vec![format!("--stdin-filepath={path_arg}")],
                    dir,
                ));
            }
        }
        if ext == "py" || ext == "pyi" {
            let pyproject = dir.join("pyproject.toml");
            let ruff = dir.join("ruff.toml").is_file()
                || dir.join(".ruff.toml").is_file()
                || contains(&pyproject, "[tool.ruff");
            if ruff {
                if let Some(p) = find("ruff") {
                    return Some(make(
                        "ruff",
                        p,
                        vec![
                            "format".into(),
                            format!("--stdin-filename={path_arg}"),
                            "-".into(),
                        ],
                        dir,
                    ));
                }
            }
            if contains(&pyproject, "[tool.black") {
                if let Some(p) = find("black") {
                    return Some(make(
                        "black",
                        p,
                        vec![
                            "-q".into(),
                            format!("--stdin-filename={path_arg}"),
                            "-".into(),
                        ],
                        dir,
                    ));
                }
            }
        }
        if ext == "rs" && dir.join("Cargo.toml").is_file() {
            let edition = std::fs::read_to_string(dir.join("Cargo.toml"))
                .ok()
                .and_then(|t| {
                    t.lines()
                        .find_map(|l| l.trim().strip_prefix("edition").map(str::to_string))
                })
                .and_then(|l| l.split('"').nth(1).map(str::to_string))
                .unwrap_or_else(|| "2021".into());
            if let Some(p) = find("rustfmt") {
                return Some(make(
                    "rustfmt",
                    p,
                    vec!["--emit=stdout".into(), format!("--edition={edition}")],
                    dir,
                ));
            }
        }
        if C_LIKE.contains(&ext.as_str())
            && (dir.join(".clang-format").is_file() || dir.join("_clang-format").is_file())
        {
            if let Some(p) = find("clang-format") {
                return Some(make(
                    "clang-format",
                    p,
                    vec![format!("--assume-filename={path_arg}")],
                    dir,
                ));
            }
        }
    }
    if ext == "go" {
        if let Some(p) = find("gofmt") {
            let dir = file.parent().unwrap_or(root);
            return Some(make("gofmt", p, vec![], dir));
        }
    }
    None
}

/// A program on the user's PATH — also when the app was started from a desktop launcher with a
/// short PATH (the login shell is asked, then the usual install folders). Found ones are kept.
pub fn find_program(name: &str) -> Option<PathBuf> {
    static FOUND: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let cache = FOUND.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(p) = cache.lock().ok()?.get(name) {
        return Some(p.clone());
    }
    let found = which(name).or_else(|| login_shell_which(name));
    if let Some(p) = &found {
        cache.lock().ok()?.insert(name.to_string(), p.clone());
    }
    found
}

fn which(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ""]
    } else {
        &[""]
    };
    let path = std::env::var_os("PATH")?;
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("go").join("bin"));
    }
    if !cfg!(windows) {
        dirs.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin"].map(PathBuf::from),
        );
    }
    dirs.iter()
        .flat_map(|d| exts.iter().map(move |e| d.join(format!("{name}{e}"))))
        .find(|p| p.is_file())
}

#[cfg(not(windows))]
const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(3);

#[cfg(not(windows))]
fn login_shell_which(name: &str) -> Option<PathBuf> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // A login shell runs the user's profile, which can be slow or wait for input: bounded.
    let (_, stdout) = super::output_within(
        Command::new(shell)
            .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
            .args(["-lc", &format!("command -v {name}")]),
        LOGIN_SHELL_DEADLINE,
    )?;
    let p = PathBuf::from(String::from_utf8_lossy(&stdout).trim());
    p.is_file().then_some(p)
}

/// Windows: the PATH as it is now in the registry (a program installed after the IDE started —
/// `npm i -g …`, winget — is found without a restart, D192), and npm's global folder.
#[cfg(windows)]
fn login_shell_which(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = super::fresh_windows_path();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    dirs.iter()
        .flat_map(|d| [".exe", ".cmd", ".bat", ""].map(|e| d.join(format!("{name}{e}"))))
        .find(|p| p.is_file())
}

/// Runs the formatter with `text` on stdin; its stdout is the formatted text.
pub fn run(f: &Formatter, text: &str, timeout: Duration) -> Result<String> {
    let mut cmd = Command::new(&f.program);
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    cmd.args(&f.args)
        .current_dir(&f.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = crate::job::spawn(&mut cmd)
        .map_err(|e| Error::Exec(format!("{} didn't start: {e}", f.name)))?;
    // Write stdin from a thread: a big file could fill the stdout pipe before stdin is drained.
    let input = text.to_string();
    let mut stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.write_all(input.as_bytes());
        }
    });
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(p) = stdout.as_mut() {
            let _ = p.read_to_end(&mut out);
        }
        out
    });
    let err_reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(p) = stderr.as_mut() {
            let _ = p.read_to_end(&mut out);
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            // A `.cmd` shim (node_modules/.bin on Windows) runs node under cmd.exe; killing cmd
            // alone would leave node running and holding our pipes.
            #[cfg(windows)]
            super::taskkill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            // Let the I/O threads see the pipes close, but never block on a straggler.
            super::wait_for_readers(vec![writer], Duration::from_millis(500));
            super::wait_for_readers(vec![reader, err_reader], Duration::from_millis(500));
            return Err(Error::Exec(format!("{} took too long", f.name)));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = writer.join();
    let out = reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let msg = String::from_utf8_lossy(&err);
        let first = msg
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("failed");
        return Err(Error::Exec(format!("{}: {}", f.name, first.trim())));
    }
    let formatted = String::from_utf8(out)
        .map_err(|_| Error::Exec(format!("{} returned text that isn't UTF-8", f.name)))?;
    // An empty answer for a non-empty file is a broken formatter, not an empty file.
    if formatted.is_empty() && !text.trim().is_empty() {
        return Err(Error::Exec(format!("{} returned nothing", f.name)));
    }
    Ok(formatted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-format-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("web/node_modules/.bin")).unwrap();
        std::fs::create_dir_all(dir.join("web/src")).unwrap();
        std::fs::create_dir_all(dir.join("app/src")).unwrap();
        std::fs::create_dir_all(dir.join("py")).unwrap();
        let shim = if cfg!(windows) {
            "prettier.cmd"
        } else {
            "prettier"
        };
        std::fs::write(dir.join("web/node_modules/.bin").join(shim), "").unwrap();
        std::fs::write(
            dir.join("app/Cargo.toml"),
            "[package]\nedition = \"2024\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("py/pyproject.toml"),
            "[tool.ruff]\nline-length = 100\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn picks_the_nearest_projects_tool() {
        let root = tree("detect");
        let find = |name: &str| Some(PathBuf::from(format!("/bin/{name}")));
        let f = detect(&root, &root.join("web/src/a.tsx"), &find).unwrap();
        assert_eq!(f.name, "prettier");
        assert_eq!(f.cwd, root.join("web"));
        let r = detect(&root, &root.join("app/src/main.rs"), &find).unwrap();
        assert_eq!(r.name, "rustfmt");
        assert!(r.args.contains(&"--edition=2024".to_string()));
        assert_eq!(
            detect(&root, &root.join("py/x.py"), &find).unwrap().name,
            "ruff"
        );
        // No project tool: nothing (the editor's own formatter is used).
        assert_eq!(detect(&root, &root.join("notes.txt"), &find), None);
        assert_eq!(detect(&root, &root.join("app/src/a.ts"), &find), None);
        // Biome configured beside prettier: biome for what it formats, prettier for the rest.
        std::fs::write(root.join("web/biome.json"), "{}").unwrap();
        let shim = if cfg!(windows) { "biome.cmd" } else { "biome" };
        std::fs::write(root.join("web/node_modules/.bin").join(shim), "").unwrap();
        assert_eq!(
            detect(&root, &root.join("web/src/a.ts"), &find)
                .unwrap()
                .name,
            "biome"
        );
        assert_eq!(
            detect(&root, &root.join("web/README.md"), &find)
                .unwrap()
                .name,
            "prettier"
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_through_stdin_and_reports_failures() {
        let cwd = std::env::temp_dir();
        let upper = Formatter {
            name: "tr",
            program: "tr".into(),
            args: vec!["a-z".into(), "A-Z".into()],
            cwd: cwd.clone(),
        };
        assert_eq!(
            run(&upper, "abc\n", Duration::from_secs(5)).unwrap(),
            "ABC\n"
        );
        let failing = Formatter {
            name: "false",
            program: "false".into(),
            args: vec![],
            cwd,
        };
        assert!(run(&failing, "x", Duration::from_secs(5)).is_err());
    }
}
