//! The IDE's own git pauses for a repository whose git settings changed after an agent's
//! sandboxed command ran there (D392). Git runs programs its settings name (core.fsmonitor on
//! every `git status`, hooks, sshCommand on fetch), and the IDE's git runs outside the sandbox.
//! macOS and Linux refuse the sandbox those writes (`exec::sandbox_protect`); Windows can't
//! (a low-integrity command may delete and remake a file in a folder it may write), so there
//! the IDE checks before it runs git, and this check stands behind the other two as well.
//!
//! - `arm`: before a sandboxed command, the settings of the repository holding each of its
//!   writable folders are recorded (once: a later command doesn't take over what an earlier
//!   one may have changed).
//! - `check`: before the IDE runs git in a recorded repository, its settings must be as
//!   recorded. A repository under such a folder that wasn't recorded (made or found later) must
//!   not have settings newer than the folder's first sandboxed command.
//! - `settle`: after the IDE's own git ran a command that may change settings (`git remote
//!   add`, `push -u`), what it left is the record.
//! - `trust`: the user looked at the change and accepts it (`git.trustSettings`).
//!
//! The record is kept in the data folder, so a restart doesn't skip the check. A sandboxed
//! process ends with the IDE (D180): a record from an earlier session is dropped once it
//! matches.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Git's settings files in a git folder (what `sandbox_protect` keeps read-only).
const SETTINGS_FILES: &[&str] = &["config", "config.worktree", "commondir"];
/// Hooks larger than this are recorded by size and time only.
const MAX_HASHED: u64 = 4 << 20;
/// The record's file in the data folder.
const FILE_NAME: &str = "git-guard.json";

/// One repository's settings: each file (relative name) and a hash of what it holds.
type Print = BTreeMap<String, String>;

#[derive(Default)]
struct Guard {
    data_file: Option<PathBuf>,
    /// Folders where sandboxed commands ran this session, with the time of the first.
    armed: Vec<(String, SystemTime)>,
    prints: HashMap<String, Print>,
    /// Records from an earlier session (dropped once they match).
    earlier: HashSet<String>,
}

static GUARD: Mutex<Option<Guard>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Guard) -> T) -> T {
    let mut lock = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    f(lock.get_or_insert_with(Guard::default))
}

/// Loads the record kept by an earlier session (at startup).
pub fn init(data_dir: &Path) {
    let file = data_dir.join(FILE_NAME);
    let saved: HashMap<String, Print> = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    with(|g| {
        g.data_file = Some(file);
        g.earlier = saved.keys().cloned().collect();
        for (k, v) in saved {
            g.prints.entry(k).or_insert(v);
        }
    });
}

fn save(g: &Guard) {
    let Some(file) = &g.data_file else { return };
    let result = if g.prints.is_empty() {
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::Io(e)),
            _ => Ok(()),
        }
    } else {
        serde_json::to_vec(&g.prints)
            .map_err(Error::from)
            .and_then(|b| crate::store::atomic_write(file, &b))
    };
    if let Err(e) = result {
        eprintln!("git guard: couldn't save {}: {e}", file.display());
    }
}

/// A path as the record compares it: canonical where it can be (not a network path: that
/// would connect), `/` separators, lower case on Windows.
fn key(p: &Path) -> String {
    let lexical = crate::exec::sandbox_read::lexical(p);
    let resolved = if crate::fs::is_unc(&lexical.to_string_lossy()) {
        lexical
    } else {
        std::fs::canonicalize(&lexical)
            .map(crate::store::simplify)
            .unwrap_or(lexical)
    };
    let s = resolved.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn holds(folder: &str, inner: &str) -> bool {
    inner == folder || inner.starts_with(&format!("{folder}/"))
}

/// The folder holding the repository `dir` is in (where its `.git` is).
fn repo_top(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The repository's git folders: its own (a linked worktree's or a submodule's is elsewhere,
/// named by its `.git` file) and the common one; then its submodules' (`modules/…`).
fn git_dirs(top: &Path) -> Vec<PathBuf> {
    let dot = top.join(".git");
    let own = if dot.is_dir() {
        dot
    } else {
        let Ok(text) = std::fs::read_to_string(&dot) else {
            return Vec::new();
        };
        let Some(target) = text.trim().strip_prefix("gitdir:") else {
            return Vec::new();
        };
        let p = PathBuf::from(target.trim());
        if p.is_absolute() {
            p
        } else {
            top.join(p)
        }
    };
    let mut dirs = vec![own.clone()];
    if let Ok(text) = std::fs::read_to_string(own.join("commondir")) {
        let p = PathBuf::from(text.trim());
        let common = if p.is_absolute() { p } else { own.join(p) };
        dirs.push(common);
    }
    let roots = dirs.clone();
    for d in &roots {
        dirs.extend(crate::exec::sandbox_protect::git_folders_under(
            &d.join("modules"),
        ));
    }
    dirs
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a file is now, for the record: its contents' hash (size and time for a big one),
/// "-" when it isn't there.
fn file_print(p: &Path) -> String {
    match std::fs::metadata(p) {
        Err(_) => "-".into(),
        Ok(m) if m.is_dir() => "dir".into(),
        Ok(m) if m.len() > MAX_HASHED => {
            let at = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("big:{}:{at}", m.len())
        }
        Ok(_) => std::fs::read(p)
            .map(|b| hash_bytes(&b))
            .unwrap_or_else(|_| "unreadable".into()),
    }
}

/// The settings files of the repository at `top`, by a name relative to it.
fn settings_files(top: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![(".git".to_string(), top.join(".git"))];
    for (i, dir) in git_dirs(top).iter().enumerate() {
        let label = match i {
            0 => ".git".to_string(),
            _ => dir.to_string_lossy().replace('\\', "/"),
        };
        for f in SETTINGS_FILES {
            out.push((format!("{label}/{f}"), dir.join(f)));
        }
        let hooks = dir.join("hooks");
        out.push((format!("{label}/hooks"), hooks.clone()));
        if let Ok(entries) = std::fs::read_dir(&hooks) {
            let mut names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
            names.sort();
            for name in names.into_iter().take(500) {
                out.push((
                    format!("{label}/hooks/{}", name.to_string_lossy()),
                    hooks.join(&name),
                ));
            }
        }
    }
    out
}

fn print_of(top: &Path) -> Print {
    let mut print = Print::new();
    for (name, path) in settings_files(top) {
        let value = if name == ".git" {
            // The pointer of a linked worktree's or a submodule's `.git` file is a setting too.
            match std::fs::metadata(&path) {
                Ok(m) if m.is_dir() => "dir".into(),
                _ => file_print(&path),
            }
        } else {
            file_print(&path)
        };
        print.insert(name, value);
    }
    print
}

/// Whether one of the settings files changed after `since`.
fn newer_than(top: &Path, since: SystemTime) -> Option<String> {
    settings_files(top)
        .into_iter()
        .filter(|(name, path)| name != ".git" && path.is_file())
        .find(|(_, path)| {
            std::fs::metadata(path)
                .and_then(|m| m.modified())
                .is_ok_and(|t| t > since)
        })
        .map(|(name, _)| name)
}

/// Before a sandboxed command whose writable folders are `folders`.
pub fn arm(folders: &[PathBuf]) {
    let now = SystemTime::now();
    let tops: Vec<(String, Option<PathBuf>)> =
        folders.iter().map(|f| (key(f), repo_top(f))).collect();
    let prints: Vec<(String, Print)> = tops
        .iter()
        .filter_map(|(_, top)| top.as_ref())
        .map(|top| (key(top), print_of(top)))
        .collect();
    with(|g| {
        let mut changed = false;
        for (folder, _) in &tops {
            if !g.armed.iter().any(|(f, _)| f == folder) {
                g.armed.push((folder.clone(), now));
            }
        }
        for (k, print) in prints {
            // Recorded already (this session or an earlier one): kept, so a later command
            // doesn't take over what an earlier one changed.
            if let std::collections::hash_map::Entry::Vacant(e) = g.prints.entry(k) {
                e.insert(print);
                changed = true;
            }
        }
        if changed {
            save(g);
        }
    });
}

/// The message when settings changed (the TS side shows it and offers the trust command).
fn changed_message(names: &[String]) -> String {
    let shown: Vec<&str> = names.iter().take(4).map(String::as_str).collect();
    let more = if names.len() > 4 {
        format!(" and {} more", names.len() - 4)
    } else {
        String::new()
    };
    format!(
        "Git is paused for this repository: its git settings changed after an agent's sandboxed command ran here ({}{more}). Git runs programs these settings name, so check them, then choose Trust git settings.",
        shown.join(", ")
    )
}

/// Before the IDE runs git in `dir`.
pub fn check(dir: &Path) -> Result<()> {
    // Cheap when nothing was ever recorded (most sessions): no file is read.
    if with(|g| g.prints.is_empty() && g.armed.is_empty()) {
        return Ok(());
    }
    let Some(top) = repo_top(dir) else {
        return Ok(());
    };
    let k = key(&top);
    let (recorded, armed_at) = with(|g| {
        let armed = g
            .armed
            .iter()
            .filter(|(f, _)| holds(f, &k) || holds(&k, f))
            .map(|(_, t)| *t)
            .min();
        (g.prints.get(&k).cloned(), armed)
    });
    match recorded {
        Some(before) => {
            let now = print_of(&top);
            if now == before {
                with(|g| {
                    // No sandboxed process outlives the session that started it.
                    // Armed either way round (D407): a folder inside the repository too (the
                    // workspace is `repo/sub`), as `check` above finds it.
                    if g.earlier.remove(&k)
                        && !g.armed.iter().any(|(f, _)| holds(f, &k) || holds(&k, f))
                    {
                        g.prints.remove(&k);
                        save(g);
                    }
                });
                return Ok(());
            }
            let names: Vec<String> = now
                .iter()
                .filter(|(n, v)| before.get(*n) != Some(v))
                .map(|(n, _)| n.clone())
                .chain(before.keys().filter(|n| !now.contains_key(*n)).cloned())
                .collect();
            Err(Error::GitSettingsChanged(changed_message(&names)))
        }
        None => {
            let Some(since) = armed_at else {
                return Ok(());
            };
            if let Some(name) = newer_than(&top, since) {
                return Err(Error::GitSettingsChanged(changed_message(&[name])));
            }
            let print = print_of(&top);
            with(|g| {
                g.prints.entry(k).or_insert(print);
                save(g);
            });
            Ok(())
        }
    }
}

/// Whether the IDE's git command `args` may change the repository's settings (`remote add`,
/// `push -u`, `branch -u`, `checkout --track`, `config <name> <value>`, `submodule update`,
/// `worktree add`, `lfs install`, `init`): what it leaves becomes the record. Only the forms that
/// write (D407): the listings a refresh runs all the time (`remote -v`, `branch --list`,
/// `worktree list`, `submodule status`) must not take a change made meanwhile for the IDE's own.
fn writes_settings(args: &[&str]) -> bool {
    let Some(sub) = subcommand(args) else {
        return false;
    };
    let rest: Vec<&str> = args
        .iter()
        .skip_while(|a| **a != sub)
        .skip(1)
        .copied()
        .collect();
    let first_word = rest.iter().find(|a| !a.starts_with('-')).copied();
    match sub {
        "push" | "checkout" | "switch" | "init" | "clone" => true,
        "config" => !reads_config(args),
        "remote" => matches!(
            first_word,
            Some(
                "add"
                    | "rename"
                    | "remove"
                    | "rm"
                    | "set-head"
                    | "set-branches"
                    | "set-url"
                    | "prune"
                    | "update"
            )
        ),
        "worktree" => matches!(
            first_word,
            Some("add" | "remove" | "move" | "prune" | "repair" | "lock" | "unlock")
        ),
        "submodule" => !matches!(first_word, None | Some("status" | "summary")),
        "lfs" => matches!(
            first_word,
            Some("install" | "uninstall" | "track" | "untrack" | "update")
        ),
        // A listing has a listing option or no name; anything else creates, moves, deletes or
        // sets an upstream.
        "branch" => {
            let lists = rest.iter().any(|a| {
                matches!(
                    *a,
                    "--list"
                        | "-l"
                        | "--show-current"
                        | "-a"
                        | "--all"
                        | "-r"
                        | "--remotes"
                        | "--contains"
                        | "--no-contains"
                        | "--merged"
                        | "--no-merged"
                        | "--points-at"
                ) || a.starts_with("--format")
            });
            let writes_flag = rest.iter().any(|a| {
                matches!(
                    *a,
                    "-u" | "--unset-upstream"
                        | "-m"
                        | "-M"
                        | "--move"
                        | "-c"
                        | "-C"
                        | "--copy"
                        | "-d"
                        | "-D"
                        | "--delete"
                        | "-t"
                        | "--track"
                        | "--edit-description"
                ) || a.starts_with("--set-upstream-to")
            });
            writes_flag || (!lists && first_word.is_some())
        }
        _ => false,
    }
}

/// `git config` that only reads.
fn reads_config(args: &[&str]) -> bool {
    args.iter().any(|a| {
        matches!(
            *a,
            "--get"
                | "--get-all"
                | "--get-regexp"
                | "--get-urlmatch"
                | "--list"
                | "-l"
                | "get"
                | "list"
        )
    })
}

/// The subcommand in git's arguments (after `-c name=value` and other options).
fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match *a {
            "-c" | "-C" | "--git-dir" | "--work-tree" | "--namespace" | "--config-env" => {
                it.next();
            }
            s if s.starts_with('-') => {}
            s => return Some(s),
        }
    }
    None
}

/// After the IDE's own git ran `args` in `dir` (and the check let it run): what it changed is
/// the record.
pub fn settle(dir: &Path, args: &[&str]) {
    if with(|g| g.prints.is_empty() && g.armed.is_empty()) {
        return;
    }
    if !writes_settings(args) {
        return;
    }
    let Some(top) = repo_top(dir) else { return };
    let k = key(&top);
    // A repository the IDE itself just made (Initialize repository) inside a folder a sandboxed
    // command ran in is recorded as it is: otherwise its newer settings paused the user's own new
    // repository (D407). Only there: recording one no sandboxed command came near made every
    // later change from a terminal (a branch, a remote) pause it.
    let made = matches!(subcommand(args), Some("init" | "clone"))
        && with(|g| g.armed.iter().any(|(f, _)| holds(f, &k) || holds(&k, f)));
    if !made && !with(|g| g.prints.contains_key(&k)) {
        return;
    }
    let print = print_of(&top);
    with(|g| {
        if g.prints.get(&k) != Some(&print) {
            g.prints.insert(k, print);
            save(g);
        }
    });
}

/// After an IDE action that changes the repository's settings outside `git::run` (the GitHub
/// CLI's repo create, PR checkout, merge): what it left is the record, where one is kept.
pub fn record(dir: &Path) {
    let Some(top) = repo_top(dir) else { return };
    let k = key(&top);
    if !with(|g| g.prints.contains_key(&k)) {
        return;
    }
    let print = print_of(&top);
    with(|g| {
        g.prints.insert(k, print);
        save(g);
    });
}

/// The user accepts the repository's settings as they are now.
pub fn trust(dir: &Path) -> Result<()> {
    let top = repo_top(dir).ok_or_else(|| Error::Invalid("not a git repository".into()))?;
    let k = key(&top);
    let print = print_of(&top);
    with(|g| {
        g.prints.insert(k, print);
        save(g);
    });
    Ok(())
}

/// Forgets everything (tests).
#[cfg(test)]
fn reset() {
    with(|g| *g = Guard::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test: the guard is process-wide state.
    #[test]
    fn git_pauses_after_a_sandboxed_command_changed_its_settings_until_trusted() {
        reset();
        let base = std::env::temp_dir().join(format!("ide-git-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let work = base.join("work");
        let git = work.join(".git");
        std::fs::create_dir_all(git.join("hooks")).unwrap();
        std::fs::create_dir_all(work.join("src")).unwrap();
        std::fs::write(git.join("config"), "[core]\n").unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        init(&data);

        // Nothing ran sandboxed: no check at all.
        assert!(check(&work).is_ok());
        arm(std::slice::from_ref(&work));
        assert!(data.join(FILE_NAME).is_file());
        assert!(check(&work.join("src")).is_ok());

        // A sandboxed command adds a setting: git pauses, naming the file.
        std::fs::write(git.join("config"), "[core]\n\tfsmonitor = x\n").unwrap();
        let err = check(&work).unwrap_err();
        assert!(matches!(err, Error::GitSettingsChanged(_)));
        assert!(err.to_string().contains(".git/config"), "{err}");
        // A later sandboxed command doesn't take the change over.
        arm(std::slice::from_ref(&work));
        assert!(check(&work).is_err());
        // Nor do the IDE's other git commands (a change made while they ran isn't theirs).
        settle(&work, &["status", "--porcelain"]);
        settle(&work, &["stash", "list"]);
        settle(&work, &["config", "--get", "user.name"]);
        assert!(check(&work).is_err());
        // The user trusts it.
        trust(&work).unwrap();
        assert!(check(&work).is_ok());

        // A new hook pauses it too.
        std::fs::write(git.join("hooks").join("pre-commit"), "x").unwrap();
        let err = check(&work).unwrap_err();
        assert!(err.to_string().contains("hooks/pre-commit"), "{err}");
        trust(&work).unwrap();

        // The IDE's own `git remote add` is its own change.
        std::fs::write(git.join("config"), "[remote \"origin\"]\n").unwrap();
        settle(&work, &["-c", "x=y", "remote", "add", "origin", "u"]);
        assert!(check(&work).is_ok());

        // A repository made under the folder afterwards, with settings newer than the first
        // sandboxed command: paused until trusted.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let nested = work.join("src").join("lib");
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        std::fs::write(nested.join(".git").join("config"), "[core]\n").unwrap();
        assert!(check(&nested).is_err());
        trust(&nested).unwrap();
        assert!(check(&nested).is_ok());

        // A restart keeps the record: a change made before it is still caught...
        std::fs::write(git.join("config"), "[core]\n\tsshCommand = x\n").unwrap();
        reset();
        init(&data);
        assert!(check(&work).is_err());
        // ...and a record that matches is dropped (no sandboxed process outlived the session).
        trust(&work).unwrap();
        reset();
        init(&data);
        assert!(check(&work).is_ok());
        assert!(with(|g| !g.prints.contains_key(&key(&work))));

        reset();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_subcommand_is_found_after_options() {
        assert_eq!(subcommand(&["-c", "a=b", "status"]), Some("status"));
        assert_eq!(subcommand(&["--no-pager", "remote", "add"]), Some("remote"));
        assert_eq!(subcommand(&["-C", "x", "push", "-u"]), Some("push"));
        assert_eq!(subcommand(&["--version"]), None);
    }

    #[test]
    fn a_repository_no_sandboxed_command_came_near_is_never_paused() {
        reset();
        let base = std::env::temp_dir().join(format!("ide-git-guard-init-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let git = base.join(".git");
        std::fs::create_dir_all(git.join("hooks")).unwrap();
        std::fs::write(git.join("config"), "[core]\n").unwrap();
        // The IDE's Initialize repository, nothing armed: nothing is recorded (D407).
        settle(&base, &["init"]);
        // A branch or remote made from a terminal later doesn't pause it.
        std::fs::write(git.join("config"), "[core]\n[remote \"origin\"]\n").unwrap();
        assert!(check(&base).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_writing_forms_settle() {
        // Writes (D407).
        for args in [
            &["remote", "add", "origin", "u"][..],
            &["-c", "x=y", "remote", "set-url", "origin", "u"],
            &["push", "-u", "origin", "main"],
            &["branch", "-u", "origin/main"],
            &["branch", "--set-upstream-to=origin/main"],
            &["branch", "new-feature"],
            &["branch", "-D", "old"],
            &["worktree", "add", "../w", "b"],
            &["submodule", "update", "--init"],
            &["config", "user.name", "T"],
            &["lfs", "install"],
            &["init"],
        ] {
            assert!(writes_settings(args), "{args:?}");
        }
        // Listings a refresh runs.
        for args in [
            &["remote"][..],
            &["remote", "-v"],
            &["branch"],
            &["branch", "--list", "-v"],
            &["branch", "-a", "--format=%(refname)"],
            &["branch", "--show-current"],
            &["worktree", "list", "--porcelain"],
            &["submodule", "status", "--recursive"],
            &["submodule"],
            &["config", "--get", "user.name"],
            &["status", "--porcelain"],
            &["lfs", "ls-files"],
        ] {
            assert!(!writes_settings(args), "{args:?}");
        }
    }
}
