//! The git command lines the IDE ran (VS Code's Git output lists them): every `run` call's
//! arguments, how long it took and how it failed, kept in memory (the last `MAX_KEPT`) for the
//! frontend's Git output channel to fetch (`log_git_commands`). Redacted when read.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// Records kept between two fetches (status refreshes run several git calls each).
const MAX_KEPT: usize = 1000;
/// One argument's most characters (a long path list stays readable).
const MAX_ARG: usize = 2000;
/// An error's most characters.
const MAX_ERROR: usize = 500;
/// Arguments kept per call (`git add -- <thousands of paths>`): then "… N more".
const MAX_ARGS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCall {
    /// Increasing, from 1: the frontend asks for what came after the last one it has.
    pub seq: u64,
    /// The arguments after `git` (without the fixed `-c core.quotepath=false -c color.ui=false`).
    pub args: Vec<String>,
    pub ms: u64,
    /// git's error (its stderr's start), or None when it succeeded.
    pub error: Option<String>,
}

struct Journal {
    next: u64,
    calls: VecDeque<GitCall>,
}

static JOURNAL: Mutex<Journal> = Mutex::new(Journal {
    next: 1,
    calls: VecDeque::new(),
});

fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{} …", &text[..at]),
        None => text.to_string(),
    }
}

/// Records one git run.
pub fn record(args: &[&str], took: Duration, error: Option<&str>) {
    let Ok(mut j) = JOURNAL.lock() else { return };
    let seq = j.next;
    j.next += 1;
    if j.calls.len() >= MAX_KEPT {
        j.calls.pop_front();
    }
    j.calls.push_back(GitCall {
        seq,
        args: {
            let mut kept: Vec<String> = args
                .iter()
                .take(MAX_ARGS)
                .map(|a| clip(a, MAX_ARG))
                .collect();
            if args.len() > MAX_ARGS {
                kept.push(format!("… {} more", args.len() - MAX_ARGS));
            }
            kept
        },
        ms: u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
        error: error.map(|e| clip(e.trim(), MAX_ERROR)),
    });
}

/// The calls after `after` (oldest first), redacted (`home` becomes `~`).
pub fn since(after: u64, home: Option<&str>) -> Vec<GitCall> {
    let picked: Vec<GitCall> = match JOURNAL.lock() {
        Ok(j) => j.calls.iter().filter(|c| c.seq > after).cloned().collect(),
        Err(_) => return Vec::new(),
    };
    let redact = |t: &str| crate::diagnostics::redact::redact(t, home);
    picked
        .into_iter()
        .map(|c| GitCall {
            args: c.args.iter().map(|a| redact(a)).collect(),
            error: c.error.as_deref().map(redact),
            ..c
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_are_kept_in_order_clipped_and_redacted() {
        let start = since(0, None).last().map_or(0, |c| c.seq);
        record(&["status", "-z"], Duration::from_millis(12), None);
        let long = "x".repeat(MAX_ARG + 10);
        record(
            &["push", "https://me:secret@example.com/r.git", &long],
            Duration::from_millis(3),
            Some("fatal: no\n"),
        );
        let got: Vec<GitCall> = since(start, None)
            .into_iter()
            .filter(|c| c.args.first().is_some_and(|a| a == "status" || a == "push"))
            .collect();
        assert!(got.len() >= 2);
        let push = got.iter().find(|c| c.args[0] == "push").cloned().unwrap();
        assert!(!push.args[1].contains("secret"));
        assert!(push.args[2].chars().count() <= MAX_ARG + 2);
        assert_eq!(push.error.as_deref(), Some("fatal: no"));
        assert!(since(push.seq, None).iter().all(|c| c.seq > push.seq));
    }
}
