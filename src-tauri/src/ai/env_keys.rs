//! A model provider's API key from the environment, for the host without a window: a command
//! line agent is started from a shell, where `ANTHROPIC_API_KEY` and its like are how a key is
//! handed over. Only read when the secret store has no key for the provider (the app's own
//! store comes first), never written anywhere and never returned to the front end.
//!
//! A variable is used for a provider by its address, not by its name in the settings: the key
//! in `OPENAI_API_KEY` goes to api.openai.com and nowhere else, whatever a provider is called.
//! The desktop app doesn't read these (its keys are set in the app); see `ipc/agent.rs`.
#![cfg_attr(feature = "desktop", allow(dead_code))]

/// The variables of the providers people keep keys for in their shell: the API's host (a
/// subdomain counts) and the names to try, in order.
const VARIABLES: &[(&str, &[&str])] = &[
    ("api.anthropic.com", &["ANTHROPIC_API_KEY"]),
    ("api.openai.com", &["OPENAI_API_KEY"]),
    ("openrouter.ai", &["OPENROUTER_API_KEY"]),
    (
        "generativelanguage.googleapis.com",
        &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    ),
    ("api.x.ai", &["XAI_API_KEY"]),
    ("api.groq.com", &["GROQ_API_KEY"]),
    ("api.mistral.ai", &["MISTRAL_API_KEY"]),
    ("api.deepseek.com", &["DEEPSEEK_API_KEY"]),
    ("api.together.xyz", &["TOGETHER_API_KEY"]),
    ("api.fireworks.ai", &["FIREWORKS_API_KEY"]),
    ("api.cerebras.ai", &["CEREBRAS_API_KEY"]),
];

/// The host of a provider's base URL, lower-cased (no scheme, user, port or path).
fn host_of(base_url: &str) -> Option<String> {
    let rest = base_url.split_once("://").map_or(base_url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next()?.trim().to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// The key for the provider at `base_url` from `var` (the environment), when one of its
/// provider's variables is set and not empty.
pub fn key_for(base_url: &str, var: impl Fn(&str) -> Option<String>) -> Option<String> {
    let host = host_of(base_url)?;
    let (_, names) = VARIABLES
        .iter()
        .find(|(known, _)| host == *known || host.ends_with(&format!(".{known}")))?;
    names
        .iter()
        .filter_map(|name| var(name))
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

/// `key_for` over this process's environment.
pub fn from_environment(base_url: &str) -> Option<String> {
    key_for(base_url, |name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn a_key_goes_to_its_own_provider_only() {
        let vars = [
            ("ANTHROPIC_API_KEY", "sk-ant-1"),
            ("OPENAI_API_KEY", " sk-2 "),
            ("OPENROUTER_API_KEY", "sk-or-3"),
        ];
        let get = env(&vars);
        assert_eq!(
            key_for("https://api.anthropic.com", &get).as_deref(),
            Some("sk-ant-1")
        );
        assert_eq!(
            key_for("https://api.openai.com/v1", &get).as_deref(),
            Some("sk-2")
        );
        assert_eq!(
            key_for("https://openrouter.ai/api/v1", &get).as_deref(),
            Some("sk-or-3")
        );
        // Another address gets nothing, whatever it is called or looks like.
        assert_eq!(
            key_for("https://api.openai.com.evil.example/v1", &get),
            None
        );
        assert_eq!(key_for("https://evil.example/api.openai.com", &get), None);
        assert_eq!(
            key_for("https://api.openai.com@evil.example/v1", &get),
            None
        );
        assert_eq!(key_for("http://127.0.0.1:11434", &get), None);
        assert_eq!(key_for("", &get), None);
    }

    #[test]
    fn the_first_set_variable_wins_and_an_empty_one_is_not_a_key() {
        let url = "https://generativelanguage.googleapis.com/v1beta/openai";
        assert_eq!(
            key_for(url, env(&[("GOOGLE_API_KEY", "g"), ("GEMINI_API_KEY", "")])).as_deref(),
            Some("g")
        );
        assert_eq!(
            key_for(
                url,
                env(&[("GOOGLE_API_KEY", "g"), ("GEMINI_API_KEY", "m")])
            )
            .as_deref(),
            Some("m")
        );
        assert_eq!(key_for(url, env(&[])), None);
        // A subdomain of a provider's host is that provider; the port doesn't matter.
        assert_eq!(
            key_for(
                "https://eu.api.mistral.ai:443/v1",
                env(&[("MISTRAL_API_KEY", "k")])
            )
            .as_deref(),
            Some("k")
        );
    }
}
