//! What a sandboxed command may not write even inside its writable folders (D392), as Claude
//! Code's sandbox does: git's configuration and hooks, and the agents' and the IDE's own
//! configuration folders. Git runs programs its configuration names (core.fsmonitor on every
//! `git status`, hooks on commit, sshCommand on fetch) and the IDE's own git runs outside the
//! sandbox; a project's agent settings decide what later runs without asking. A command that
//! could write them would get out of the sandbox the next time the IDE refreshes.
//!
//! - macOS: `deny file-write*` rules after the writable folders' `allow` (the later rule wins),
//!   for these paths at any depth, whatever their case (APFS ignores it).
//! - Linux: bubblewrap binds the ones that exist read-only, and the repository's `.git` onto
//!   itself (a mount point can't be renamed or removed, so it can't be swapped for another).
//! - Windows: low integrity can't hold a file inside a writable folder (a low-labelled parent
//!   lets it be deleted and made again), so the IDE's own git checks instead (`git::guard`).
//!
//! What the command can still do: git commits, branches, fetches into objects and refs, and
//! `git init` or a clone (their settings are then refused: the IDE's git asks first).

use std::path::{Path, PathBuf};

/// The configuration folders protected in every writable folder (besides the IDE's own, which
/// the webview names from product.json): Claude Code's, Codex's, Cursor's.
const AGENT_FOLDERS: &[&str] = &[".claude", ".codex", ".cursor"];
/// Files protected in every writable folder: the project's MCP server list.
const AGENT_FILES: &[&str] = &[".mcp.json"];
/// What in a git folder runs programs or points git elsewhere.
const GIT_FILES: &[&str] = &["config", "config.worktree", "commondir"];

/// The configuration folders a policy may name: one plain name starting with a dot.
pub fn clean_folder_names(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = AGENT_FOLDERS.iter().map(|s| s.to_string()).collect();
    for name in raw {
        let n = name.trim();
        let plain = n.len() > 1
            && n.starts_with('.')
            && n != ".."
            && !n.contains(['/', '\\', ':', '"', '\0']);
        if plain && !out.iter().any(|o| o.eq_ignore_ascii_case(n)) {
            out.push(n.to_string());
        }
    }
    out
}

/// Whether `dir` is a git folder itself (a worktree's common folder, writable on its own).
fn is_git_dir(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && dir.join("objects").is_dir()
}

/// A regular expression matching `text` whatever its case (seatbelt's has no flag for it).
fn any_case(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphabetic() {
            out.push('[');
            out.push(c.to_ascii_lowercase());
            out.push(c.to_ascii_uppercase());
            out.push(']');
        } else {
            out.push_str(&regex_escape(&c.to_string()));
        }
    }
    out
}

fn regex_escape(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The patterns (after a folder's escaped path) for what a git folder holds.
fn git_dir_tail() -> String {
    let files = GIT_FILES
        .iter()
        .map(|f| any_case(f))
        .collect::<Vec<_>>()
        .join("|");
    let hooks = any_case("hooks");
    let modules = any_case("modules");
    let worktrees = any_case("worktrees");
    // config, hooks…; a submodule's (modules/<name>/…, names may hold slashes); a linked
    // worktree's own (worktrees/<name>/config.worktree, commondir).
    format!("({modules}/.+/|{worktrees}/[^/]+/)?({files}|{hooks}(/.*)?)$")
}

/// The macOS rules (after the profile's writable folders): writes refused to git's settings
/// and hooks in every repository under each folder, to the repository's `.git` itself (it
/// can't be renamed or swapped), and to the configuration folders. Paths canonical.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_rules(writable: &[PathBuf], folders: &[String]) -> String {
    let mut rules: Vec<String> = Vec::new();
    for dir in writable {
        let text = dir.to_string_lossy().trim_end_matches('/').to_string();
        // A raw string can't hold a quote: such a folder keeps the rest of the sandbox.
        if text.is_empty() || text.contains('"') {
            continue;
        }
        let base = regex_escape(&text);
        if is_git_dir(dir) {
            rules.push(format!("(regex #\"^{base}/{}\")", git_dir_tail()));
            continue;
        }
        let git = any_case(".git");
        rules.push(format!(
            "(regex #\"^{base}/(.*/)?{git}/{}\")",
            git_dir_tail()
        ));
        rules.push(format!("(regex #\"^{base}/{git}$\")"));
        for name in folders {
            rules.push(format!("(regex #\"^{base}/{}(/.*)?$\")", any_case(name)));
        }
        for name in AGENT_FILES {
            rules.push(format!("(regex #\"^{base}/{}$\")", any_case(name)));
        }
    }
    if rules.is_empty() {
        return String::new();
    }
    format!("(deny file-write*\n  {})\n", rules.join("\n  "))
}

/// bubblewrap's arguments (after the folders' binds): the repository's `.git` bound onto
/// itself, then what exists of git's settings and hooks and of the configuration folders
/// read-only. Only what exists: a bind would create the missing path in the user's folder.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn bwrap_args(writable: &[PathBuf], folders: &[String]) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let read_only = |p: &Path, args: &mut Vec<String>| {
        if p.exists() {
            let s = p.to_string_lossy().to_string();
            args.extend(["--ro-bind".to_string(), s.clone(), s]);
        }
    };
    for dir in writable {
        let git_dirs: Vec<PathBuf> = if is_git_dir(dir) {
            vec![dir.clone()]
        } else {
            let dot = dir.join(".git");
            if dot.is_dir() {
                let s = dot.to_string_lossy().to_string();
                args.extend(["--bind".to_string(), s.clone(), s]);
                vec![dot]
            } else {
                // A linked worktree's or a submodule's pointer to its git folder.
                read_only(&dot, &mut args);
                Vec::new()
            }
        };
        for git in &git_dirs {
            for f in GIT_FILES {
                read_only(&git.join(f), &mut args);
            }
            read_only(&git.join("hooks"), &mut args);
            for sub in ["modules", "worktrees"] {
                for inner in git_folders_under(&git.join(sub)) {
                    for f in GIT_FILES {
                        read_only(&inner.join(f), &mut args);
                    }
                    read_only(&inner.join("hooks"), &mut args);
                }
            }
        }
        for name in folders {
            read_only(&dir.join(name), &mut args);
        }
        for name in AGENT_FILES {
            read_only(&dir.join(name), &mut args);
        }
    }
    args
}

/// The git folders under `dir` (a submodule's may sit a few folders down: `modules/lib/x`,
/// or hold its own `modules`), a bounded walk.
pub(crate) fn git_folders_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut todo = vec![(dir.to_path_buf(), 0u32)];
    while let Some((at, depth)) = todo.pop() {
        if found.len() >= 200 || depth > 6 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if p.join("HEAD").is_file() && p.join("config").exists() {
                found.push(p.clone());
                let nested = p.join("modules");
                if nested.is_dir() {
                    todo.push((nested, depth + 1));
                }
            } else {
                todo.push((p, depth + 1));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_dot_names_are_protected_folders() {
        let names = clean_folder_names(&[
            ".ide".into(),
            ".vscode".into(),
            "../x".into(),
            "a/b".into(),
            "plain".into(),
            ".".into(),
            ".CLAUDE".into(),
        ]);
        assert_eq!(
            names,
            vec![".claude", ".codex", ".cursor", ".ide", ".vscode"]
        );
    }

    #[test]
    fn the_macos_rules_refuse_git_settings_at_any_depth_whatever_their_case() {
        let rules = macos_rules(&[PathBuf::from("/Users/me/my.app")], &[".ide".into()]);
        assert!(rules.starts_with("(deny file-write*\n"), "{rules}");
        let git = "\\.[gG][iI][tT]";
        assert!(
            rules.contains(&format!("(regex #\"^/Users/me/my\\.app/(.*/)?{git}/")),
            "{rules}"
        );
        assert!(rules.contains(&format!("(regex #\"^/Users/me/my\\.app/{git}$\")")));
        assert!(rules.contains("[cC][oO][nN][fF][iI][gG]"));
        assert!(rules.contains("[hH][oO][oO][kK][sS](/.*)?"));
        assert!(rules.contains("\\.[iI][dD][eE](/.*)?$"));
        assert!(rules.contains("\\.[mM][cC][pP]\\.[jJ][sS][oO][nN]$"));
        // A folder whose path holds a quote can't be written as a raw string: left out.
        assert_eq!(macos_rules(&[PathBuf::from("/a\"b")], &[]), "");
    }

    /// The patterns themselves (these use only what POSIX extended regexes, seatbelt's, have).
    #[test]
    fn the_git_pattern_matches_settings_and_hooks_but_not_objects_or_refs() {
        let tail = git_dir_tail();
        let re = regex::Regex::new(&format!("^{tail}")).unwrap();
        let matches = |rel: &str| re.is_match(rel);
        for hit in [
            "config",
            "CONFIG",
            "config.worktree",
            "commondir",
            "hooks",
            "hooks/pre-commit",
            "modules/lib/x/config",
            "modules/a/hooks/post-checkout",
            "worktrees/feature/config.worktree",
            "worktrees/feature/commondir",
        ] {
            assert!(matches(hit), "{hit} should be protected");
        }
        for miss in [
            "index",
            "HEAD",
            "objects/ab/cdef",
            "refs/heads/main",
            "logs/HEAD",
            "configs",
            "worktrees/feature/HEAD",
            "worktrees/a/b/config",
        ] {
            assert!(!matches(miss), "{miss} should stay writable");
        }
    }

    #[test]
    fn bwrap_binds_what_exists_of_git_settings_read_only_and_git_onto_itself() {
        let base = std::env::temp_dir().join(format!("ide-protect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let work = base.join("work");
        let git = work.join(".git");
        let sub = git.join("modules").join("lib").join("x");
        for d in [
            git.join("hooks"),
            git.join("objects"),
            sub.join("objects"),
            work.join(".claude"),
        ] {
            let _ = std::fs::create_dir_all(d);
        }
        for f in [
            git.join("config"),
            git.join("HEAD"),
            sub.join("config"),
            sub.join("HEAD"),
        ] {
            let _ = std::fs::write(f, "x");
        }
        let args = bwrap_args(
            std::slice::from_ref(&work),
            &clean_folder_names(&[".ide".into()]),
        );
        let s = |p: &Path| p.to_string_lossy().to_string();
        let pair = |flag: &str, p: &Path| {
            args.windows(3)
                .any(|w| w[0] == flag && w[1] == s(p) && w[2] == s(p))
        };
        assert!(pair("--bind", &git), "{args:?}");
        assert!(pair("--ro-bind", &git.join("config")), "{args:?}");
        assert!(pair("--ro-bind", &git.join("hooks")), "{args:?}");
        assert!(pair("--ro-bind", &sub.join("config")), "{args:?}");
        assert!(pair("--ro-bind", &work.join(".claude")), "{args:?}");
        // Missing ones aren't bound (bubblewrap would make them in the folder).
        assert!(!pair("--ro-bind", &git.join("config.worktree")), "{args:?}");
        assert!(!pair("--ro-bind", &work.join(".ide")), "{args:?}");
        // The .git bind comes before what's in it.
        let at = |flag: &str, p: &Path| {
            args.windows(3)
                .position(|w| w[0] == flag && w[1] == s(p))
                .unwrap_or(usize::MAX)
        };
        assert!(at("--bind", &git) < at("--ro-bind", &git.join("config")));
        // A worktree's common folder (writable on its own) gets its settings covered too.
        let args = bwrap_args(std::slice::from_ref(&git), &[]);
        assert!(args.contains(&s(&git.join("config"))), "{args:?}");
        assert!(!args.contains(&"--bind".to_string()), "{args:?}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
