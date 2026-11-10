//! GitHub pull requests, issues and publishing through the user's `gh` CLI (D139, D148), like git itself: no token
//! handling in the IDE, the user's `gh auth login` is used. Fixed operations only; free text
//! (titles, bodies) goes in `--flag=value` form so it can never be read as an option. Prompts are
//! off (`GH_PROMPT_DISABLED`), so nothing waits for input. JSON results are returned as gh prints
//! them and parsed by the frontend.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhArgs {
    pub number: Option<u32>,
    pub state: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub base: Option<String>,
    pub draft: Option<bool>,
    /// merge, squash or rebase (prMerge).
    pub method: Option<String>,
    /// A repository's name, `name` or `owner/name` (repoCreate).
    pub name: Option<String>,
    /// private or public (repoCreate).
    pub visibility: Option<String>,
    /// A file in the repository, `/` separated (fileAt, prComment).
    pub path: Option<String>,
    /// A commit hash (fileAt, compareBase, prComment).
    pub rev: Option<String>,
    /// Another commit hash (compareBase: the head).
    pub head: Option<String>,
    /// A GraphQL node id (prResolve: the review thread) or notification thread id.
    pub thread: Option<String>,
    /// A review comment's numeric id (prReply).
    pub comment: Option<u64>,
    /// A 1-based line (prComment).
    pub line: Option<u32>,
    /// notifications: read ones too.
    pub all: Option<bool>,
    /// prResolve: false unresolves.
    pub resolved: Option<bool>,
}

/// GitHub ops (D204) that don't need a repository: they run anywhere.
pub fn runs_anywhere(op: &str) -> bool {
    matches!(
        op,
        "authStatus" | "notifications" | "notificationRead" | "notificationsReadAll"
    )
}

fn hex(value: Option<&str>, what: &str) -> Result<String> {
    match value {
        Some(v) if (7..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(v.to_string())
        }
        _ => Err(Error::Invalid(format!("{what} must be a commit hash"))),
    }
}

/// A repository path for a URL: no `..`, no leading `-` or `/`, each part percent-encoded.
fn url_path(path: Option<&str>) -> Result<String> {
    let p = path.unwrap_or("").trim();
    if p.is_empty()
        || p.starts_with(['/', '-'])
        || p.split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(Error::Invalid(format!("not a repository path: {p}")));
    }
    let enc = |part: &str| {
        part.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>()
    };
    Ok(p.split('/').map(enc).collect::<Vec<_>>().join("/"))
}

/// A GraphQL node id or notification thread id: letters, digits, `_`, `-`, `=`.
fn node_id(value: Option<&str>) -> Result<String> {
    match value {
        Some(v)
            if !v.is_empty()
                && v.len() <= 200
                && !v.starts_with('-')
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'=')) =>
        {
            Ok(v.to_string())
        }
        _ => Err(Error::Invalid("not a GitHub id".into())),
    }
}

const THREADS_QUERY: &str = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine startLine diffSide comments(first:50){nodes{databaseId body createdAt url author{login}}}}}}}}";
const RESOLVE_MUTATION: &str =
    "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}";
const UNRESOLVE_MUTATION: &str =
    "mutation($thread:ID!){unresolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}";

/// A repository name GitHub accepts (and that can't be read as an option): `name` or
/// `owner/name`, letters, digits, `.`, `-`, `_`.
fn valid_repo_name(name: &str) -> bool {
    let ok = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    match name.split_once('/') {
        Some((owner, repo)) => ok(owner) && ok(repo) && !repo.contains('/'),
        None => ok(name),
    }
}

const PR_FIELDS: &str =
    "number,title,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision";
const PR_DETAIL_FIELDS: &str = "number,title,body,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision,mergeable,additions,deletions,changedFiles,statusCheckRollup,comments,autoMergeRequest,mergeStateStatus";
const ISSUE_FIELDS: &str = "number,title,author,labels,state,url,updatedAt";

/// The argument list for `op` (pure, so it is tested without gh).
pub fn args_for(op: &str, a: &GhArgs) -> Result<Vec<String>> {
    let state = match a.state.as_deref().unwrap_or("open") {
        s @ ("open" | "closed" | "merged" | "all") => s,
        other => return Err(Error::Invalid(format!("unknown state {other}"))),
    };
    let number = || {
        a.number
            .map(|n| n.to_string())
            .ok_or_else(|| Error::Invalid("the pull request number is missing".into()))
    };
    let mut args: Vec<String> = match op {
        "authStatus" => vec!["auth".into(), "status".into()],
        "prList" => vec![
            "pr".into(),
            "list".into(),
            format!("--state={state}"),
            "--limit=100".into(),
            format!("--json={PR_FIELDS}"),
        ],
        "prView" => {
            let mut v = vec!["pr".into(), "view".into()];
            if let Some(n) = a.number {
                v.push(n.to_string());
            }
            v.push(format!("--json={PR_DETAIL_FIELDS}"));
            v
        }
        "prCheckout" => vec!["pr".into(), "checkout".into(), number()?],
        "prCreate" => {
            let title = a.title.as_deref().unwrap_or("").trim();
            if title.is_empty() {
                return Err(Error::Invalid("the pull request needs a title".into()));
            }
            let mut v = vec![
                "pr".into(),
                "create".into(),
                format!("--title={title}"),
                format!("--body={}", a.body.as_deref().unwrap_or("")),
            ];
            if let Some(base) = a.base.as_deref().filter(|b| !b.is_empty()) {
                v.push(format!("--base={base}"));
            }
            if a.draft == Some(true) {
                v.push("--draft".into());
            }
            v
        }
        "prMerge" => {
            let method = match a.method.as_deref().unwrap_or("merge") {
                m @ ("merge" | "squash" | "rebase") => m,
                other => return Err(Error::Invalid(format!("unknown merge method {other}"))),
            };
            vec![
                "pr".into(),
                "merge".into(),
                number()?,
                format!("--{method}"),
            ]
        }
        // D352: GitHub merges it once its requirements are met (auto-merge), or stops doing so.
        "prAutoMerge" => {
            let method = match a.method.as_deref().unwrap_or("merge") {
                m @ ("merge" | "squash" | "rebase") => m,
                other => return Err(Error::Invalid(format!("unknown merge method {other}"))),
            };
            vec![
                "pr".into(),
                "merge".into(),
                number()?,
                "--auto".into(),
                format!("--{method}"),
            ]
        }
        "prAutoMergeOff" => vec![
            "pr".into(),
            "merge".into(),
            number()?,
            "--disable-auto".into(),
        ],
        // D352: whether the repository allows auto-merge.
        "repoAutoMerge" => vec![
            "repo".into(),
            "view".into(),
            "--json=autoMergeAllowed".into(),
        ],
        // Publish (D148): a new GitHub repository from this one, as `origin`, pushed.
        "repoCreate" => {
            let name = a.name.as_deref().unwrap_or("").trim();
            if !valid_repo_name(name) {
                return Err(Error::Invalid(format!(
                    "\"{name}\" isn't a valid repository name (letters, digits, . - _)"
                )));
            }
            let visibility = match a.visibility.as_deref().unwrap_or("private") {
                v @ ("private" | "public") => v,
                other => return Err(Error::Invalid(format!("unknown visibility {other}"))),
            };
            let mut v = vec![
                "repo".into(),
                "create".into(),
                name.to_string(),
                format!("--{visibility}"),
                "--source=.".into(),
                "--remote=origin".into(),
                "--push".into(),
            ];
            if let Some(d) = a.body.as_deref().filter(|d| !d.trim().is_empty()) {
                v.push(format!("--description={d}"));
            }
            v
        }
        "issueList" => vec![
            "issue".into(),
            "list".into(),
            format!(
                "--state={}",
                if state == "merged" { "closed" } else { state }
            ),
            "--limit=100".into(),
            format!("--json={ISSUE_FIELDS}"),
        ],
        // ---- Pull request review (D204): files, contents, review threads, replies ----
        "prMeta" => vec![
            "pr".into(),
            "view".into(),
            number()?,
            "--json=number,title,url,headRefName,baseRefName,headRefOid,baseRefOid,state".into(),
        ],
        "prFiles" => vec![
            "api".into(),
            format!(
                "repos/{{owner}}/{{repo}}/pulls/{}/files?per_page=100",
                number()?
            ),
        ],
        "compareBase" => vec![
            "api".into(),
            format!(
                "repos/{{owner}}/{{repo}}/compare/{}...{}",
                hex(a.rev.as_deref(), "the base")?,
                hex(a.head.as_deref(), "the head")?
            ),
            "--jq=.merge_base_commit.sha".into(),
        ],
        "fileAt" => vec![
            "api".into(),
            format!(
                "repos/{{owner}}/{{repo}}/contents/{}?ref={}",
                url_path(a.path.as_deref())?,
                hex(a.rev.as_deref(), "the commit")?
            ),
            "-H".into(),
            "Accept: application/vnd.github.raw".into(),
        ],
        "prThreads" => vec![
            "api".into(),
            "graphql".into(),
            "-F".into(),
            "owner={owner}".into(),
            "-F".into(),
            "repo={repo}".into(),
            "-F".into(),
            format!("number={}", number()?),
            "-f".into(),
            format!("query={THREADS_QUERY}"),
        ],
        "prReply" => {
            let body = a.body.as_deref().unwrap_or("").trim();
            if body.is_empty() {
                return Err(Error::Invalid("the reply is empty".into()));
            }
            let comment = a
                .comment
                .ok_or_else(|| Error::Invalid("the comment to reply to is missing".into()))?;
            vec![
                "api".into(),
                format!(
                    "repos/{{owner}}/{{repo}}/pulls/{}/comments/{comment}/replies",
                    number()?
                ),
                "-f".into(),
                format!("body={body}"),
            ]
        }
        "prComment" => {
            let body = a.body.as_deref().unwrap_or("").trim();
            if body.is_empty() {
                return Err(Error::Invalid("the comment is empty".into()));
            }
            let line = a
                .line
                .filter(|l| *l > 0)
                .ok_or_else(|| Error::Invalid("the line is missing".into()))?;
            let path = a.path.as_deref().unwrap_or("");
            url_path(Some(path))?;
            vec![
                "api".into(),
                format!("repos/{{owner}}/{{repo}}/pulls/{}/comments", number()?),
                "-f".into(),
                format!("body={body}"),
                "-f".into(),
                format!("commit_id={}", hex(a.rev.as_deref(), "the commit")?),
                "-f".into(),
                format!("path={path}"),
                "-F".into(),
                format!("line={line}"),
                "-f".into(),
                "side=RIGHT".into(),
            ]
        }
        "prResolve" => vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            format!("thread={}", node_id(a.thread.as_deref())?),
            "-f".into(),
            format!(
                "query={}",
                if a.resolved == Some(false) {
                    UNRESOLVE_MUTATION
                } else {
                    RESOLVE_MUTATION
                }
            ),
        ],
        // ---- Notifications (D204) ----
        "notifications" => vec![
            "api".into(),
            format!(
                "notifications?per_page=50&all={}",
                if a.all == Some(true) { "true" } else { "false" }
            ),
        ],
        "notificationRead" => vec![
            "api".into(),
            "-X".into(),
            "PATCH".into(),
            format!("notifications/threads/{}", node_id(a.thread.as_deref())?),
        ],
        "notificationsReadAll" => vec![
            "api".into(),
            "-X".into(),
            "PUT".into(),
            "notifications".into(),
            "-F".into(),
            "read=true".into(),
        ],
        _ => return Err(Error::Invalid(format!("unknown GitHub operation {op}"))),
    };
    args.shrink_to_fit();
    Ok(args)
}

/// Where `gh` is. An app started from the macOS Dock or a Linux launcher has a short PATH that
/// misses Homebrew and similar folders, so the user's login shell is asked, then the usual
/// install folders. Remembered once found.
fn gh_program() -> PathBuf {
    // The answer (also "not found", as plain `gh`) is kept for the process lifetime: probing
    // spawns a login shell and several `gh --version`s, too slow to repeat on every call.
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    FOUND.get_or_init(find_gh).clone()
}

fn find_gh() -> PathBuf {
    let works = |p: &Path| {
        let mut cmd = Command::new(p);
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            // No console window flashing up for the probe.
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.status().is_ok_and(|s| s.success())
    };
    let mut candidates = vec![PathBuf::from("gh")];
    // Windows: the first PATH folder with gh + a PATHEXT extension, as a command prompt finds it
    // (Rust's own search only tries gh.exe, so a `gh.cmd` earlier on PATH, such as a wrapper or
    // the tests' offline stand-in, was passed over for the real one).
    #[cfg(windows)]
    {
        let pathext = std::env::var("PATHEXT").unwrap_or_default();
        if let Some(found) = crate::pty::windows_program(
            "gh",
            &crate::pty::profiles::path_dirs(),
            &pathext,
            &|p: &Path| p.is_file(),
        ) {
            candidates.insert(0, found);
        }
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        // The login shell runs the user's profile, which can be slow or wait for input: bounded.
        if let Some((_, stdout)) = crate::exec::output_within(
            Command::new(shell)
                .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
                .args(["-lc", "command -v gh"]),
            std::time::Duration::from_secs(3),
        ) {
            let path = String::from_utf8_lossy(&stdout).trim().to_string();
            if !path.is_empty() {
                candidates.push(PathBuf::from(path));
            }
        }
        candidates.extend(
            [
                "/opt/homebrew/bin/gh",
                "/usr/local/bin/gh",
                "/home/linuxbrew/.linuxbrew/bin/gh",
            ]
            .map(PathBuf::from),
        );
    }
    candidates
        .into_iter()
        .find(|p| works(p))
        .unwrap_or_else(|| PathBuf::from("gh"))
}

/// Runs `gh` for `op` in the repository; stdout on success.
pub fn run(repo: &Path, op: &str, a: &GhArgs) -> Result<String> {
    let args = args_for(op, a)?;
    // gh runs git in the repository (status, fetch, checkout, push): not while its settings are
    // paused (D407). Signing in has nothing to do with the folder.
    let local = op != "authStatus"
        && crate::remote::of_dir(repo).is_none()
        && crate::wsl::of_dir(repo).is_none();
    if local {
        super::guard::check(repo)?;
    }
    let result = run_unchecked(repo, &args);
    // The ones that change its settings themselves: their remote, upstream or branches are the
    // record, not a pause.
    if local && matches!(op, "repoCreate" | "prCheckout" | "prMerge" | "prCreate") {
        super::guard::record(repo);
    }
    result
}

fn run_unchecked(repo: &Path, args: &[String]) -> Result<String> {
    let mut cmd = Command::new(gh_program());
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    cmd.current_dir(repo)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::Invalid(
                "The GitHub CLI (gh) isn't installed. Install it from https://cli.github.com, then run `gh auth login` in a terminal.".into(),
            )
        } else {
            Error::Io(e)
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        // `gh auth status` reports on stderr.
        Ok(if stdout.trim().is_empty() {
            stderr
        } else {
            stdout
        })
    } else if stderr.contains("gh auth login") || stderr.contains("not logged") {
        Err(Error::Git(
            "GitHub CLI isn't signed in. Run `gh auth login` in a terminal, then try again.".into(),
        ))
    } else {
        Err(Error::Git(if stderr.is_empty() {
            format!("gh {} failed", args.join(" "))
        } else {
            stderr
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_text_is_passed_as_flag_values() {
        let a = GhArgs {
            title: Some("--delete everything".into()),
            body: Some("-x".into()),
            base: Some("main".into()),
            draft: Some(true),
            ..Default::default()
        };
        let args = args_for("prCreate", &a).unwrap();
        assert!(args.contains(&"--title=--delete everything".to_string()));
        assert!(args.contains(&"--body=-x".to_string()));
        assert!(args.contains(&"--base=main".to_string()));
        assert!(args.contains(&"--draft".to_string()));
    }

    #[test]
    fn repo_create_checks_its_name() {
        let a = |name: &str| GhArgs {
            name: Some(name.into()),
            visibility: Some("public".into()),
            ..Default::default()
        };
        assert_eq!(
            args_for("repoCreate", &a("my-app")).unwrap(),
            vec![
                "repo",
                "create",
                "my-app",
                "--public",
                "--source=.",
                "--remote=origin",
                "--push"
            ]
        );
        assert!(args_for("repoCreate", &a("me/my.app")).is_ok());
        for bad in ["", "-x", "a b", "a/b/c", "..", "x;y"] {
            assert!(args_for("repoCreate", &a(bad)).is_err(), "{bad}");
        }
        let hidden = GhArgs {
            name: Some("x".into()),
            visibility: Some("secret".into()),
            ..Default::default()
        };
        assert!(args_for("repoCreate", &hidden).is_err());
    }

    #[test]
    fn review_and_notification_ops_check_their_values() {
        let n = |number: u32| GhArgs {
            number: Some(number),
            ..Default::default()
        };
        assert_eq!(
            args_for("prFiles", &n(7)).unwrap(),
            vec!["api", "repos/{owner}/{repo}/pulls/7/files?per_page=100"]
        );
        let file = GhArgs {
            path: Some("src/a b.ts".into()),
            rev: Some("abc1234".into()),
            ..Default::default()
        };
        assert_eq!(
            args_for("fileAt", &file).unwrap()[1],
            "repos/{owner}/{repo}/contents/src/a%20b.ts?ref=abc1234"
        );
        for bad in ["../x", "-x", "/etc/passwd", "a//b"] {
            let a = GhArgs {
                path: Some(bad.into()),
                rev: Some("abc1234".into()),
                ..Default::default()
            };
            assert!(args_for("fileAt", &a).is_err(), "{bad}");
        }
        let no_hash = GhArgs {
            path: Some("a".into()),
            rev: Some("main".into()),
            ..Default::default()
        };
        assert!(args_for("fileAt", &no_hash).is_err());
        let reply = GhArgs {
            number: Some(3),
            comment: Some(99),
            body: Some("--no".into()),
            ..Default::default()
        };
        let args = args_for("prReply", &reply).unwrap();
        assert!(args.contains(&"body=--no".to_string()));
        assert!(args[1].ends_with("/pulls/3/comments/99/replies"));
        let resolve = |thread: &str| GhArgs {
            thread: Some(thread.into()),
            ..Default::default()
        };
        assert!(args_for("prResolve", &resolve("PRRT_kwDOabc-1=")).is_ok());
        assert!(args_for("prResolve", &resolve("x;y")).is_err());
        assert!(args_for("notificationRead", &resolve("123")).is_ok());
        assert!(args_for("notificationRead", &resolve("../x")).is_err());
        assert!(runs_anywhere("notifications") && !runs_anywhere("prFiles"));
    }

    #[test]
    fn unknown_values_are_refused() {
        assert!(args_for(
            "prList",
            &GhArgs {
                state: Some("weird".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(args_for("prCheckout", &GhArgs::default()).is_err());
        assert!(args_for("repoDelete", &GhArgs::default()).is_err());
        let merge = GhArgs {
            number: Some(4),
            method: Some("squash".into()),
            ..Default::default()
        };
        assert_eq!(
            args_for("prMerge", &merge).unwrap(),
            vec!["pr", "merge", "4", "--squash"]
        );
        assert_eq!(
            args_for("prAutoMerge", &merge).unwrap(),
            vec!["pr", "merge", "4", "--auto", "--squash"]
        );
        assert_eq!(
            args_for("prAutoMergeOff", &merge).unwrap(),
            vec!["pr", "merge", "4", "--disable-auto"]
        );
        assert!(args_for("prAutoMerge", &GhArgs::default()).is_err());
        assert!(args_for(
            "prAutoMerge",
            &GhArgs {
                number: Some(4),
                method: Some("--admin".into()),
                ..Default::default()
            }
        )
        .is_err());
    }
}
