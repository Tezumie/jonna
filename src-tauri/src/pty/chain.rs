//! `a && b` / `a || b` for Windows PowerShell 5.1, which predates them (PowerShell 7 has them):
//! rewritten with a status variable, left to right like a shell (D115, D120):
//! `a && b || c` → `a; $__ideOk = $?; if ($__ideOk) { b; $__ideOk = $? }; if (-not $__ideOk) { c;
//! $__ideOk = $? }` — so `c` runs when `a` or `b` failed. Quotes and backtick escapes are
//! respected; anything else is left as written. The terminal does the same in PowerShell itself
//! (scripts/pwsh.ps1); this one is for commands the IDE runs (the agent's run_command, tasks).

/// The rewritten command, or None when there is no top-level `&&` / `||` (or a side is empty).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ps5_chain(command: &str) -> Option<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut ops: Vec<&str> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            cur.push(c);
            if c == '`' && q == '"' && i + 1 < chars.len() {
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                cur.push(c);
            }
            '`' if i + 1 < chars.len() => {
                cur.push(c);
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            '&' | '|' if chars.get(i + 1) == Some(&c) => {
                parts.push(cur.trim().to_string());
                ops.push(if c == '&' {
                    "$__ideOk"
                } else {
                    "-not $__ideOk"
                });
                cur.clear();
                i += 2;
                continue;
            }
            _ => cur.push(c),
        }
        i += 1;
    }
    parts.push(cur.trim().to_string());
    if ops.is_empty() || parts.iter().any(String::is_empty) {
        return None;
    }
    let mut out = format!("{}; $__ideOk = $?", parts[0]);
    for (op, part) in ops.iter().zip(&parts[1..]) {
        out.push_str(&format!("; if ({op}) {{ {part}; $__ideOk = $? }}"));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::ps5_chain;

    #[test]
    fn chains_and_keeps_quotes() {
        assert_eq!(
            ps5_chain("cd app && npm run dev").as_deref(),
            Some("cd app; $__ideOk = $?; if ($__ideOk) { npm run dev; $__ideOk = $? }")
        );
        // Left to right, like a shell: "next" runs when the tests pass (or "failed" ran).
        assert_eq!(
            ps5_chain("npm test || echo failed && echo next").as_deref(),
            Some("npm test; $__ideOk = $?; if (-not $__ideOk) { echo failed; $__ideOk = $? }; if ($__ideOk) { echo next; $__ideOk = $? }")
        );
        assert_eq!(ps5_chain(r#"echo "a && b""#), None);
        assert_eq!(
            ps5_chain("echo 'x || y' && ls").as_deref(),
            Some("echo 'x || y'; $__ideOk = $?; if ($__ideOk) { ls; $__ideOk = $? }")
        );
        assert_eq!(ps5_chain("a | b"), None);
        assert_eq!(ps5_chain("a &&"), None);
        assert_eq!(ps5_chain("dir"), None);
    }
}
