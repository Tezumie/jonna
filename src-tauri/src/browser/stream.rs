//! Bodies the preview proxy passes through as they arrive instead of reading them whole:
//! - `HtmlInject`: a dev server's HTML with the bridge tag inserted after `<head…>`, sent on as
//!   soon as that point is known, so a page the server renders in pieces (streamed server
//!   rendering) shows while it loads, as in a browser;
//! - `RequestTap`: a request body (an upload, a form post) forwarded as it comes, with the first
//!   2 MB kept for the Network panel.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};

/// Past this much HTML without a `<head>`, the tag goes where `inject_tag` would put it anyway.
const HEAD_SEARCH_LIMIT: usize = 64 * 1024;

/// The end of the first `<name…>` start tag in `lower` (ASCII-lowercased HTML): `Ok(Some(end))`
/// after its `>`, `Ok(None)` when there is none, `Err(())` when the bytes so far end inside one
/// (or right after the name, so it may still turn out to be `<header`).
fn tag_end(lower: &[u8], name: &[u8]) -> Result<Option<usize>, ()> {
    let mut from = 0;
    while let Some(i) = find(&lower[from..], name) {
        let at = from + i;
        match lower.get(at + name.len()) {
            None => return Err(()),
            Some(b'>' | b' ' | b'\n' | b'\t' | b'\r' | b'/') => {
                return match find(&lower[at..], b">") {
                    Some(end) => Ok(Some(at + end + 1)),
                    None => Err(()),
                };
            }
            Some(_) => from = at + name.len(),
        }
    }
    Ok(None)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Where the bridge tag goes in the HTML received so far, or None while that isn't known yet.
/// `complete`: there is no more. The same places as `proxy::inject_tag`: after `<head…>`, else
/// after `<html…>`, else at the start — decided early once a `<body` shows that no `<head` comes.
pub fn insertion_point(html: &[u8], complete: bool) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    match tag_end(&lower, b"<head") {
        Ok(Some(end)) => return Some(end),
        Err(()) if !complete && html.len() < HEAD_SEARCH_LIMIT => return None,
        _ => {}
    }
    let body_started = matches!(tag_end(&lower, b"<body"), Ok(Some(_)) | Err(()));
    if !complete && !body_started && html.len() < HEAD_SEARCH_LIMIT {
        return None;
    }
    match tag_end(&lower, b"<html") {
        Ok(Some(end)) => Some(end),
        Err(()) if !complete && html.len() < HEAD_SEARCH_LIMIT => None,
        _ => Some(0),
    }
}

/// HTML passed on with `tag` inserted (see `insertion_point`); bytes are never re-encoded, so a
/// page in another charset stays as it was.
pub struct HtmlInject<B> {
    inner: B,
    tag: &'static str,
    buf: Vec<u8>,
    /// The tag is in: everything else passes straight through.
    passing: bool,
    /// The inner body ended and the buffer went out: nothing more.
    ended: bool,
}

impl<B> HtmlInject<B> {
    pub fn new(inner: B, tag: &'static str) -> Self {
        Self {
            inner,
            tag,
            buf: Vec::new(),
            passing: false,
            ended: false,
        }
    }

    fn flush(&mut self, at: usize) -> Bytes {
        let mut out = Vec::with_capacity(self.buf.len() + self.tag.len());
        out.extend_from_slice(&self.buf[..at]);
        out.extend_from_slice(self.tag.as_bytes());
        out.extend_from_slice(&self.buf[at..]);
        self.buf = Vec::new();
        self.passing = true;
        Bytes::from(out)
    }
}

impl<B> Body for HtmlInject<B>
where
    B: Body<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        let this = self.get_mut();
        if this.ended {
            return Poll::Ready(None);
        }
        loop {
            match Pin::new(&mut this.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Some(Err(e))),
                Poll::Ready(Some(Ok(frame))) => {
                    if this.passing {
                        return Poll::Ready(Some(Ok(frame)));
                    }
                    match frame.into_data() {
                        Ok(data) => {
                            this.buf.extend_from_slice(&data);
                            if let Some(at) = insertion_point(&this.buf, false) {
                                return Poll::Ready(Some(Ok(Frame::data(this.flush(at)))));
                            }
                        }
                        // Trailers before the tag went in: the HTML so far goes first.
                        Err(_trailers) => {
                            let at = insertion_point(&this.buf, true).unwrap_or(0);
                            return Poll::Ready(Some(Ok(Frame::data(this.flush(at)))));
                        }
                    }
                }
                Poll::Ready(None) => {
                    this.ended = true;
                    if this.passing {
                        return Poll::Ready(None);
                    }
                    let at = insertion_point(&this.buf, true).unwrap_or(0);
                    return Poll::Ready(Some(Ok(Frame::data(this.flush(at)))));
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.ended
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

/// The part of a request body kept for the network log (and whether it was cut short).
#[derive(Default)]
pub struct Kept {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

/// A request body forwarded as it arrives, the first `cap` bytes copied into `kept`.
pub struct RequestTap {
    inner: Incoming,
    kept: Arc<Mutex<Kept>>,
    cap: usize,
}

impl RequestTap {
    pub fn new(inner: Incoming, kept: Arc<Mutex<Kept>>, cap: usize) -> Self {
        Self { inner, kept, cap }
    }
}

impl Body for RequestTap {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled {
            if let Some(data) = frame.data_ref() {
                if let Ok(mut kept) = this.kept.lock() {
                    let room = this.cap.saturating_sub(kept.bytes.len());
                    if data.len() > room {
                        kept.truncated = true;
                    }
                    kept.bytes.extend_from_slice(&data[..data.len().min(room)]);
                }
            }
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use std::convert::Infallible;

    #[test]
    fn the_tag_goes_after_head_once_known() {
        assert_eq!(insertion_point(b"<!doctype html><html><he", false), None);
        assert_eq!(insertion_point(b"<html><head", false), None);
        assert_eq!(insertion_point(b"<html><head lang=x", false), None);
        assert_eq!(
            insertion_point(b"<html><HEAD lang=x><title>", false),
            Some(19)
        );
        // <header> isn't <head>; a <body> means no <head> is coming.
        assert_eq!(insertion_point(b"<html><body><header>", false), Some(6));
        assert_eq!(insertion_point(b"<p>hi", false), None);
        assert_eq!(insertion_point(b"<p>hi", true), Some(0));
        assert_eq!(insertion_point(b"<html lang=en><p>", true), Some(14));
        let long = vec![b'x'; HEAD_SEARCH_LIMIT];
        assert_eq!(insertion_point(&long, false), Some(0));
    }

    /// A body that yields these parts one by one.
    struct Parts(std::collections::VecDeque<&'static str>);

    impl Body for Parts {
        type Data = Bytes;
        type Error = Infallible;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
            Poll::Ready(
                self.0
                    .pop_front()
                    .map(|p| Ok(Frame::data(Bytes::from_static(p.as_bytes())))),
            )
        }
    }

    fn chunks(parts: &[&'static str]) -> HtmlInject<Parts> {
        HtmlInject::new(Parts(parts.iter().copied().collect()), "<T>")
    }

    async fn frames(mut body: HtmlInject<Parts>) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(data) = frame.into_data() {
                out.push(String::from_utf8_lossy(&data).into_owned());
            }
        }
        out
    }

    #[tokio::test]
    async fn html_streams_after_the_head() {
        let out = frames(chunks(&[
            "<html><he",
            "ad><title>t</title>",
            "<body>part 1",
            "part 2",
        ]))
        .await;
        assert_eq!(
            out,
            vec!["<html><head><T><title>t</title>", "<body>part 1", "part 2"]
        );
        let out = frames(chunks(&["plain ", "text"])).await;
        assert_eq!(out, vec!["<T>plain text"]);
    }
}
