//! The WebSocket carrier (`--listen-ws`): the same wire as the pipes and the TCP socket carry,
//! inside binary messages, so a page in a browser can be the host's client. A browser can open
//! nothing else to this computer.
//!
//! What a browser adds, and what is done about it:
//! - **Any page can try to connect.** The upgrade is refused unless the request's `Origin` is on
//!   the list the host was started with (`--allow-origin`), and the token in `$/hello` is still
//!   needed after that: the origin check alone would let every tab of an allowed site in.
//! - **A name that resolves to this computer** (DNS rebinding): the `Host` header must be a
//!   loopback address or `localhost`.
//! - A request with no `Origin` isn't a browser's page (a program on this computer): the token
//!   decides, as on the TCP carrier.
//!
//! Only what the wire needs of RFC 6455: binary messages (fragmented or not), ping answered,
//! close; a text message ends the connection. No extensions, no subprotocol. The handshake's
//! SHA-1 is written out here (it is a fixed part of the protocol, not a security measure), so
//! the host gains no dependency for it.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;

use super::server::Carrier;

/// The longest request head read before the upgrade (the request line and its headers).
const MAX_HEAD: usize = 16 * 1024;
/// How long a connection has to send its request head.
const HEAD_WITHIN: Duration = Duration::from_secs(5);
/// The most bytes one outgoing message carries: a large answer goes as several, so neither side
/// holds it twice.
const MESSAGE_BYTES: usize = 1024 * 1024;
/// The protocol's fixed string, appended to the client's key.
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// SHA-1 (FIPS 180-1) of `data`.
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());
    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// The `Sec-WebSocket-Accept` value for a client's key.
pub fn accept_key(key: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(sha1(format!("{key}{GUID}").as_bytes()))
}

/// A request head's parts that decide the upgrade.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Head {
    pub get: bool,
    pub upgrade: bool,
    pub version13: bool,
    pub key: Option<String>,
    pub origin: Option<String>,
    pub host: Option<String>,
}

/// Reads a request head (`GET … HTTP/1.1` and its headers, without the empty line).
pub fn parse_head(text: &str) -> Head {
    let mut lines = text.split("\r\n");
    let mut head = Head {
        get: lines
            .next()
            .map(|l| l.starts_with("GET ") && l.ends_with(" HTTP/1.1"))
            .unwrap_or(false),
        ..Head::default()
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "upgrade" => head.upgrade = value.eq_ignore_ascii_case("websocket"),
            "sec-websocket-version" => head.version13 = value == "13",
            "sec-websocket-key" => head.key = Some(value.to_string()),
            "origin" => head.origin = Some(value.to_string()),
            "host" => head.host = Some(value.to_string()),
            _ => {}
        }
    }
    head
}

/// Whether a `Host` header names this computer itself (with or without a port).
pub fn loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
            .map(|(name, _)| name)
            .unwrap_or(host)
    };
    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Why an upgrade is refused (None: it goes ahead). `allowed`: the origins a page may have.
pub fn refusal(head: &Head, allowed: &[String]) -> Option<&'static str> {
    if !head.get || !head.upgrade || !head.version13 || head.key.is_none() {
        return Some("not a WebSocket request");
    }
    if !head.host.as_deref().map(loopback_host).unwrap_or(false) {
        return Some("the Host header isn't this computer");
    }
    match &head.origin {
        Some(origin) if !allowed.iter().any(|a| a.eq_ignore_ascii_case(origin)) => {
            Some("this page's origin isn't allowed")
        }
        _ => None,
    }
}

/// Answers a new connection's upgrade request and returns its two ends as a carrier: bytes read
/// are the client's binary messages joined, bytes written go out as binary messages.
pub fn accept(stream: TcpStream, allowed: &[String]) -> io::Result<Carrier> {
    let _ = stream.set_nodelay(true);
    let mut input = stream.try_clone()?;
    input.set_read_timeout(Some(HEAD_WITHIN))?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // One byte at a time: nothing behind the head may be taken (the first message follows it).
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head too long",
            ));
        }
        if input.read(&mut byte)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head[..head.len() - 4]).into_owned();
    let parsed = parse_head(&text);
    let mut output = stream.try_clone()?;
    if let Some(why) = refusal(&parsed, allowed) {
        let _ = output.write_all(
            format!(
                "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{why}",
                why.len()
            )
            .as_bytes(),
        );
        let _ = stream.shutdown(Shutdown::Both);
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
    }
    let key = parsed.key.unwrap_or_default();
    output.write_all(
        format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            accept_key(&key)
        )
        .as_bytes(),
    )?;
    // On both handles: Windows keeps the wait with the handle it was set through.
    stream.set_read_timeout(None)?;
    input.set_read_timeout(None)?;
    let out = Arc::new(Mutex::new(output));
    Ok(Carrier {
        reader: Box::new(MessageReader {
            input,
            out: out.clone(),
            left: 0,
            mask: [0; 4],
            at: 0,
            ended: false,
        }),
        writer: Box::new(MessageWriter { out }),
        hang_up: Box::new(move || {
            let _ = stream.shutdown(Shutdown::Both);
        }),
    })
}

/// One frame's first bytes for a payload of `len` bytes (the host's frames carry no mask).
pub fn frame_start(opcode: u8, len: usize) -> Vec<u8> {
    let mut start = vec![0x80 | opcode];
    if len < 126 {
        start.push(len as u8);
    } else if len <= usize::from(u16::MAX) {
        start.push(126);
        start.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        start.push(127);
        start.extend_from_slice(&(len as u64).to_be_bytes());
    }
    start
}

fn send(out: &Mutex<TcpStream>, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut out = out
        .lock()
        .map_err(|_| io::Error::other("the connection's writer failed"))?;
    out.write_all(&frame_start(opcode, payload.len()))?;
    out.write_all(payload)
}

const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;
const PING: u8 = 0x9;
const PONG: u8 = 0xA;

struct MessageWriter {
    out: Arc<Mutex<TcpStream>>,
}

impl Write for MessageWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let part = &bytes[..bytes.len().min(MESSAGE_BYTES)];
        if !part.is_empty() {
            send(&self.out, BINARY, part)?;
        }
        Ok(part.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.out
            .lock()
            .map_err(|_| io::Error::other("the connection's writer failed"))?
            .flush()
    }
}

struct MessageReader {
    input: TcpStream,
    /// For the answers a reader owes (a pong, the close).
    out: Arc<Mutex<TcpStream>>,
    /// What is left of the data frame being read.
    left: u64,
    mask: [u8; 4],
    /// How far into the frame's payload the mask has turned.
    at: usize,
    ended: bool,
}

impl MessageReader {
    /// Reads frame headers until one carries data (then `left` > 0), or the client closed.
    fn next_data_frame(&mut self) -> io::Result<()> {
        loop {
            let mut start = [0u8; 2];
            self.input.read_exact(&mut start)?;
            let opcode = start[0] & 0x0F;
            // A client's frames are masked, always: one that isn't is no browser's.
            if start[1] & 0x80 == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "an unmasked frame",
                ));
            }
            let len = match start[1] & 0x7F {
                126 => {
                    let mut b = [0u8; 2];
                    self.input.read_exact(&mut b)?;
                    u64::from(u16::from_be_bytes(b))
                }
                127 => {
                    let mut b = [0u8; 8];
                    self.input.read_exact(&mut b)?;
                    u64::from_be_bytes(b)
                }
                n => u64::from(n),
            };
            self.input.read_exact(&mut self.mask)?;
            self.at = 0;
            match opcode {
                // A binary message, or more of one.
                0x0 | BINARY => {
                    if len > 0 {
                        self.left = len;
                        return Ok(());
                    }
                }
                CLOSE | PING | PONG => {
                    // Control frames are at most 125 bytes.
                    if len > 125 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "a long control frame",
                        ));
                    }
                    let mut payload = vec![0u8; len as usize];
                    self.input.read_exact(&mut payload)?;
                    for (i, b) in payload.iter_mut().enumerate() {
                        *b ^= self.mask[i % 4];
                    }
                    match opcode {
                        PING => send(&self.out, PONG, &payload)?,
                        CLOSE => {
                            let _ = send(&self.out, CLOSE, &[]);
                            self.ended = true;
                            return Ok(());
                        }
                        _ => {}
                    }
                }
                // Text has no place on this wire.
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "not a binary message",
                    ))
                }
            }
        }
    }
}

impl Read for MessageReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.left == 0 && !self.ended {
            self.next_data_frame()?;
        }
        if self.ended {
            return Ok(0);
        }
        let want = buf
            .len()
            .min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let got = self.input.read(&mut buf[..want])?;
        if got == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        for b in &mut buf[..got] {
            *b ^= self.mask[self.at % 4];
            self.at = self.at.wrapping_add(1);
        }
        self.left -= got as u64;
        Ok(got)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn sha1_and_the_accept_key() {
        let hex = |d: [u8; 20]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(
            hex(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        // Longer than one block.
        assert_eq!(
            hex(sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // RFC 6455's own example.
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    fn head(origin: Option<&str>, host: &str) -> Head {
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        parse_head(&format!(
            "GET / HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n{origin}Sec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13"
        ))
    }

    #[test]
    fn only_an_allowed_page_on_this_computer_is_upgraded() {
        let allowed = vec!["https://app.example".to_string()];
        assert_eq!(
            refusal(&head(Some("https://app.example"), "127.0.0.1:9"), &allowed),
            None
        );
        assert_eq!(refusal(&head(None, "localhost:9"), &allowed), None);
        assert_eq!(refusal(&head(None, "[::1]:9"), &allowed), None);
        assert!(refusal(&head(Some("https://evil.example"), "127.0.0.1:9"), &allowed).is_some());
        assert!(refusal(&head(Some("null"), "127.0.0.1:9"), &allowed).is_some());
        // A name pointed at this computer.
        assert!(refusal(
            &head(Some("https://app.example"), "evil.example:9"),
            &allowed
        )
        .is_some());
        assert!(refusal(&parse_head("POST / HTTP/1.1\r\nHost: localhost"), &allowed).is_some());
        assert!(loopback_host("127.0.0.1") && loopback_host("LOCALHOST:80"));
        assert!(!loopback_host("127.0.0.1.evil.example") && !loopback_host("10.0.0.1:80"));
    }

    /// A client's masked frame.
    fn masked(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mask = [7u8, 11, 13, 17];
        let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        frame
    }

    #[test]
    fn messages_become_one_stream_both_ways() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .write_all(
                    format!("GET / HTTP/1.1\r\nHost: {address}\r\nOrigin: https://app.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
            let mut answer = Vec::new();
            let mut byte = [0u8; 1];
            while !answer.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                answer.push(byte[0]);
            }
            assert!(String::from_utf8_lossy(&answer).contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
            // A message in two fragments with a ping between, then a longer one, then close.
            stream.write_all(&masked(BINARY, false, b"he")).unwrap();
            stream.write_all(&masked(PING, true, b"p")).unwrap();
            stream.write_all(&masked(0x0, true, b"llo")).unwrap();
            stream
                .write_all(&masked(BINARY, true, &[9u8; 300]))
                .unwrap();
            stream.write_all(&masked(CLOSE, true, &[])).unwrap();
            // What the host sent: the pong, a binary message, the close.
            let mut got = Vec::new();
            let _ = stream.read_to_end(&mut got);
            got
        });
        let (stream, _) = listener.accept().unwrap();
        let mut carrier = accept(stream, &["https://app.example".to_string()]).unwrap();
        carrier.writer.write_all(b"answer").unwrap();
        let mut read = Vec::new();
        carrier.reader.read_to_end(&mut read).unwrap();
        assert_eq!(&read[..5], b"hello");
        assert_eq!(read.len(), 305);
        (carrier.hang_up)();
        let got = client.join().unwrap();
        let binary = [&[0x80 | BINARY, 6][..], b"answer"].concat();
        let pong = [0x80 | PONG, 1, b'p'];
        assert!(got.windows(binary.len()).any(|w| w == binary));
        assert!(got.windows(pong.len()).any(|w| w == pong));
    }

    #[test]
    fn a_page_of_another_origin_gets_no_stream() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .write_all(
                    format!("GET / HTTP/1.1\r\nHost: {address}\r\nOrigin: https://evil.example\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
            let mut got = String::new();
            let _ = stream.read_to_string(&mut got);
            got
        });
        let (stream, _) = listener.accept().unwrap();
        assert!(accept(stream, &["https://app.example".to_string()]).is_err());
        assert!(client.join().unwrap().starts_with("HTTP/1.1 403"));
    }
}
