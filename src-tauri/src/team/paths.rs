//! The names a team's library may use, checked again on this computer: the service checks them
//! too, but what it sends decides where files are written here, so nothing is taken on trust.

/// The kinds of item this build reads. Anything else the service lists is left out.
pub const KINDS: &[&str] = &[
    "rules",
    "skills",
    "commands",
    "agents",
    "outputStyles",
    "snippets",
    "mcp",
    "settings",
    "extensions",
];

const MAX_PATH_CHARS: usize = 200;
/// `skills/<skill>/<file…>`: as deep as the user's own synced skills go.
const MAX_SKILL_DEPTH: usize = 6;

/// An item's id: 1 to 64 characters of `[A-Za-z0-9_-]`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Names Windows keeps for devices, whatever follows the first dot (`NUL.md` is `NUL`).
fn reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    // (The superscript digits count as a port's number too; `CONIN$` and `CONOUT$` can't be
    // named here at all, `$` is no plain character.)
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            let mut digits = rest.chars();
            matches!(
                (digits.next(), digits.next()),
                (Some(digit), None)
                    if matches!(digit, '1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
            )
        })
    };
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT")
}

/// One part of a name: letters, digits, `. _ -` and spaces; not hidden, not `..`, nothing a
/// file system reads as something else (a device, a trailing dot or space).
fn plain_part(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('.')
        && !part.starts_with(' ')
        && !part.ends_with('.')
        && !part.ends_with(' ')
        && !part.contains("..")
        && part
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        && !reserved(part)
}

/// The parts of `path` when it is a name an item of `kind` may have, else None: a relative
/// name of plain parts, in the shape that kind has (the same names the user's own files sync
/// under).
pub fn check<'a>(kind: &str, path: &'a str) -> Option<Vec<&'a str>> {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if !parts.iter().all(|p| plain_part(p)) {
        return None;
    }
    let file = |folder: &str, endings: &[&str]| match parts.as_slice() {
        [f, name] => {
            *f == folder
                && endings
                    .iter()
                    .any(|e| name.len() > e.len() && name.ends_with(e))
        }
        _ => false,
    };
    let ok = match kind {
        "rules" => path == "AGENTS.md",
        "mcp" => path == "mcp.json",
        "settings" => path == "settings.json",
        "extensions" => path == "extensions.json",
        "skills" => parts[0] == "skills" && (3..=MAX_SKILL_DEPTH).contains(&parts.len()),
        "commands" => file("commands", &[".md"]),
        "agents" => file("agents", &[".md"]),
        "outputStyles" => file("output-styles", &[".md"]),
        "snippets" => file("snippets", &[".json", ".code-snippets"]),
        _ => false,
    };
    ok.then_some(parts)
}

/// A team's folder name in the cache: its id when that is a plain name, else a name made from it
/// (an id is the service's to choose, and it becomes a folder here).
pub fn folder_name(team_id: &str) -> String {
    if valid_id(team_id) && !reserved(team_id) && !team_id.starts_with('-') {
        return team_id.to_string();
    }
    use sha2_10::{Digest, Sha256};
    let digest = Sha256::digest(team_id.as_bytes());
    let hex: String = digest[..12].iter().map(|b| format!("{b:02x}")).collect();
    format!("x{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_each_kind_has() {
        for (kind, path) in [
            ("rules", "AGENTS.md"),
            ("mcp", "mcp.json"),
            ("settings", "settings.json"),
            ("extensions", "extensions.json"),
            ("skills", "skills/review/SKILL.md"),
            ("skills", "skills/review/scripts/run.py"),
            ("skills", "skills/code review/notes on style.md"),
            ("commands", "commands/ship.md"),
            ("agents", "agents/reviewer.md"),
            ("outputStyles", "output-styles/terse.md"),
            ("snippets", "snippets/go.json"),
            ("snippets", "snippets/all.code-snippets"),
        ] {
            assert!(check(kind, path).is_some(), "{kind} {path}");
        }
        assert_eq!(
            check("skills", "skills/review/SKILL.md"),
            Some(vec!["skills", "review", "SKILL.md"])
        );
    }

    #[test]
    fn names_that_leave_the_cache_or_fit_no_kind_are_refused() {
        for (kind, path) in [
            // Leaving the folder.
            ("skills", "skills/../../settings.json"),
            ("skills", "skills/review/../../x"),
            ("commands", "../commands/x.md"),
            ("commands", "/commands/x.md"),
            ("commands", "commands//x.md"),
            ("commands", "C:/commands/x.md"),
            ("commands", "commands\\x.md"),
            ("skills", "skills/review/a..b"),
            // Devices, hidden files, trailing dots and spaces.
            ("commands", "commands/NUL.md"),
            ("commands", "commands/con.md"),
            ("skills", "skills/COM1/SKILL.md"),
            ("skills", "skills/review/lpt9.txt"),
            ("skills", "skills/COM\u{b9}/SKILL.md"),
            ("skills", "skills/review/lpt\u{b3}.txt"),
            ("skills", "skills/review/CONIN$"),
            ("skills", "skills/review/.env"),
            ("skills", "skills/review/x.md."),
            ("skills", "skills/review /SKILL.md"),
            // Another kind's name, or none.
            ("rules", "CLAUDE.md"),
            ("rules", "rules/AGENTS.md"),
            ("commands", "commands/x.sh"),
            ("commands", "commands/deep/x.md"),
            ("commands", "commands/.md"),
            ("agents", "commands/x.md"),
            ("snippets", "snippets/x.exe"),
            ("skills", "skills/review"),
            ("skills", "skills/a/b/c/d/e/f.md"),
            ("mcp", "secrets.json"),
            ("settings", "keybindings.json"),
            ("providers", "providers.json"),
            ("hooks", "hooks.json"),
            ("rules", ""),
        ] {
            assert!(check(kind, path).is_none(), "{kind} {path}");
        }
        let long = format!("skills/{}/SKILL.md", "a".repeat(200));
        assert!(check("skills", &long).is_none());
    }

    #[test]
    fn ids_and_folder_names() {
        assert!(valid_id("Ab3_-x"));
        assert!(!valid_id(""));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a.b"));
        assert!(!valid_id(&"a".repeat(65)));
        assert_eq!(folder_name("t1"), "t1");
        // An id that isn't a plain name (or is a device's) gets a made-up one.
        for odd in ["../x", "nul", "a b", "", "-x"] {
            let name = folder_name(odd);
            assert!(name.starts_with('x') && name.len() == 25, "{odd} -> {name}");
        }
        assert_ne!(folder_name("../x"), folder_name("../y"));
    }
}
