//! Redaction for what goes into the session log (D204): API keys and tokens, `key=value` secrets,
//! passwords in URLs, and the user's home folder (`~`) or any user folder name (`<user>`). The
//! frontend has the same rules for the problem report (`src/core/diagnostics/redact.ts`).

use regex::Regex;
use std::sync::OnceLock;

struct Rules {
    known: Regex,
    bearer: Regex,
    pairs: Regex,
    url_credentials: Regex,
    windows_user: Regex,
    unix_user: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // Providers' key formats (OpenAI/Anthropic/OpenRouter `sk-…`, GitHub, Slack, AWS, Google,
        // GitLab, Hugging Face).
        known: Regex::new(
            r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})",
        )
        .expect("static regex"),
        bearer: Regex::new(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}")
            .expect("static regex"),
        pairs: Regex::new(
            r#"(?i)([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|credential|signature)[A-Za-z0-9_.-]*)("?'?\s*[:=]\s*"?'?)([^\s"',;&<>]{6,})"#,
        )
        .expect("static regex"),
        url_credentials: Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@")
            .expect("static regex"),
        windows_user: Regex::new(r"(?i)\b([A-Z]:[\\/]+Users[\\/]+)[^\\/\s'`]+")
            .expect("static regex"),
        unix_user: Regex::new(r"(/(?:home|Users)/)[^/\s'`]+").expect("static regex"),
    })
}

/// Redacts one text. `home` (the user's home folder) becomes `~`.
pub fn redact(text: &str, home: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(home) = home.filter(|h| h.len() > 3) {
        // Both slash styles, and case-insensitively (Windows paths).
        for form in [home.to_string(), home.replace('\\', "/")] {
            if let Ok(re) = Regex::new(&format!("(?i){}", regex::escape(&form))) {
                out = re.replace_all(&out, "~").into_owned();
            }
        }
    }
    let r = rules();
    out = r.known.replace_all(&out, "<redacted>").into_owned();
    out = r.bearer.replace_all(&out, "$1 <redacted>").into_owned();
    out = r.pairs.replace_all(&out, "$1$2<redacted>").into_owned();
    out = r
        .url_credentials
        .replace_all(&out, "$1<redacted>@")
        .into_owned();
    out = r.windows_user.replace_all(&out, "$1<user>").into_owned();
    out = r.unix_user.replace_all(&out, "$1<user>").into_owned();
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn keys_and_tokens_are_removed() {
        let t = redact(
            "key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123",
            None,
        );
        assert!(!t.contains("abcdefghijklmnop"), "{t}");
        assert_eq!(t.matches("<redacted>").count(), 2);
        let t = redact("Authorization: Bearer abc.def.ghi-jkl", None);
        assert!(
            t.starts_with("Authorization: ") && !t.contains("abc.def"),
            "{t}"
        );
        let t = redact(r#"{"apiKey": "s3cr3tvalue", "name": "x"}"#, None);
        assert!(t.contains(r#""apiKey": "<redacted>""#), "{t}");
        assert!(t.contains(r#""name": "x""#));
        let t = redact(
            "GET https://me:hunter2@example.com/x?access_token=abcd1234",
            None,
        );
        assert!(!t.contains("hunter2") && !t.contains("abcd1234"), "{t}");
        assert!(t.contains("example.com/x"));
    }

    #[test]
    fn home_folders_are_hidden() {
        let t = redact(
            r"failed C:\Users\Ada\proj\a.ts and c:/users/ada/proj/b.ts",
            Some(r"C:\Users\Ada"),
        );
        assert_eq!(t, r"failed ~\proj\a.ts and ~/proj/b.ts");
        let t = redact("at /home/bob/x and /Users/eve/y", None);
        assert_eq!(t, "at /home/<user>/x and /Users/<user>/y");
        let t = redact(r"D:\Users\carol\z", None);
        assert_eq!(t, r"D:\Users\<user>\z");
    }

    #[test]
    fn ordinary_text_is_kept() {
        let s = "editor.tabSize = 4; tokens: 120 in 3 s";
        assert_eq!(redact(s, None), s);
    }
}
