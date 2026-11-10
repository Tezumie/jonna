//! Text search, as the app's `search` module (ripgrep's `grep-searcher` + `grep-regex`): the
//! folders are walked with the file index's ignore rules plus include/exclude globs, and each
//! matching file is one `SearchEvent`, then one `done`. The options and events are the app's
//! (`SearchOptions`, `SearchEvent`), so the JSON goes through the app unchanged.
//!
//! Searches are named by the app (`search`): one with the same name replaces the running one
//! (whose events stop at once); different names run side by side.
//!
//! A pattern that can match a line break (a regex with `\n`, or pasted text holding a newline)
//! searches in multi-line mode, like VS Code: each match is reported on the line it starts on,
//! its range running to the match's end or that line's end, whichever comes first.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::outbox::Outbox;

/// Lines longer than this are cut (minified files) so one match can't flood the UI.
const MAX_LINE_CHARS: usize = 300;
const DEFAULT_MAX_RESULTS: usize = 20_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Globs like `src/**`, `*.ts` (comma-separated in the UI).
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    pub max_results: Option<usize>,
    /// Honor .gitignore / .ignore files (VS Code's "Use exclude settings and ignore files").
    #[serde(default = "default_true")]
    pub use_ignore_files: bool,
    #[serde(default)]
    pub follow_symlinks: bool,
    // The app's replace options (`preserveCase`, `lines`) are ignored: unknown fields are, and
    // replacing is the app's own work over `fs.read` / `fs.write`.
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// UTF-16 [start, end) ranges within `text` (JS string indices).
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchEvent {
    #[serde(rename_all = "camelCase")]
    File {
        path: String,
        rel: String,
        matches: Vec<LineMatch>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        files: usize,
        matches: usize,
        truncated: bool,
        cancelled: bool,
        duration_ms: u64,
    },
}

/// A running search: `cancelled` stops it (it still reports `done`); `replaced` also silences
/// it, since a newer search now answers to its name.
#[derive(Default)]
struct Running {
    cancelled: AtomicBool,
    replaced: AtomicBool,
}

#[derive(Default, Clone)]
pub struct Searches {
    running: Arc<Mutex<HashMap<String, Arc<Running>>>>,
}

impl Searches {
    /// Starts search `id` over `roots` (canonical workspace folders, in order); its events go
    /// out as `search.event { search, event }`. Errors (an empty query, a bad pattern or glob)
    /// come back at once.
    pub fn start(
        &self,
        id: Value,
        roots: Vec<PathBuf>,
        opts: SearchOptions,
        out: Outbox,
    ) -> Result<()> {
        if opts.query.is_empty() {
            return Err(Error::Invalid("empty search".into()));
        }
        if roots.is_empty() {
            return Err(Error::NoWorkspace);
        }
        let matcher = matcher(&opts)?;
        // Every walker before the search starts: a bad glob is an error now, not a lost folder.
        let walkers = roots
            .into_iter()
            .map(|root| walker(&root, &opts).map(|w| (root, w)))
            .collect::<Result<Vec<_>>>()?;
        let key = id.to_string();
        let running = Arc::new(Running::default());
        if let Ok(mut map) = self.running.lock() {
            if let Some(old) = map.insert(key.clone(), running.clone()) {
                old.replaced.store(true, Ordering::Relaxed);
                old.cancelled.store(true, Ordering::Relaxed);
            }
        }
        let registry = self.running.clone();
        std::thread::spawn(move || {
            let this = running.clone();
            run(walkers, opts, matcher, &running.cancelled, |event| {
                if this.replaced.load(Ordering::Relaxed) {
                    return;
                }
                if let Ok(event) = serde_json::to_value(&event) {
                    out.notify("search.event", json!({ "search": id, "event": event }));
                }
            });
            if let Ok(mut map) = registry.lock() {
                if map.get(&key).is_some_and(|r| Arc::ptr_eq(r, &running)) {
                    map.remove(&key);
                }
            }
        });
        Ok(())
    }

    /// Stops search `id` (it reports `done` with `cancelled`). An unknown id is ignored.
    pub fn cancel(&self, id: &Value) {
        let running = self
            .running
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id.to_string()));
        if let Some(r) = running {
            r.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

/// The regex source for `opts` (escaped literal unless `is_regex`, `\b…\b` for whole words).
pub fn pattern(opts: &SearchOptions) -> String {
    let core = if opts.is_regex {
        opts.query.clone()
    } else {
        regex::escape(&opts.query)
    };
    if opts.whole_word {
        format!(r"\b(?:{core})\b")
    } else {
        core
    }
}

/// Whether the search must look across lines: the query holds a newline, or (a regex) a `\n`
/// escape that isn't an escaped backslash followed by "n" (`\\n`).
pub fn is_multi_line(opts: &SearchOptions) -> bool {
    if opts.query.contains('\n') {
        return true;
    }
    if !opts.is_regex {
        return false;
    }
    let mut chars = opts.query.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.next() == Some('n') {
            return true;
        }
    }
    false
}

/// `pattern` with each line break (a `\n` escape or a newline) outside a character class turned
/// into `\r?\n`, so a pattern written with `\n` also matches Windows line endings (as in VS Code).
pub fn crlf_tolerant(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut in_class = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('n') if !in_class => out.push_str(r"\r?\n"),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            },
            '\n' if !in_class => out.push_str(r"\r?\n"),
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                // A `]` right after `[` or `[^` is a member of the class, not its end.
                if chars.peek() == Some(&'^') {
                    out.push('^');
                    chars.next();
                }
                if chars.peek() == Some(&']') {
                    out.push(']');
                    chars.next();
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            _ => out.push(c),
        }
    }
    out
}

fn matcher(opts: &SearchOptions) -> Result<RegexMatcher> {
    let mut builder = RegexMatcherBuilder::new();
    builder.case_insensitive(!opts.match_case);
    let source = if is_multi_line(opts) {
        // No line terminator, so the matcher may match "\n"; `^` and `$` still mean a line's
        // start and end.
        builder.multi_line(true);
        crlf_tolerant(&pattern(opts))
    } else {
        builder.line_terminator(Some(b'\n'));
        pattern(opts)
    };
    builder
        .build(&source)
        .map_err(|e| Error::Invalid(format!("invalid search pattern: {e}")))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn walker(root: &Path, opts: &SearchOptions) -> Result<WalkBuilder> {
    let mut overrides = OverrideBuilder::new(root);
    let bad = |e: ignore::Error| Error::Invalid(format!("invalid glob: {e}"));
    for glob in opts.include.iter().filter(|g| !g.trim().is_empty()) {
        overrides
            .add(glob_for(root, glob.trim()).as_str())
            .map_err(bad)?;
    }
    for glob in opts.exclude.iter().filter(|g| !g.trim().is_empty()) {
        overrides
            .add(&format!("!{}", glob_for(root, glob.trim())))
            .map_err(bad)?;
    }
    let overrides = overrides.build().map_err(bad)?;
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(opts.use_ignore_files)
        .git_exclude(opts.use_ignore_files)
        .ignore(opts.use_ignore_files)
        .git_global(false)
        .require_git(false)
        .follow_links(opts.follow_symlinks)
        .overrides(overrides);
    if opts.follow_symlinks {
        // Following links lets the walker step outside the workspace (`link -> /`): prune every
        // entry whose real location isn't under the (canonical) root, folders included, so
        // nothing outside is read or even walked.
        let canonical_root = std::fs::canonicalize(root).ok();
        builder.filter_entry(move |e| {
            e.file_name() != ".git"
                && (e.depth() == 0 || inside_root(e.path(), canonical_root.as_deref()))
        });
    } else {
        builder.filter_entry(|e| e.file_name() != ".git");
    }
    Ok(builder)
}

/// A bare folder name ("src") means everything inside it, like VS Code's include box; the
/// workspace-relative path of an existing file means that one file ("Only open editors").
fn glob_for(root: &Path, glob: &str) -> String {
    if root.join(glob).is_file() {
        // An exact file (from "only open editors"): its name may hold glob characters
        // (`app/[id]/page.tsx`), so each one becomes a one-character class.
        let mut out = String::from("/");
        for c in glob.trim_start_matches('/').chars() {
            match c {
                '[' | ']' | '*' | '?' | '{' | '}' => {
                    out.push('[');
                    out.push(c);
                    out.push(']');
                }
                _ => out.push(c),
            }
        }
        out
    } else if glob.contains(['*', '?', '[', '{', '.']) {
        glob.to_string()
    } else {
        format!("{}/**", glob.trim_end_matches('/'))
    }
}

fn run<F: Fn(SearchEvent)>(
    walkers: Vec<(PathBuf, WalkBuilder)>,
    opts: SearchOptions,
    matcher: RegexMatcher,
    cancelled: &AtomicBool,
    emit: F,
) {
    let started = Instant::now();
    let max = opts.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let multi_line = is_multi_line(&opts);
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .multi_line(multi_line)
        .build();
    let (mut files, mut total, mut truncated) = (0usize, 0usize, false);
    // A folder nested in another one is walked twice: each file is reported once, in the
    // first folder that holds it.
    let several = walkers.len() > 1;
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let entries = walkers
        .into_iter()
        .flat_map(|(root, walker)| walker.build().flatten().map(move |e| (root.clone(), e)));
    for (root, entry) in entries {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if several && !seen.insert(path.to_path_buf()) {
            continue;
        }
        let mut matches: Vec<LineMatch> = Vec::new();
        let result = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_number, line| {
                if multi_line {
                    // `line` is every line the match spans (matches sharing lines come together).
                    for found in block_matches(&matcher, line_number, line) {
                        match matches.iter_mut().find(|m| m.line == found.line) {
                            Some(existing) => {
                                existing.ranges.extend(found.ranges);
                                existing.ranges.sort_unstable();
                                existing.ranges.dedup();
                            }
                            None => matches.push(found),
                        }
                    }
                    return Ok(total + matches.len() < max);
                }
                let line = line.trim_end_matches(['\n', '\r']);
                let mut ranges = Vec::new();
                let _ = matcher.find_iter(line.as_bytes(), |m| {
                    if m.start() < line.len()
                        && line.is_char_boundary(m.start())
                        && line.is_char_boundary(m.end())
                    {
                        ranges.push((m.start(), m.end()));
                    }
                    true
                });
                let (text, ranges) = clip(line, &ranges);
                matches.push(LineMatch {
                    line: line_number,
                    text,
                    ranges,
                });
                Ok(total + matches.len() < max)
            }),
        );
        if result.is_err() || matches.is_empty() {
            continue;
        }
        files += 1;
        total += matches.len();
        let rel = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        emit(SearchEvent::File {
            path: path.to_string_lossy().into_owned(),
            rel,
            matches,
        });
        if total >= max {
            truncated = true;
            break;
        }
    }
    emit(SearchEvent::Done {
        files,
        matches: total,
        truncated,
        cancelled: cancelled.load(Ordering::Relaxed),
        duration_ms: started.elapsed().as_millis() as u64,
    });
}

/// A line's number, where it starts in a block, and the match ranges within it.
type LineRanges = (u64, usize, Vec<(usize, usize)>);

/// The matches in a multi-line block (whole lines, the first one numbered `first_line`): one entry
/// per line a match starts on, each range running to the match's end or that line's end,
/// whichever comes first.
fn block_matches(matcher: &RegexMatcher, first_line: u64, block: &str) -> Vec<LineMatch> {
    let mut found: Vec<(usize, usize)> = Vec::new();
    let _ = matcher.find_iter(block.as_bytes(), |m| {
        // An empty match (`^`, `\n*`) has nothing to show.
        if m.end() > m.start()
            && block.is_char_boundary(m.start())
            && block.is_char_boundary(m.end())
        {
            found.push((m.start(), m.end()));
        }
        true
    });
    // Per line a match starts on: its number, where it starts in `block`, the ranges in it.
    let mut per_line: Vec<LineRanges> = Vec::new();
    for (start, end) in found {
        let line_start = block[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line_end = block[start..]
            .find('\n')
            .map(|i| start + i)
            .unwrap_or(block.len());
        let text_end = line_start + block[line_start..line_end].trim_end_matches('\r').len();
        // A match that starts on the line break itself shows as an empty range at the line's end.
        let from = start.min(text_end);
        let range = (from - line_start, end.min(text_end).max(from) - line_start);
        let line_no = first_line + block[..line_start].matches('\n').count() as u64;
        match per_line.iter_mut().find(|(l, _, _)| *l == line_no) {
            Some((_, _, ranges)) => ranges.push(range),
            None => per_line.push((line_no, line_start, vec![range])),
        }
    }
    per_line
        .into_iter()
        .map(|(line_no, line_start, ranges)| {
            let rest = &block[line_start..];
            let line = rest[..rest.find('\n').unwrap_or(rest.len())].trim_end_matches('\r');
            let ranges: Vec<(usize, usize)> = ranges
                .into_iter()
                .filter(|(s, e)| line.is_char_boundary(*s) && line.is_char_boundary(*e))
                .collect();
            let (text, ranges) = clip(line, &ranges);
            LineMatch {
                line: line_no,
                text,
                ranges,
            }
        })
        .collect()
}

/// Whether `path` resolves (through any links) to somewhere under `root` (already canonical).
/// Unresolvable paths and a missing root count as outside.
fn inside_root(path: &Path, root: Option<&Path>) -> bool {
    match (root, std::fs::canonicalize(path)) {
        (Some(root), Ok(real)) => real.starts_with(root),
        _ => false,
    }
}

/// Cuts long lines to a window around the first match; converts byte ranges to UTF-16 ranges.
fn clip(line: &str, ranges: &[(usize, usize)]) -> (String, Vec<(usize, usize)>) {
    let first = ranges.first().map(|r| r.0).unwrap_or(0);
    let total_chars = line.chars().count();
    let (start, prefix) = if total_chars > MAX_LINE_CHARS && first > 40 {
        // Begin a little before the first match, on a char boundary.
        let mut s = first.saturating_sub(40);
        while !line.is_char_boundary(s) {
            s -= 1;
        }
        (s, "…")
    } else {
        (0, "")
    };
    let mut end = line.len();
    let window: String = line[start..].chars().take(MAX_LINE_CHARS).collect();
    if window.len() < line.len() - start {
        end = start + window.len();
    }
    let text = format!("{prefix}{}", &line[start..end]);
    let offset = utf16_len(prefix);
    let ranges = ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| {
            (
                offset + utf16_len(&line[start..*s]),
                offset + utf16_len(&line[start..*e]),
            )
        })
        .collect();
    (text, ranges)
}

#[cfg(test)]
mod tests;
