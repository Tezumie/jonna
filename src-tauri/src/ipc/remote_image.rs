//! Remote images for Markdown previews (D210): the page's CSP allows no remote images, so a
//! README's https:// badges and logos are fetched here and handed over as bytes (the preview
//! turns them into blob: URLs). Only https, only public hosts (no localhost or private
//! addresses: a README can't make the IDE probe the local network), at most 3 redirects each
//! checked the same way, 10 MB, 15 s, and the answer must be an image.

use std::net::IpAddr;
use std::time::Duration;

use tauri::ipc::Response;

use crate::error::{Error, Result};

const MAX_BYTES: usize = 10 * 1024 * 1024;

/// An address the preview may fetch: https, a name or a public IP.
pub fn allowed(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return public(ip);
    }
    let d = host.trim_end_matches('.').to_ascii_lowercase();
    !(d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local"))
}

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // "This network" (0.0.0.0/8: 0.0.0.0 reaches the machine itself on Linux and
                // macOS), multicast and reserved (224.0.0.0 and up).
                || a == 0
                || a >= 224
                || a == 100 && (b & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            // An IPv4 address carried inside an IPv6 one: mapped (::ffff:a.b.c.d), compatible
            // (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::) reach that
            // IPv4 host, so it's judged instead.
            let embedded = |hi: u16, lo: u16| {
                std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8)
            };
            let inner = if (seg[..5] == [0; 5] && (seg[5] == 0xffff || seg[5] == 0))
                || seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
            {
                Some(embedded(seg[6], seg[7]))
            } else if seg[0] == 0x2002 {
                Some(embedded(seg[1], seg[2]))
            } else {
                None
            };
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00
                // Link-local (fe80::/10) and the old site-local (fec0::/10).
                || (seg[0] & 0xffc0) == 0xfe80
                || (seg[0] & 0xffc0) == 0xfec0
                || inner.is_some_and(|v4| !public(IpAddr::V4(v4))))
        }
    }
}

/// Resolves names but drops private and loopback answers, so a public name that points at the
/// local network (DNS rebinding) can't be used to reach it either.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = format!("{}:0", name.as_str());
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(host)
                .await?
                .filter(|a| public(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err("only public addresses are fetched".into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .dns_resolver(std::sync::Arc::new(PublicOnly))
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 3 || !allowed(attempt.url()) {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// The image at `url` as bytes (its type is sniffed by the page).
#[tauri::command]
pub async fn remote_image(url: String) -> Result<Response> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if !allowed(&parsed) {
        return Err(Error::Invalid(format!(
            "{url}: only https images from public addresses are shown"
        )));
    }
    let mut response = client()
        .get(parsed)
        .header(reqwest::header::ACCEPT, "image/*")
        .send()
        .await
        .map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::Invalid(format!("{url}: {}", response.status())));
    }
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Some hosts send images as octet-stream; anything else (an HTML error page) isn't one.
    if !(kind.starts_with("image/")
        || kind.starts_with("application/octet-stream")
        || kind.is_empty())
    {
        return Err(Error::Invalid(format!("{url}: not an image ({kind})")));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| Error::Invalid(format!("{url}: {e}")))?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(Error::Invalid(format!("{url}: over 10 MB")));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::allowed;

    fn ok(u: &str) -> bool {
        allowed(&reqwest::Url::parse(u).unwrap())
    }

    #[test]
    fn only_public_https() {
        assert!(ok("https://q5js.org/q5js_logo.avif"));
        assert!(ok("https://img.shields.io/badge/x-y-blue"));
        assert!(!ok("http://q5js.org/a.png"));
        assert!(!ok("https://localhost/a.png"));
        assert!(!ok("https://app.localhost/a.png"));
        assert!(!ok("https://127.0.0.1/a.png"));
        assert!(!ok("https://10.0.0.5/a.png"));
        assert!(!ok("https://192.168.1.1/a.png"));
        assert!(!ok("https://169.254.169.254/latest"));
        assert!(!ok("https://[::1]/a.png"));
        assert!(!ok("https://[fd00::1]/a.png"));
        assert!(!ok("https://[::ffff:127.0.0.1]/a.png"));
        assert!(!ok("https://printer.local/a.png"));
        assert!(ok("https://8.8.8.8/a.png"));
    }

    #[test]
    fn embedded_and_reserved_addresses_are_refused() {
        assert!(!ok("https://0.0.0.0/a.png"));
        assert!(!ok("https://0.1.2.3/a.png"));
        assert!(!ok("https://224.0.0.1/a.png"));
        assert!(!ok("https://240.0.0.1/a.png"));
        assert!(!ok("https://[::127.0.0.1]/a.png"));
        assert!(!ok("https://[64:ff9b::10.0.0.5]/a.png"));
        assert!(!ok("https://[2002:c0a8:0101::1]/a.png"));
        assert!(!ok("https://[fec0::1]/a.png"));
        assert!(!ok("https://[ff02::1]/a.png"));
        assert!(ok("https://[64:ff9b::8.8.8.8]/a.png"));
        assert!(ok("https://[2606:4700::1111]/a.png"));
    }
}
