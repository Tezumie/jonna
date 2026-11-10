//! Parser for `git status --porcelain=v2 --branch -z --untracked-files=all`.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Branch name, or None when detached.
    pub head: Option<String>,
    /// Commit id, or None before the first commit.
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Relative to the repository root, `/` separators.
    pub path: String,
    /// For renames/copies: the old path.
    pub orig_path: Option<String>,
    /// Index (staged) state: '.', 'M', 'A', 'D', 'R', 'C', 'T', 'U', '?', '!'.
    pub index: char,
    /// Working-tree state, same letters.
    pub worktree: char,
    /// Merge conflict.
    pub conflict: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: BranchInfo,
    pub files: Vec<FileStatus>,
}

fn xy(field: &str) -> (char, char) {
    let mut chars = field.chars();
    (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'))
}

/// Parses NUL-separated porcelain v2 output.
pub fn parse_status(out: &str) -> GitStatus {
    let mut status = GitStatus::default();
    let mut records = out.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.branch.oid = Some(value.into()),
                "branch.head" if value != "(detached)" => status.branch.head = Some(value.into()),
                "branch.upstream" => status.branch.upstream = Some(value.into()),
                "branch.ab" => {
                    for part in value.split_whitespace() {
                        if let Some(n) = part.strip_prefix('+') {
                            status.branch.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.branch.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = rec.chars().next().unwrap_or(' ');
        match kind {
            '1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if let (Some(code), Some(path)) = (f.get(1), f.get(8)) {
                    let (i, w) = xy(code);
                    status.files.push(FileStatus {
                        path: (*path).into(),
                        orig_path: None,
                        index: i,
                        worktree: w,
                        conflict: false,
                    });
                }
            }
            '2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = records.next().map(String::from);
                if let (Some(code), Some(path)) = (f.get(1), f.get(9)) {
                    let (i, w) = xy(code);
                    status.files.push(FileStatus {
                        path: (*path).into(),
                        orig_path: orig,
                        index: i,
                        worktree: w,
                        conflict: false,
                    });
                }
            }
            'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if let (Some(code), Some(path)) = (f.get(1), f.get(10)) {
                    let (i, w) = xy(code);
                    status.files.push(FileStatus {
                        path: (*path).into(),
                        orig_path: None,
                        index: i,
                        worktree: w,
                        conflict: true,
                    });
                }
            }
            '?' | '!' => status.files.push(FileStatus {
                path: rec[2..].into(),
                orig_path: None,
                index: kind,
                worktree: kind,
                conflict: false,
            }),
            _ => {}
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_changes_renames_conflicts_untracked() {
        let out = "# branch.oid 1234abcd\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a file.ts\0\
1 A. N... 000000 100644 100644 000 ccc new.ts\0\
2 R. N... 100644 100644 100644 ddd ddd R100 src/b.ts\0src/old b.ts\0\
u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.txt\0\
? notes/todo.md\0";
        let s = parse_status(out);
        assert_eq!(s.branch.head.as_deref(), Some("main"));
        assert_eq!((s.branch.ahead, s.branch.behind), (2, 1));
        assert_eq!(s.files.len(), 5);
        assert_eq!(s.files[0].path, "src/a file.ts");
        assert_eq!((s.files[0].index, s.files[0].worktree), ('.', 'M'));
        assert_eq!(s.files[2].orig_path.as_deref(), Some("src/old b.ts"));
        assert!(s.files[3].conflict);
        assert_eq!(s.files[4].worktree, '?');
    }

    #[test]
    fn initial_and_detached() {
        let s = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(s.branch, BranchInfo::default());
    }
}
