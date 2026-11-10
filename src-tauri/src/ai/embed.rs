//! Text embeddings for the codebase index (D227): the provider's OpenAI-compatible `/embeddings`
//! (Ollama serves one at `/v1/embeddings` too), with its key (which stays here). Anthropic has no
//! embeddings API.

use super::{error_body, http_error, openai_api, Provider, ProviderKind};
use crate::error::{Error, Result};

/// Texts per request: providers cap a batch (OpenAI: 2048 inputs); the caller sends fewer.
pub const MAX_INPUTS: usize = 256;

pub async fn embed(
    client: &reqwest::Client,
    provider: &Provider,
    key: Option<String>,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>> {
    if provider.effective_kind() == ProviderKind::Anthropic {
        return Err(Error::Invalid(
            "Anthropic has no embeddings API: pick an embedding model from another provider (Ollama's nomic-embed-text, OpenAI's text-embedding-3-small…)".into(),
        ));
    }
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    if inputs.len() > MAX_INPUTS {
        return Err(Error::Invalid(format!(
            "at most {MAX_INPUTS} texts per request"
        )));
    }
    let mut request = client
        .post(openai_api(&provider.base_url, "embeddings"))
        .json(&serde_json::json!({ "model": model, "input": inputs }))
        .timeout(std::time::Duration::from_secs(120));
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(k);
    }
    let response = request.send().await.map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: serde_json::Value = response.json().await.map_err(http_error)?;
    parse(&body, inputs.len())
}

/// `{ "data": [{ "index": 0, "embedding": [..] }, ..] }`, put back in the inputs' order.
pub fn parse(body: &serde_json::Value, expected: usize) -> Result<Vec<Vec<f32>>> {
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| Error::Invalid("the provider's answer has no embeddings".into()))?;
    let mut out: Vec<Option<Vec<f32>>> = vec![None; expected];
    for (i, item) in data.iter().enumerate() {
        let index = item
            .get("index")
            .and_then(|v| v.as_u64())
            .map_or(i, |v| v as usize);
        let vector: Vec<f32> = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| Error::Invalid("an embedding isn't a list of numbers".into()))?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as f32)
            .collect();
        if let Some(slot) = out.get_mut(index) {
            *slot = Some(vector);
        }
    }
    out.into_iter()
        .map(|v| v.ok_or_else(|| Error::Invalid("the provider left out some embeddings".into())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn embeddings_come_back_in_input_order() {
        let body = serde_json::json!({ "data": [
            { "index": 1, "embedding": [0.5, 1.0] },
            { "index": 0, "embedding": [1.0, 0.0] }
        ] });
        let v = parse(&body, 2).expect("parsed");
        assert_eq!(v, vec![vec![1.0, 0.0], vec![0.5, 1.0]]);
        assert!(parse(&serde_json::json!({ "data": [] }), 1).is_err());
        assert!(parse(&serde_json::json!({}), 1).is_err());
    }
}
