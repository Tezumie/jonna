//! Bash habits in PowerShell (D144): models write `rm -rf dir`, `cmd 2>/dev/null`, `… | head -20`
//! even when told the shell is PowerShell, and each one fails there (`rm -rf` is a parameter
//! error, `head` doesn't exist), so a weak model loops on variations. For commands the IDE runs
//! for the agent on Windows, these few idioms are rewritten to their PowerShell equivalents:
//!
//! | bash | PowerShell |
//! |---|---|
//! | `rm -rf a b` (`-r`, `-f`, `-fr`…) | `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue a, b` |
//! | `mkdir -p a b` | `New-Item -ItemType Directory -Force -Path a, b \| Out-Null` |
//! | `ls -la` (any `-l`/`-a` flags) | `Get-ChildItem -Force` |
//! | `… \| head -n 20` / `head -20` / `head` | `… \| Select-Object -First 20` (10) |
//! | `… \| tail -n 20` / `tail -20` / `tail` | `… \| Select-Object -Last 20` (10) |
//! | `which x` | `Get-Command x` |
//! | `2>/dev/null`, `>/dev/null`, `&>/dev/null` | `2>$null`, `>$null`, `*>$null` |
//!
//! Only whole commands between `;`, `|`, `&&` and `||` outside quotes are matched; anything
//! else is left as written.

/// A command split at top-level separators: (text, separator after it).
fn split(command: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            cur.push(c);
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
            ';' => {
                out.push((std::mem::take(&mut cur), ";".into()));
            }
            '&' | '|' if chars.get(i + 1) == Some(&c) => {
                out.push((std::mem::take(&mut cur), format!("{c}{c}")));
                i += 2;
                continue;
            }
            '|' => {
                out.push((std::mem::take(&mut cur), "|".into()));
            }
            _ => cur.push(c),
        }
        i += 1;
    }
    out.push((cur, String::new()));
    out
}

/// Words outside quotes (quotes kept).
fn words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in segment.chars() {
        match quote {
            Some(q) => {
                cur.push(c);
                if c == q {
                    quote = None;
                }
            }
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                cur.push(c);
            }
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `/dev/null` redirections, outside quotes.
fn null_redirects(segment: &str) -> String {
    let mut out = String::new();
    for (i, w) in words(segment).iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let w = match w.as_str() {
            "2>/dev/null" => "2>$null",
            ">/dev/null" | "1>/dev/null" => ">$null",
            "&>/dev/null" | ">/dev/null 2>&1" => "*>$null",
            "2>&1" if out.ends_with(">$null ") => {
                // `>/dev/null 2>&1`: everything to null.
                out.truncate(out.len() - ">$null ".len());
                out.push_str("*>$null");
                continue;
            }
            other => other,
        };
        out.push_str(w);
    }
    out
}

/// A count from `-n 20`, `-20`, `-n20` (default 10); None when other arguments follow.
fn count(args: &[String]) -> Option<u32> {
    match args {
        [] => Some(10),
        [n] if n.starts_with("-n") && n.len() > 2 => n[2..].parse().ok(),
        [n] if n.starts_with('-') => n[1..].parse().ok(),
        [flag, n] if flag == "-n" => n.parse().ok(),
        _ => None,
    }
}

fn rewrite_segment(segment: &str, after_pipe: bool) -> Option<String> {
    let w = words(segment);
    let (cmd, args) = w.split_first()?;
    let flags: Vec<&String> = args.iter().take_while(|a| a.starts_with('-')).collect();
    let rest: Vec<&String> = args.iter().skip(flags.len()).collect();
    let short = |allowed: &str| {
        !flags.is_empty()
            && flags
                .iter()
                .all(|f| f.len() > 1 && f[1..].chars().all(|c| allowed.contains(c)))
    };
    let has = |c: char| flags.iter().any(|f| f[1..].contains(c));
    let list = |items: &[&String]| {
        items
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    match cmd.as_str() {
        "rm" if short("rRf") && !rest.is_empty() => {
            let recurse = has('r') || has('R');
            let force = has('f');
            Some(format!(
                "Remove-Item{}{} {}",
                if recurse { " -Recurse" } else { "" },
                if force {
                    " -Force -ErrorAction SilentlyContinue"
                } else {
                    ""
                },
                list(&rest)
            ))
        }
        "mkdir" if short("p") && !rest.is_empty() => Some(format!(
            "New-Item -ItemType Directory -Force -Path {} | Out-Null",
            list(&rest)
        )),
        "ls" if short("lah1") => Some(
            format!(
                "Get-ChildItem -Force {}",
                rest.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            )
            .trim_end()
            .to_string(),
        ),
        "head" | "tail" if after_pipe => count(args).map(|n| {
            format!(
                "Select-Object -{} {n}",
                if cmd == "head" { "First" } else { "Last" }
            )
        }),
        "which" if args.len() == 1 => Some(format!("Get-Command {}", args[0])),
        _ => None,
    }
}

/// The command with bash idioms rewritten for PowerShell, or None when nothing changed.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn powershell_from_bash(command: &str) -> Option<String> {
    let mut out = String::new();
    let mut changed = false;
    let mut after_pipe = false;
    for (segment, sep) in split(command) {
        let lead = &segment[..segment.len() - segment.trim_start().len()];
        let trail = &segment[segment.trim_end().len()..];
        let body = segment.trim();
        let nulled = if body.contains("/dev/null") {
            null_redirects(body)
        } else {
            body.to_string()
        };
        let next = rewrite_segment(&nulled, after_pipe).unwrap_or(nulled);
        if next != body {
            changed = true;
        }
        out.push_str(lead);
        out.push_str(&next);
        out.push_str(trail);
        out.push_str(&sep);
        after_pipe = sep == "|";
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::powershell_from_bash as ps;

    #[test]
    fn rewrites_common_idioms() {
        assert_eq!(
            ps("rm -rf node_modules package-lock.json").as_deref(),
            Some("Remove-Item -Recurse -Force -ErrorAction SilentlyContinue node_modules, package-lock.json")
        );
        assert_eq!(
            ps("rm -rf node_modules && npm install").as_deref(),
            Some("Remove-Item -Recurse -Force -ErrorAction SilentlyContinue node_modules && npm install")
        );
        assert_eq!(ps("rm a.txt"), None);
        assert_eq!(
            ps("npm install 2>&1 | tail -30").as_deref(),
            Some("npm install 2>&1 | Select-Object -Last 30")
        );
        assert_eq!(
            ps("ls -la node_modules 2>/dev/null | head -n 20").as_deref(),
            Some("Get-ChildItem -Force node_modules 2>$null | Select-Object -First 20")
        );
        assert_eq!(
            ps("cmd >/dev/null 2>&1; echo done").as_deref(),
            Some("cmd *>$null; echo done")
        );
        assert_eq!(
            ps("mkdir -p src/a src/b").as_deref(),
            Some("New-Item -ItemType Directory -Force -Path src/a, src/b | Out-Null")
        );
        assert_eq!(ps("which node").as_deref(), Some("Get-Command node"));
    }

    #[test]
    fn leaves_the_rest_alone() {
        assert_eq!(ps("npm install"), None);
        assert_eq!(ps("echo 'rm -rf x | head'"), None);
        assert_eq!(ps("Get-ChildItem | Select-Object -First 3"), None);
        // `head file` isn't after a pipe: left (it may be a script of that name).
        assert_eq!(ps("head -5 README.md"), None);
        assert_eq!(ps("git log | head -n x"), None);
    }
}
