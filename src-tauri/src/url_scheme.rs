//! Links to the IDE from other programs (D255): `<urlScheme>://<extension id>/…` (product.json's
//! `urlScheme`) reach the extension's URI handler (`ide.ui.registerUriHandler`). The OS starts the
//! program with the link as its argument (`cli.rs` reads it); a running window takes it over the
//! instance protocol. On Windows the IDE registers the scheme for the current user at start
//! (`HKCU\Software\Classes\<scheme>`, as VS Code's user installer does), pointing at this
//! program; macOS (`CFBundleURLTypes`) and Linux (`x-scheme-handler/<scheme>` in the `.desktop`
//! file) declare it in their bundles.

/// product.json's `urlScheme` (lowercase), or None when it has none.
pub fn scheme() -> Option<&'static str> {
    static SCHEME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    SCHEME
        .get_or_init(|| {
            serde_json::from_str::<serde_json::Value>(include_str!("../../product.json"))
                .ok()
                .and_then(|v| {
                    v.get("urlScheme")
                        .and_then(|s| s.as_str())
                        .map(str::to_lowercase)
                })
                .filter(|s| valid_scheme(s))
        })
        .as_deref()
}

fn valid_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '-' | '.'))
}

/// Whether a command-line argument is a link to the IDE (`<scheme>://…`).
pub fn is_link(arg: &str) -> bool {
    scheme().is_some_and(|s| is_link_for(arg, s))
}

fn is_link_for(arg: &str, scheme: &str) -> bool {
    // `get`, not a slice: a path like `acmé.txt` has no character boundary there (a panic at
    // start, from a file name on the command line).
    arg.len() > scheme.len() + 3
        && arg
            .get(..scheme.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(scheme))
        && arg[scheme.len()..].starts_with("://")
}

/// Registers the scheme for the current user, pointing at this program (Windows; once per start,
/// only when it points elsewhere or nowhere). Errors are only logged by the caller.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };
    let Some(scheme) = scheme() else {
        return Ok(());
    };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // `--` first (as VS Code's `--open-url --`): a program that hands over a link with a raw `"`
    // in it would otherwise let the link's text add flags (`--run-test-script`, `--user-data-dir`).
    let command = format!("\"{}\" -- \"%1\"", exe.display());
    let base = format!("Software\\Classes\\{scheme}");
    let open = format!("{base}\\shell\\open\\command");

    // SAFETY: plain registry calls with owned UTF-16 strings that outlive each call; every key
    // opened here is closed before returning.
    unsafe {
        // Already this program's: nothing to write.
        let mut buf = [0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let current = RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(open.as_str()),
            None,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        );
        if current.is_ok() {
            let len = (size as usize / 2).saturating_sub(1).min(buf.len());
            if String::from_utf16_lossy(&buf[..len]).eq_ignore_ascii_case(&command) {
                return Ok(());
            }
        }
        let set = |path: &str, name: Option<&str>, value: &str| -> Result<(), String> {
            let mut key = HKEY::default();
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(path),
                None,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE | KEY_READ,
                None,
                &mut key,
                None,
            )
            .ok()
            .map_err(|e| e.to_string())?;
            let data: Vec<u8> = value
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            let name = name.map(HSTRING::from);
            let result = RegSetValueExW(
                key,
                name.as_ref().map_or(windows::core::PCWSTR::null(), |n| {
                    windows::core::PCWSTR(n.as_ptr())
                }),
                None,
                REG_SZ,
                Some(&data),
            );
            let _ = RegCloseKey(key);
            result.ok().map_err(|e| e.to_string())
        };
        let name = product_name();
        set(&base, None, &format!("URL:{name}"))?;
        set(&base, Some("URL Protocol"), "")?;
        set(&open, None, &command)?;
    }
    Ok(())
}

#[cfg(windows)]
fn product_name() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../product.json"))
        .ok()
        .and_then(|v| {
            v.get("nameShort")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "IDE".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_the_scheme_and_more() {
        assert!(is_link_for("acme://pub.ext/open?x=1", "acme"));
        assert!(is_link_for("ACME://pub.ext", "acme"));
        assert!(!is_link_for("acme://", "acme"));
        assert!(!is_link_for("acmex://pub.ext", "acme"));
        assert!(!is_link_for("C:\\acme\\file.txt", "acme"));
        assert!(!is_link_for("acmé-notes.txt", "acme"));
        assert!(valid_scheme("acme-ide"));
        assert!(!valid_scheme("1acme"));
        assert!(!valid_scheme("ac me"));
    }
}
