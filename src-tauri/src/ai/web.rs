//! Fetching a web page for the agent's context (`@web`, the `web.fetch` command, D130): one GET,
//! redirects followed here (a few, each checked like the first address), the body capped, text
//! returned as is (the frontend turns HTML into text).
//!
//! Localhost and the local network are fetched on purpose: the agent reads the dev server it
//! works on. Link-local addresses are not (169.254.0.0/16, fe80::/10): nothing a developer
//! serves lives there, and a cloud machine's metadata service, which hands out its
//! credentials, does.

use crate::error::{Error, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

/// Most bytes read from a page (pages are trimmed to text afterwards, far below this).
pub const MAX_BYTES: usize = 3 * 1024 * 1024;

/// Most redirects followed for one page.
const MAX_REDIRECTS: usize = 5;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// Where the redirects ended.
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub text: String,
    /// The body was longer than the cap.
    pub truncated: bool,
}

/// Whether `ip` is link-local, also when it is an IPv4 address carried in an IPv6 one (mapped
/// `::ffff:a.b.c.d`, compatible `::a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`, 6to4 `2002:aabb:ccdd::`),
/// which reaches that IPv4 host.
pub fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            let embedded = |hi: u16, lo: u16| {
                Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8)
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
            (seg[0] & 0xffc0) == 0xfe80 || inner.is_some_and(|v4| v4.is_link_local())
        }
    }
}

/// Only http(s): no file://, data: or other schemes; and no link-local address.
pub fn check_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| Error::Invalid(format!("not a URL ({e}): {url}")))?;
    check_parsed(&parsed)?;
    Ok(parsed)
}

fn check_parsed(url: &reqwest::Url) -> Result<()> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(Error::Invalid(format!(
                "only http and https pages can be fetched, not {other}:"
            )))
        }
    }
    // An address written into the URL (the parser has already turned `0xa9fea9fe` and the
    // like into dotted form; IPv6 comes in brackets).
    let literal = url
        .host_str()
        .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok());
    if literal.is_some_and(link_local) {
        return Err(Error::Invalid(
            "link-local addresses (169.254.x.x, fe80::) aren't fetched".into(),
        ));
    }
    Ok(())
}

/// Resolves names but drops link-local answers, so a name that points at one can't be used to
/// reach it either (the address in a URL is checked by `check_url`).
struct NoLinkLocal;

impl reqwest::dns::Resolve for NoLinkLocal {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = format!("{}:0", name.as_str());
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(host)
                .await?
                .filter(|a| !link_local(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err("link-local addresses aren't fetched".into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The client pages are fetched with: no redirect is followed by it (`fetch` does, checking
/// each), names never resolve to a link-local address, and it keeps no cookies.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .dns_resolver(std::sync::Arc::new(NoLinkLocal))
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// Where a redirect answer leads: its `Location`, read against the address that sent it.
/// None when the answer isn't a redirect (or names nowhere): it is the page.
fn redirect_target(
    from: &reqwest::Url,
    status: u16,
    location: Option<&str>,
) -> Result<Option<reqwest::Url>> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    let Some(location) = location.map(str::trim).filter(|l| !l.is_empty()) else {
        return Ok(None);
    };
    let mut next = from
        .join(location)
        .map_err(|e| Error::Invalid(format!("the page redirects to a bad address ({e})")))?;
    check_parsed(&next)?;
    // A sign-in written into the first address (`https://me:secret@host/`) is for that host: a
    // relative `Location` inherits it, and it must not travel on to another one.
    if next.host_str() != from.host_str()
        || next.port_or_known_default() != from.port_or_known_default()
    {
        let _ = next.set_username("");
        let _ = next.set_password(None);
    }
    Ok(Some(next))
}

pub async fn fetch(url: &str, max_bytes: usize) -> Result<WebPage> {
    let mut url = check_url(url)?;
    let client = client();
    let mut hops = 0;
    // Each request carries only what is set here: no cookies and no header from the caller, so
    // nothing meant for one host reaches the next.
    let response = loop {
        let response = client
            .get(url.clone())
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (compatible; IDE agent fetch)",
            )
            .header(
                reqwest::header::ACCEPT,
                "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
            )
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(super::http_error)?;
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok());
        match redirect_target(&url, response.status().as_u16(), location)? {
            None => break response,
            Some(_) if hops >= MAX_REDIRECTS => {
                return Err(Error::Invalid(format!(
                    "the page redirects more than {MAX_REDIRECTS} times"
                )))
            }
            Some(next) => {
                hops += 1;
                url = next;
            }
        }
    };
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cap = max_bytes.min(MAX_BYTES);
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(super::http_error)?;
        let room = cap - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(WebPage {
        url: final_url,
        status,
        content_type,
        text: String::from_utf8_lossy(&body).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls() {
        assert!(check_url("https://example.com/a").is_ok());
        assert!(check_url(" http://localhost:3000 ").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("example.com").is_err());
    }

    #[test]
    fn link_local_addresses_are_refused_and_local_ones_are_not() {
        for bad in [
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.0.1:8080/",
            "http://[fe80::1]/",
            "http://[febf::1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:a9fe:a9fe]/",
            "http://[::169.254.169.254]/",
            "http://[64:ff9b::169.254.169.254]/",
            "http://[2002:a9fe:a9fe::1]/",
            // Other spellings of the same IPv4 address, as the URL parser reads them.
            "http://0xa9fea9fe/",
            "http://2852039166/",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        // A developer's own servers stay reachable.
        for fine in [
            "http://localhost:5173/",
            "http://127.0.0.1:3000/",
            "http://[::1]:8080/",
            "http://192.168.1.20/",
            "http://10.0.0.5/",
            "http://[fd00::1]/",
            "https://[2001:db8::1]/",
        ] {
            assert!(check_url(fine).is_ok(), "{fine}");
        }
    }

    #[test]
    fn redirects_are_checked_like_the_first_address() {
        let from = reqwest::Url::parse("https://me:secret@example.com/a/b").unwrap();
        let to = |status: u16, location: Option<&str>| redirect_target(&from, status, location);
        // Not a redirect, or one that names nowhere: the answer is the page.
        assert_eq!(to(200, Some("/x")).unwrap(), None);
        assert_eq!(to(404, None).unwrap(), None);
        assert_eq!(to(302, None).unwrap(), None);
        // The same host keeps its sign-in; another host never gets it.
        assert_eq!(
            to(302, Some("/login?next=1")).unwrap().unwrap().as_str(),
            "https://me:secret@example.com/login?next=1"
        );
        assert_eq!(
            to(301, Some("//other.example/x"))
                .unwrap()
                .unwrap()
                .as_str(),
            "https://other.example/x"
        );
        assert_eq!(
            to(307, Some("http://example.com/x"))
                .unwrap()
                .unwrap()
                .as_str(),
            "http://example.com/x"
        );
        assert_eq!(
            to(308, Some("http://localhost:3000/"))
                .unwrap()
                .unwrap()
                .as_str(),
            "http://localhost:3000/"
        );
        // Schemes and link-local addresses are refused at every hop.
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[fe80::1]/",
            "http://[::ffff:169.254.169.254]/",
        ] {
            assert!(to(302, Some(bad)).is_err(), "{bad}");
        }
    }

    /// A server on localhost that answers every request with `answer` (its `{port}` filled in).
    async fn serve(answer: &'static str) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let reply = if path == "/final" {
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\npage".to_string()
                } else {
                    answer.replace("{port}", &port.to_string())
                };
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn a_redirect_is_followed_on_localhost_and_stopped_at_a_link_local_address() {
        let ok = serve(
            "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let page = fetch(&format!("http://127.0.0.1:{ok}/start"), MAX_BYTES)
            .await
            .unwrap();
        assert_eq!(page.status, 200);
        assert_eq!(page.text, "page");
        assert_eq!(page.url, format!("http://127.0.0.1:{ok}/final"));
        let metadata = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let err = fetch(&format!("http://127.0.0.1:{metadata}/"), MAX_BYTES)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("link-local"), "{err}");
        let endless = serve(
            "HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let err = fetch(&format!("http://127.0.0.1:{endless}/"), MAX_BYTES)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("redirects more than"), "{err}");
    }
}
