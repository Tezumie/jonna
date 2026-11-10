//! Fuzzy matching for quick open: the query's characters must appear in order in the path
//! (case-insensitive). Matches in the file name beat matches spread over folders; consecutive
//! characters and characters at the start of a word score extra; shorter paths win ties.
//! Spaces split the query into words that must all match.

/// A scored match: higher is better; `positions` are char indices into the path (for highlight).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Score {
    pub score: i64,
    pub positions: Vec<usize>,
}

fn is_boundary(prev: Option<char>, cur: char) -> bool {
    match prev {
        None => true,
        Some(p) => {
            matches!(p, '/' | '\\' | '.' | '_' | '-' | ' ')
                || (p.is_lowercase() && cur.is_uppercase())
                || (!p.is_ascii_digit() && cur.is_ascii_digit())
        }
    }
}

/// Matches `word` (already lowercase) against `chars[from..]`, greedily but preferring word
/// starts: for each query char, take the next boundary occurrence if one exists before the next
/// plain occurrence of the following query char would be lost.
fn match_word(
    word: &[char],
    chars: &[char],
    lower: &[char],
    from: usize,
) -> Option<(i64, Vec<usize>)> {
    let mut positions = Vec::with_capacity(word.len());
    let mut score = 0i64;
    let mut i = from;
    let mut last: Option<usize> = None;
    for &q in word {
        // Plain next occurrence.
        let next = (i..lower.len()).find(|&k| lower[k] == q)?;
        // A word-start occurrence later on is better unless it skips past the rest of the query.
        let start = (next..lower.len())
            .find(|&k| lower[k] == q && is_boundary(k.checked_sub(1).map(|p| chars[p]), chars[k]));
        let pick = match (start, last) {
            (_, Some(l)) if next == l + 1 => next, // keep runs together
            (Some(s), _) => s,
            (None, _) => next,
        };
        score += 1;
        if last.is_some_and(|l| pick == l + 1) {
            score += 8;
        }
        if is_boundary(pick.checked_sub(1).map(|p| chars[p]), chars[pick]) {
            score += 10;
        }
        if let Some(l) = last {
            score -= ((pick - l - 1) as i64).min(10);
        }
        positions.push(pick);
        last = Some(pick);
        i = pick + 1;
    }
    Some((score, positions))
}

/// Scores `path` (relative, `/` separators) against `query`; None if it doesn't match.
pub fn score(query: &str, path: &str) -> Option<Score> {
    let chars: Vec<char> = path.chars().collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    if lower.len() != chars.len() {
        return None; // exotic case mappings: skip rather than mis-highlight
    }
    let name_start = path
        .rfind('/')
        .map(|i| path[..=i].chars().count())
        .unwrap_or(0);
    let mut total = 0i64;
    let mut positions = Vec::new();
    for word in query.split_whitespace() {
        let word: Vec<char> = word.chars().flat_map(|c| c.to_lowercase()).collect();
        // Prefer the file name; fall back to the whole path.
        let (s, p) = match match_word(&word, &chars, &lower, name_start) {
            Some((s, p)) => (s + 20 + word.len() as i64 * 2, p),
            None => match_word(&word, &chars, &lower, 0)?,
        };
        total += s;
        positions.extend(p);
    }
    positions.sort_unstable();
    positions.dedup();
    total -= (chars.len() as i64) / 8;
    Some(Score {
        score: total,
        positions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(q: &str, p: &str) -> i64 {
        score(q, p).map(|s| s.score).unwrap_or(i64::MIN)
    }

    #[test]
    fn requires_all_chars_in_order() {
        assert!(score("mts", "src/main.ts").is_some());
        assert!(score("xyz", "src/main.ts").is_none());
    }

    #[test]
    fn file_name_beats_folders() {
        assert!(s("main", "src/main.ts") > s("main", "main/src/other.ts"));
        assert!(s("view", "src/explorer/view.ts") > s("view", "src/views/index.ts") - 5);
    }

    #[test]
    fn word_starts_and_runs_win() {
        assert!(s("ts", "src/tree/select.ts") > s("ts", "src/xtxsx.md"));
        assert!(s("fc", "src/fileCommands.ts") > s("fc", "src/fancy.ts") - 30);
    }

    #[test]
    fn words_must_all_match_and_positions_highlight() {
        let m = score("ex view", "src/extensions/explorer/view.ts").map(|s| s.positions);
        assert!(m.is_some());
        assert!(score("ex zzz", "src/extensions/explorer/view.ts").is_none());
        let p = score("main", "src/main.ts").map(|s| s.positions);
        assert_eq!(p, Some(vec![4, 5, 6, 7]));
    }
}
