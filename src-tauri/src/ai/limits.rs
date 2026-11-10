//! What providers say about their limits (D201), read on this side so keys never reach the
//! webview:
//! - **Rate-limit headers** on each chat response. Anthropic: `anthropic-ratelimit-<bucket>-<limit
//!   | remaining | reset>` (buckets requests, tokens, input-tokens, output-tokens; reset is an
//!   RFC 3339 time). OpenAI and the servers that copy it (Groq, xAI, DeepSeek…):
//!   `x-ratelimit-<limit | remaining | reset>-<bucket>` (reset is a duration such as "6m0s").
//!   The last values seen per provider are kept in memory; nothing is invented when a provider
//!   sends none (Ollama, most local servers).
//! - **OpenRouter's key endpoint** (`GET /api/v1/key`): the key's credit limit, what it has used
//!   (in all, today, this week and month) and whether it's a free-tier key. The key's label is
//!   left out: it shows part of the key.

use serde::Serialize;
use serde_json::Value;

use super::{error_body, http_error, url};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LimitBucket {
    /// "requests", "tokens", "input-tokens", "output-tokens", or what the provider calls it.
    pub name: String,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    /// As the provider wrote it: an RFC 3339 time (Anthropic) or a duration like "6m0s" (OpenAI).
    pub reset: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    /// When the headers were read (ms since the epoch).
    pub observed_at: u64,
    pub buckets: Vec<LimitBucket>,
    /// The response's status (a 429 says the limit was hit).
    pub status: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    /// The key's credit limit in dollars (None: no limit set).
    pub limit: Option<f64>,
    pub usage: Option<f64>,
    pub remaining: Option<f64>,
    pub usage_daily: Option<f64>,
    pub usage_weekly: Option<f64>,
    pub usage_monthly: Option<f64>,
    /// How often the limit resets ("daily", "weekly", "monthly"; None: never).
    pub limit_reset: Option<String>,
    pub free_tier: Option<bool>,
}

/// The rate-limit buckets in a response's headers (names lowercased, in first-seen order).
pub fn parse_headers<'a>(
    headers: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<LimitBucket> {
    let mut out: Vec<LimitBucket> = Vec::new();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        let (bucket, field) = if let Some(rest) = name.strip_prefix("anthropic-ratelimit-") {
            match rest.rsplit_once('-') {
                Some((b, f)) => (b.to_string(), f.to_string()),
                None => continue,
            }
        } else if let Some(rest) = name.strip_prefix("x-ratelimit-") {
            match rest.split_once('-') {
                Some((f, b)) => (b.to_string(), f.to_string()),
                None => continue,
            }
        } else {
            continue;
        };
        if bucket.is_empty() || !matches!(field.as_str(), "limit" | "remaining" | "reset") {
            continue;
        }
        let value = value.trim();
        let i = match out.iter().position(|b| b.name == bucket) {
            Some(i) => i,
            None => {
                out.push(LimitBucket {
                    name: bucket,
                    ..LimitBucket::default()
                });
                out.len() - 1
            }
        };
        let b = &mut out[i];
        match field.as_str() {
            "limit" => b.limit = value.parse().ok(),
            "remaining" => b.remaining = value.parse().ok(),
            _ => b.reset = (!value.is_empty()).then(|| value.chars().take(64).collect()),
        }
    }
    out.retain(|b| b.limit.is_some() || b.remaining.is_some());
    out
}

/// The buckets of a response (empty when the provider sent none).
pub fn from_response(response: &reqwest::Response) -> Vec<LimitBucket> {
    parse_headers(
        response
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str(), v.to_str().ok()?))),
    )
}

/// OpenRouter's `/key` answer (`{ data: { limit, usage, limit_remaining, … } }`).
pub fn parse_credits(body: &Value) -> Option<Credits> {
    let d = body.get("data")?;
    if !d.is_object() {
        return None;
    }
    let n = |k: &str| d.get(k).and_then(Value::as_f64);
    Some(Credits {
        limit: n("limit"),
        usage: n("usage"),
        remaining: n("limit_remaining"),
        usage_daily: n("usage_daily"),
        usage_weekly: n("usage_weekly"),
        usage_monthly: n("usage_monthly"),
        limit_reset: d
            .get("limit_reset")
            .and_then(Value::as_str)
            .map(str::to_string),
        free_tier: d.get("is_free_tier").and_then(Value::as_bool),
    })
}

/// Whether the provider is OpenRouter (the only one with a key endpoint we read).
pub fn is_openrouter(base: &str) -> bool {
    base.contains("openrouter.ai")
}

pub async fn openrouter_credits(
    client: &reqwest::Client,
    base: &str,
    key: Option<String>,
) -> Result<Option<Credits>> {
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return Ok(None);
    };
    let b = base.trim_end_matches('/');
    let endpoint = if b.ends_with("/v1") {
        url(b, "key")
    } else {
        url(&url(b, "v1"), "key")
    };
    let response = client
        .get(endpoint)
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(parse_credits(&body))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anthropic_headers() {
        let b = parse_headers([
            ("anthropic-ratelimit-requests-limit", "50"),
            ("anthropic-ratelimit-requests-remaining", "49"),
            ("anthropic-ratelimit-requests-reset", "2026-10-24T12:00:30Z"),
            ("Anthropic-RateLimit-Input-Tokens-Limit", "30000"),
            ("anthropic-ratelimit-input-tokens-remaining", "29000"),
            ("content-type", "text/event-stream"),
            ("x-api-key", "never"),
        ]);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].name, "requests");
        assert_eq!(b[0].limit, Some(50));
        assert_eq!(b[0].remaining, Some(49));
        assert_eq!(b[0].reset.as_deref(), Some("2026-10-24T12:00:30Z"));
        assert_eq!(b[1].name, "input-tokens");
        assert_eq!(b[1].remaining, Some(29000));
    }

    #[test]
    fn openai_headers() {
        let b = parse_headers([
            ("x-ratelimit-limit-requests", "500"),
            ("x-ratelimit-remaining-requests", "499"),
            ("x-ratelimit-reset-requests", "120ms"),
            ("x-ratelimit-limit-tokens", "30000"),
            ("x-ratelimit-remaining-tokens", "abc"),
            ("x-ratelimit-reset-tokens", "6m0s"),
            // A reset alone isn't a limit.
            ("x-ratelimit-reset-other", "1s"),
        ]);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].name, "requests");
        assert_eq!(b[0].reset.as_deref(), Some("120ms"));
        assert_eq!(b[1].name, "tokens");
        assert_eq!(b[1].limit, Some(30000));
        assert_eq!(b[1].remaining, None);
    }

    #[test]
    fn no_headers() {
        assert!(parse_headers([("content-type", "application/json")]).is_empty());
    }

    #[test]
    fn credits() {
        let c = parse_credits(&json!({ "data": {
            "label": "sk-or-v1-abc...xyz",
            "limit": 20.0, "usage": 3.5, "limit_remaining": 16.5,
            "usage_daily": 0.25, "usage_weekly": 1, "usage_monthly": 3.5,
            "limit_reset": "monthly", "is_free_tier": false
        }}))
        .unwrap();
        assert_eq!(c.limit, Some(20.0));
        assert_eq!(c.remaining, Some(16.5));
        assert_eq!(c.usage_weekly, Some(1.0));
        assert_eq!(c.limit_reset.as_deref(), Some("monthly"));
        assert_eq!(c.free_tier, Some(false));
        let unlimited = parse_credits(&json!({ "data": { "limit": null, "usage": 0 } })).unwrap();
        assert_eq!(unlimited.limit, None);
        assert!(parse_credits(&json!({ "error": "x" })).is_none());
        assert!(serde_json::to_string(&c).unwrap().find("sk-or").is_none());
    }
}
