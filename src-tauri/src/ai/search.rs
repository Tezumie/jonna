//! Web search for the agent (`web.search`, the `web_search` tool): one request to the provider
//! the user chose — Brave Search, Tavily, Exa (each with a key stored in the secrets file, which
//! never leaves this side) or a self-hosted SearXNG (an address, no key). Results come back as
//! title, address and a short snippet, capped.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// What the agent's `web_search` asks for beyond the query (D320). Domains go to the providers
/// whose APIs take them (Tavily, Exa); Brave and SearXNG get them as `site:` in the query, which
/// the frontend writes. The frontend filters the results by domain for every provider too.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub include_domains: Vec<String>,
    pub exclude_domains: Vec<String>,
    /// The provider's thorough search where it has one (Tavily's advanced depth).
    pub deep: bool,
}

/// The JSON body of a Tavily or Exa search (the providers searched with a POST).
pub fn post_body(provider: &str, query: &str, count: usize, options: &SearchOptions) -> Value {
    match provider {
        "tavily" => {
            let mut body = json!({
                "query": query,
                "max_results": count,
                "search_depth": if options.deep { "advanced" } else { "basic" },
            });
            if !options.include_domains.is_empty() {
                body["include_domains"] = json!(options.include_domains);
            }
            if !options.exclude_domains.is_empty() {
                body["exclude_domains"] = json!(options.exclude_domains);
            }
            body
        }
        _ => {
            let mut body = json!({
                "query": query,
                "type": "auto",
                "numResults": count,
                "contents": { "highlights": { "maxCharacters": SNIPPET_CHARS } }
            });
            // Exa takes one of the two lists: the allowed domains when there are some (the
            // blocked ones are then filtered out of the results by the frontend).
            if !options.include_domains.is_empty() {
                body["includeDomains"] = json!(options.include_domains);
            } else if !options.exclude_domains.is_empty() {
                body["excludeDomains"] = json!(options.exclude_domains);
            }
            body
        }
    }
}

/// Most results asked for and returned.
pub const MAX_RESULTS: usize = 20;
/// Longest snippet kept (characters).
const SNIPPET_CHARS: usize = 400;

#[derive(Serialize, Debug, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// The secrets-file id of a provider's key (the frontend's `webSearchKeyId` matches).
pub fn key_id(provider: &str) -> String {
    format!("websearch.{provider}")
}

/// Whether the provider needs a key (SearXNG doesn't).
pub fn needs_key(provider: &str) -> bool {
    matches!(provider, "brave" | "tavily" | "exa")
}

/// HTML tags out, the common entities decoded, whitespace collapsed, capped.
fn clean(text: &str, cap: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > cap {
        let mut cut: String = collapsed.chars().take(cap).collect();
        cut.push('…');
        cut
    } else {
        collapsed
    }
}

fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// The results in a provider's answer: `list` is where they are, `snippet` the fields tried in
/// order for the text.
fn collect(list: Option<&Value>, snippet: &[&str], count: usize) -> Vec<SearchResult> {
    let Some(Value::Array(items)) = list else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let url = item.get("url")?.as_str()?.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return None;
            }
            let title = clean(&text_of(item.get("title")), 200);
            let text = snippet
                .iter()
                .map(|f| text_of(item.get(*f)))
                .find(|t| !t.trim().is_empty())
                .unwrap_or_default();
            Some(SearchResult {
                title: if title.is_empty() {
                    url.to_string()
                } else {
                    title
                },
                url: url.to_string(),
                snippet: clean(&text, SNIPPET_CHARS),
            })
        })
        .take(count)
        .collect()
}

/// Parses a provider's JSON answer.
pub fn parse(provider: &str, body: &Value, count: usize) -> Vec<SearchResult> {
    match provider {
        "brave" => collect(
            body.get("web").and_then(|w| w.get("results")),
            &["description", "extra_snippets"],
            count,
        ),
        "tavily" => collect(body.get("results"), &["content"], count),
        "exa" => collect(
            body.get("results"),
            &["highlights", "summary", "text"],
            count,
        ),
        "searxng" => collect(body.get("results"), &["content"], count),
        _ => Vec::new(),
    }
}

/// The SearXNG instance's search address: `<base>/search` unless the address already ends there.
pub fn searxng_endpoint(base: &str) -> Result<reqwest::Url> {
    let base = base.trim().trim_end_matches('/');
    let full = if base.ends_with("/search") {
        base.to_string()
    } else {
        format!("{base}/search")
    };
    let url = super::web::check_url(&full)?;
    Ok(url)
}

pub async fn search(
    client: &reqwest::Client,
    provider: &str,
    query: &str,
    count: usize,
    key: Option<String>,
    searxng_url: Option<&str>,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Err(Error::Invalid("the search query is empty".into()));
    }
    let count = count.clamp(1, MAX_RESULTS);
    let key = if needs_key(provider) {
        match key {
            Some(k) if !k.trim().is_empty() => Some(k),
            _ => {
                return Err(Error::Invalid(format!(
                    "no key stored for {provider} (Agent: set up web search)"
                )))
            }
        }
    } else {
        None
    };
    let key = key.unwrap_or_default();
    let request = match provider {
        "brave" => client
            .get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", query), ("count", &count.to_string())])
            .header("X-Subscription-Token", key),
        "tavily" => client
            .post("https://api.tavily.com/search")
            .bearer_auth(key)
            .json(&post_body(provider, query, count, options)),
        "exa" => client
            .post("https://api.exa.ai/search")
            .header("x-api-key", key)
            .json(&post_body(provider, query, count, options)),
        "searxng" => {
            let base = searxng_url
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| Error::Invalid("no SearXNG address set".into()))?;
            client
                .get(searxng_endpoint(base)?)
                .query(&[("q", query), ("format", "json")])
        }
        other => {
            return Err(Error::Invalid(format!(
                "unknown web search provider {other}"
            )))
        }
    };
    let response = request
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(super::http_error)?;
    let status = response.status();
    // SearXNG answers 403 when its json format is off (the default).
    if provider == "searxng" && status.as_u16() == 403 {
        return Err(Error::Ai(
            "SearXNG refused JSON results: enable the json format in its settings.yml (search: formats: [html, json])".into(),
        ));
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(Error::Ai(format!(
            "{provider} refused the request ({status}): check the key (Agent: set up web search)"
        )));
    }
    if !status.is_success() {
        return Err(super::error_body(response).await);
    }
    let text = response.text().await.map_err(super::http_error)?;
    let body: Value = serde_json::from_str(&text).map_err(|_| {
        Error::Ai(if provider == "searxng" {
            "SearXNG didn't answer with JSON: enable the json format in its settings.yml (search: formats: [html, json])".into()
        } else {
            format!("{provider} didn't answer with JSON")
        })
    })?;
    Ok(parse(provider, &body, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brave_results_lose_their_markup() {
        let body = json!({ "web": { "results": [
            { "title": "Rust <strong>book</strong>", "url": "https://doc.rust-lang.org/book/", "description": "The <strong>Rust</strong> &amp; you" },
            { "title": "No address" },
            { "title": "Bad scheme", "url": "javascript:alert(1)" }
        ]}});
        let r = parse("brave", &body, 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "Rust book");
        assert_eq!(r[0].snippet, "The Rust & you");
    }

    #[test]
    fn exa_uses_highlights_and_results_are_capped() {
        let body = json!({ "results": [
            { "title": "A", "url": "https://a.example", "highlights": ["one", "two"] },
            { "title": "", "url": "https://b.example", "text": "body" },
            { "title": "C", "url": "https://c.example" }
        ]});
        let r = parse("exa", &body, 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].snippet, "one two");
        assert_eq!(r[1].title, "https://b.example");
        let tavily = parse(
            "tavily",
            &json!({ "results": [{ "title": "T", "url": "https://t.example", "content": "x" }] }),
            5,
        );
        assert_eq!(tavily[0].snippet, "x");
    }

    #[test]
    fn long_snippets_are_cut() {
        let long = "word ".repeat(200);
        let body =
            json!({ "results": [{ "title": "L", "url": "https://l.example", "content": long }] });
        let r = parse("searxng", &body, 1);
        assert!(r[0].snippet.chars().count() <= SNIPPET_CHARS + 1);
        assert!(r[0].snippet.ends_with('…'));
    }

    #[test]
    fn domains_and_depth_go_in_the_body() {
        let options = SearchOptions {
            include_domains: vec!["docs.rs".into()],
            exclude_domains: vec!["spam.example".into()],
            deep: true,
        };
        let tavily = post_body("tavily", "q", 5, &options);
        assert_eq!(tavily["search_depth"], "advanced");
        assert_eq!(tavily["include_domains"], json!(["docs.rs"]));
        assert_eq!(tavily["exclude_domains"], json!(["spam.example"]));
        let exa = post_body("exa", "q", 5, &options);
        assert_eq!(exa["includeDomains"], json!(["docs.rs"]));
        assert!(exa.get("excludeDomains").is_none());
        let plain = post_body("tavily", "q", 5, &SearchOptions::default());
        assert_eq!(plain["search_depth"], "basic");
        assert!(plain.get("include_domains").is_none());
        let blocked = SearchOptions {
            exclude_domains: vec!["x.example".into()],
            ..SearchOptions::default()
        };
        assert_eq!(
            post_body("exa", "q", 5, &blocked)["excludeDomains"],
            json!(["x.example"])
        );
    }

    #[test]
    fn searxng_address() {
        assert_eq!(
            searxng_endpoint("http://localhost:8080/").unwrap().as_str(),
            "http://localhost:8080/search"
        );
        assert_eq!(
            searxng_endpoint("https://s.example/search")
                .unwrap()
                .as_str(),
            "https://s.example/search"
        );
        assert!(searxng_endpoint("file:///x").is_err());
        assert!(needs_key("brave") && !needs_key("searxng"));
        assert_eq!(key_id("exa"), "websearch.exa");
    }
}
