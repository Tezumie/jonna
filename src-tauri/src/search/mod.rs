//! Workspace text search (ripgrep's `grep-searcher` + `grep-regex`) and replace. A search walks
//! the folder with the same ignore rules as the file index plus include/exclude globs, and streams
//! one event per matching file over a Tauri Channel. Starting a search cancels the previous one.
//! Replace re-applies the same pattern to chosen files and writes them atomically.
//!
//! A pattern that can match a line break (a regex with `\n`, or pasted text holding a newline)
//! searches in multi-line mode, like VS Code: each match is reported on the line it starts on,
//! its range running to the match's end or that line's end, whichever comes first.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::atomic_write;

/// Lines longer than this are cut (minified files) so one match can't flood the UI.
const MAX_LINE_CHARS: usize = 300;
const DEFAULT_MAX_RESULTS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Replace keeps each match's case pattern (UPPER, lower, Capitalized).
    #[serde(default)]
    pub preserve_case: bool,
    /// Replace only on these 1-based lines (a single result's Replace).
    #[serde(default)]
    pub lines: Option<Vec<usize>>,
    /// A regex may span lines and `.` matches a line break too (the agent's `multiline`, D306).
    #[serde(default)]
    pub multi_line: bool,
}

fn default_true() -> bool {
    true
}

/// `replacement` in the case pattern of `matched`: all upper, all lower, or capitalized.
pub fn preserve_case(matched: &str, replacement: &str) -> String {
    let letters: Vec<char> = matched.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return replacement.to_string();
    }
    if letters.iter().all(|c| c.is_uppercase()) && letters.len() > 1 {
        return replacement.to_uppercase();
    }
    if letters.iter().all(|c| c.is_lowercase()) {
        return replacement.to_lowercase();
    }
    let mut chars = matched.chars();
    if chars.next().is_some_and(char::is_uppercase) && chars.all(|c| !c.is_uppercase()) {
        let mut out = replacement.chars();
        return match out.next() {
            Some(first) => first.to_uppercase().chain(out).collect(),
            None => String::new(),
        };
    }
    replacement.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// UTF-16 [start, end) ranges within `text` (JS string indices).
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files: usize,
    pub replacements: usize,
    pub skipped: Vec<String>,
    /// Per changed file, the local-history snapshots before and after (workspace undo).
    pub changes: Vec<ReplacedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_hash: String,
    pub after_hash: String,
}

#[derive(Default)]
pub struct SearchService {
    current: Mutex<Option<Arc<AtomicBool>>>,
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
    if opts.multi_line || opts.query.contains('\n') {
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
        builder
            .multi_line(true)
            .dot_matches_new_line(opts.multi_line);
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

impl SearchService {
    /// Cancels the running search, if any.
    pub fn cancel(&self) {
        if let Ok(mut current) = self.current.lock() {
            if let Some(flag) = current.take() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Starts a search under `roots` (the workspace's folders, in order); events go to `emit`.
    /// Returns at once (runs on a thread): one `File` event per matching file, each `rel` to its
    /// own folder, then one `Done` with the totals. A `detached` search (an extension's) neither
    /// cancels the search view's nor is cancelled by it.
    pub fn start<F>(
        &self,
        roots: Vec<PathBuf>,
        opts: SearchOptions,
        detached: bool,
        emit: F,
    ) -> Result<()>
    where
        F: Fn(SearchEvent) + Send + 'static,
    {
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
        let flag = Arc::new(AtomicBool::new(false));
        if !detached {
            self.cancel();
            if let Ok(mut current) = self.current.lock() {
                *current = Some(flag.clone());
            }
        }
        std::thread::spawn(move || run(walkers, opts, matcher, flag, emit));
        Ok(())
    }
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

/// Files are searched on this many threads at most (D254): one walks the folders, the others
/// read and match, as ripgrep does; one thread for every file kept a large repository's search
/// waiting on each read in turn.
const MAX_SEARCH_THREADS: usize = 8;

fn run<F: Fn(SearchEvent)>(
    walkers: Vec<(PathBuf, WalkBuilder)>,
    opts: SearchOptions,
    matcher: RegexMatcher,
    cancelled: Arc<AtomicBool>,
    emit: F,
) {
    let started = Instant::now();
    let max = opts.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
    let multi_line = is_multi_line(&opts);
    let (mut files, mut total, mut truncated) = (0usize, 0usize, false);
    // Matches found so far, for the workers to stop reading a file once the cap is reached.
    let found = AtomicUsize::new(0);
    // Enough results (or Stop): the walk and the workers end.
    let enough = AtomicBool::new(false);
    let stop = || cancelled.load(Ordering::Relaxed) || enough.load(Ordering::Relaxed);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, MAX_SEARCH_THREADS);
    let (paths_tx, paths_rx) = mpsc::sync_channel::<(PathBuf, PathBuf)>(256);
    let paths_rx = Mutex::new(paths_rx);
    std::thread::scope(|scope| {
        let (found_tx, found_rx) = mpsc::channel::<(PathBuf, PathBuf, Vec<LineMatch>)>();
        // The walk: a folder nested in another one is walked twice, and each file is reported
        // once, by the innermost folder that holds it (the frontend's `folderOf`, so its `rel` is
        // relative to the folder it's shown under).
        let stop_walk = &stop;
        scope.spawn(move || {
            let several = walkers.len() > 1;
            let roots: Vec<PathBuf> = walkers.iter().map(|(r, _)| r.clone()).collect();
            let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
            let entries = walkers.into_iter().flat_map(|(root, walker)| {
                walker.build().flatten().map(move |e| (root.clone(), e))
            });
            for (root, entry) in entries {
                if stop_walk() {
                    break;
                }
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                let path = entry.path();
                if several {
                    let innermost = roots
                        .iter()
                        .filter(|r| path.starts_with(r))
                        .max_by_key(|r| r.components().count());
                    if innermost.is_some_and(|r| *r != root) || !seen.insert(path.to_path_buf()) {
                        continue;
                    }
                }
                if paths_tx.send((root, path.to_path_buf())).is_err() {
                    break;
                }
            }
        });
        for _ in 0..threads {
            let paths_rx = &paths_rx;
            let found_tx = found_tx.clone();
            let matcher = matcher.clone();
            let (found, stop) = (&found, &stop);
            scope.spawn(move || {
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(b'\x00'))
                    .line_number(true)
                    .multi_line(multi_line)
                    .build();
                loop {
                    let next = match paths_rx.lock() {
                        Ok(rx) => rx.recv(),
                        Err(_) => break,
                    };
                    let Ok((root, path)) = next else { break };
                    if stop() {
                        continue; // drained so the walk isn't left waiting
                    }
                    let matches = search_file(&mut searcher, &matcher, &path, multi_line, || {
                        found.load(Ordering::Relaxed) < max
                    });
                    if matches.is_empty() {
                        continue;
                    }
                    found.fetch_add(matches.len(), Ordering::Relaxed);
                    if found_tx.send((root, path, matches)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(found_tx);
        for (root, path, matches) in found_rx {
            if cancelled.load(Ordering::Relaxed) || truncated {
                continue;
            }
            let mut matches = matches;
            if total + matches.len() > max {
                matches.truncate(max - total);
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
                enough.store(true, Ordering::Relaxed);
            }
        }
    });
    emit(SearchEvent::Done {
        files,
        matches: total,
        truncated,
        cancelled: cancelled.load(Ordering::Relaxed),
        duration_ms: started.elapsed().as_millis() as u64,
    });
}

/// One file's matching lines; reading stops once `more()` says the cap is reached.
fn search_file(
    searcher: &mut grep_searcher::Searcher,
    matcher: &RegexMatcher,
    path: &Path,
    multi_line: bool,
    more: impl Fn() -> bool,
) -> Vec<LineMatch> {
    let mut matches: Vec<LineMatch> = Vec::new();
    let result = searcher.search_path(
        matcher,
        path,
        UTF8(|line_number, line| {
            if multi_line {
                // `line` is every line the match spans (matches sharing lines come together).
                for found in block_matches(matcher, line_number, line) {
                    match matches.iter_mut().find(|m| m.line == found.line) {
                        Some(existing) => {
                            existing.ranges.extend(found.ranges);
                            existing.ranges.sort_unstable();
                            existing.ranges.dedup();
                        }
                        None => matches.push(found),
                    }
                }
                return Ok(more());
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
            Ok(more())
        }),
    );
    if result.is_err() {
        return Vec::new();
    }
    matches
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

/// Replaces every match in `paths` (absolute, scope-checked by the caller).
/// The regex a replace uses for `opts`.
pub fn replace_regex(opts: &SearchOptions) -> Result<regex::Regex> {
    let source = if is_multi_line(opts) {
        crlf_tolerant(&pattern(opts))
    } else {
        pattern(opts)
    };
    regex::RegexBuilder::new(&source)
        .case_insensitive(!opts.match_case)
        .multi_line(true)
        .dot_matches_new_line(opts.multi_line)
        .build()
        .map_err(|e| Error::Invalid(format!("invalid search pattern: {e}")))
}

/// `text` with the matches of `re` replaced (only on `opts.lines` when given), and how many.
pub fn replace_in_text(
    re: &regex::Regex,
    opts: &SearchOptions,
    replacement: &str,
    text: &str,
) -> (String, usize) {
    // 1-based line of a byte offset (for `lines`).
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let mut count = 0usize;
    let next = re.replace_all(text, |caps: &regex::Captures<'_>| {
        let Some(m) = caps.get(0) else {
            return String::new();
        };
        if let Some(lines) = &opts.lines {
            let line = line_starts.partition_point(|&start| start <= m.start());
            if !lines.contains(&line) {
                return m.as_str().to_string();
            }
        }
        count += 1;
        let mut out = String::new();
        if opts.is_regex {
            caps.expand(replacement, &mut out);
        } else {
            out.push_str(replacement);
        }
        if opts.preserve_case {
            out = preserve_case(m.as_str(), &out);
        }
        out
    });
    (next.into_owned(), count)
}

pub fn replace(
    opts: &SearchOptions,
    replacement: &str,
    paths: &[PathBuf],
    history: Option<&crate::history::LocalHistory>,
) -> Result<ReplaceResult> {
    let re = replace_regex(opts)?;
    let mut result = ReplaceResult {
        files: 0,
        replacements: 0,
        skipped: Vec::new(),
        changes: Vec::new(),
    };
    for path in paths {
        let Ok(text) = std::fs::read_to_string(path) else {
            result.skipped.push(path.to_string_lossy().into_owned());
            continue;
        };
        let (next, count) = replace_in_text(&re, opts, replacement, &text);
        if count == 0 {
            continue;
        }
        let before = history
            .and_then(|h| {
                h.record(path, text.as_bytes(), "before replace")
                    .ok()
                    .flatten()
            })
            .map(|e| e.id);
        // No snapshot to undo with (a file over the local-history limit): left alone rather
        // than changed for good (D141).
        if history.is_some() && before.is_none() {
            result.skipped.push(path.to_string_lossy().into_owned());
            continue;
        }
        // One file failing to write doesn't lose the undo of the others already written.
        if atomic_write(path, next.as_bytes()).is_err() {
            result.skipped.push(path.to_string_lossy().into_owned());
            continue;
        }
        let after = history
            .and_then(|h| h.record(path, next.as_bytes(), "replace").ok().flatten())
            .map(|e| e.id);
        result.changes.push(ReplacedFile {
            path: path.to_string_lossy().into_owned(),
            before,
            after,
            before_hash: crate::history::hash(text.as_bytes()),
            after_hash: crate::history::hash(next.as_bytes()),
        });
        result.files += 1;
        result.replacements += count;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
