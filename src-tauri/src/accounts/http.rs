//! How the account's server (and the sync service on it) is asked: one client that follows no
//! redirect, and replies read with a cap. A server that answers with "go there instead" or with
//! a body that never ends is then an error, not somewhere the session's token travels to or
//! memory that runs out.

use futures_util::{Stream, StreamExt};

/// The largest JSON reply any call has: a page of records carries about 5 MB, a team's
/// library a little more.
pub const JSON_CAP: usize = 16 * 1024 * 1024;

/// A client for the account's server: a redirect is handed back as the reply it is (a 3xx,
/// which every caller treats as a refusal) and never followed.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// `url` parsed, when a request may go there: https, or plain http to this computer itself.
/// Read as a URL is read, not by how the text starts: `http://127.0.0.1:80@elsewhere.example`
/// names `elsewhere.example` (what stands before the `@` is a sign-in name), so an address
/// with a name or password in it is refused whole.
pub fn secure_or_loopback(url: &str) -> Option<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match parsed.scheme() {
        "https" if parsed.host_str().is_some() => Some(parsed),
        "http" if loopback => Some(parsed),
        _ => None,
    }
}

/// Why a body wasn't read.
#[derive(Debug, PartialEq, Eq)]
pub enum BodyError {
    /// More than the cap (said up front, or arrived).
    TooLarge,
    /// The connection failed part-way.
    Broken(String),
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BodyError::TooLarge => f.write_str("the answer is larger than any answer should be"),
            BodyError::Broken(e) => f.write_str(e),
        }
    }
}

/// The pieces of `stream` laid end to end, stopping the moment they pass `cap`: a length the
/// sender stated (`declared`) above it is refused before a byte is read.
pub async fn collect_capped<S, B, E>(
    mut stream: S,
    declared: Option<u64>,
    cap: usize,
) -> Result<Vec<u8>, BodyError>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    if declared.is_some_and(|n| n > cap as u64) {
        return Err(BodyError::TooLarge);
    }
    let mut out = Vec::new();
    while let Some(piece) = stream.next().await {
        let piece = piece.map_err(|e| BodyError::Broken(e.to_string()))?;
        let piece = piece.as_ref();
        if out.len() + piece.len() > cap {
            return Err(BodyError::TooLarge);
        }
        out.extend_from_slice(piece);
    }
    Ok(out)
}

/// A reply's body, at most `cap` bytes of it.
pub async fn read_capped(reply: reqwest::Response, cap: usize) -> Result<Vec<u8>, BodyError> {
    let declared = reply.content_length();
    collect_capped(reply.bytes_stream(), declared, cap).await
}

/// A reply's body as JSON, at most `JSON_CAP` bytes of it.
pub async fn json_capped<T: serde::de::DeserializeOwned>(
    reply: reqwest::Response,
) -> Result<T, BodyError> {
    let bytes = read_capped(reply, JSON_CAP).await?;
    serde_json::from_slice(&bytes).map_err(|e| BodyError::Broken(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(sizes: &[usize]) -> impl Stream<Item = Result<Vec<u8>, String>> + Unpin {
        futures_util::stream::iter(
            sizes
                .iter()
                .map(|n| Ok(vec![7u8; *n]))
                .collect::<Vec<Result<Vec<u8>, String>>>(),
        )
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn a_body_is_read_up_to_its_cap_and_no_further() {
        // What fits is read whole, the cap itself included.
        assert_eq!(
            run(collect_capped(pieces(&[3, 4, 3]), None, 10)).map(|b| b.len()),
            Ok(10)
        );
        assert_eq!(
            run(collect_capped(pieces(&[]), Some(0), 10)).map(|b| b.len()),
            Ok(0)
        );
        // One byte more is refused, whatever length was stated.
        assert_eq!(
            run(collect_capped(pieces(&[3, 4, 4]), None, 10)),
            Err(BodyError::TooLarge)
        );
        assert_eq!(
            run(collect_capped(pieces(&[6, 6]), Some(4), 10)),
            Err(BodyError::TooLarge)
        );
        // A stated length above the cap is refused before anything is read.
        type Piece = std::task::Poll<Option<Result<Vec<u8>, String>>>;
        let never = futures_util::stream::poll_fn(|_| -> Piece { panic!("the body was read") });
        assert_eq!(
            run(collect_capped(never, Some(11), 10)),
            Err(BodyError::TooLarge)
        );
    }

    #[test]
    fn an_address_is_read_as_a_url_not_by_its_first_letters() {
        for ok in [
            "https://accounts.example.com",
            "https://accounts.example.com/x?y=1",
            "http://127.0.0.1:5000",
            "http://localhost/x",
            "http://[::1]:8080/",
        ] {
            assert!(secure_or_loopback(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://example.com",
            // What stands before the `@` is a name, the host comes after it.
            "http://127.0.0.1:80@evil.example",
            "http://localhost@evil.example/",
            "http://127.0.0.1:80:pw@evil.example",
            "https://github.com@evil.example/",
            "http://127.0.0.1.evil.example",
            "http://localhost.evil.example",
            "ftp://127.0.0.1/",
            "file:///etc/passwd",
            "127.0.0.1",
            "",
        ] {
            assert!(secure_or_loopback(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_connection_that_fails_part_way_is_an_error() {
        let broken = futures_util::stream::iter(vec![Ok(vec![1u8, 2]), Err("reset".to_string())]);
        assert_eq!(
            run(collect_capped(broken, None, 10)),
            Err(BodyError::Broken("reset".into()))
        );
    }

    /// One reply on a loopback port: `head` (status line and headers), then `body`.
    fn serve_once(head: &'static str, body: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn a_redirect_is_never_followed() {
        // Where the redirect points: reaching it fails the test.
        let elsewhere = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        elsewhere.set_nonblocking(true).unwrap();
        let target = elsewhere.local_addr().unwrap().port();
        let head: &'static str = Box::leak(
            format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_boxed_str(),
        );
        let base = serve_once(head, Vec::new());
        let reply = run(client().get(format!("{base}/api/me")).send()).unwrap();
        assert_eq!(reply.status().as_u16(), 302);
        assert!(
            elsewhere.accept().is_err(),
            "the redirect's target was asked"
        );
    }

    #[test]
    fn a_reply_larger_than_its_cap_is_refused() {
        let base = serve_once(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
            vec![b'a'; 5000],
        );
        let reply = run(client().get(&base).send()).unwrap();
        assert_eq!(run(read_capped(reply, 4096)), Err(BodyError::TooLarge));
        let base = serve_once(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
            b"{\"a\":1}".to_vec(),
        );
        let reply = run(client().get(&base).send()).unwrap();
        let json: serde_json::Value = run(json_capped(reply)).unwrap();
        assert_eq!(json["a"], 1);
    }
}
