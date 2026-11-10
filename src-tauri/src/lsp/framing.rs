//! LSP base protocol framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`.

use std::io::{BufRead, Read, Write};

/// Largest body accepted (same cap as the debug adapter's WebSocket frames). The length comes from
/// the server, and allocating whatever it says would abort the whole app on a garbage header.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// Reads one message body; Ok(None) at end of stream.
pub fn read_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            if length.is_some() {
                break;
            }
            continue; // stray blank line between messages
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    let n = length.unwrap_or(0);
    if n > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("message of {n} bytes is over the {MAX_MESSAGE}-byte limit"),
        ));
    }
    let mut body = vec![0u8; n];
    reader.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

pub fn write_message<W: Write>(writer: &mut W, body: &str) -> std::io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body.as_bytes())?;
    writer.flush()
}

/// The longest ndjson line kept; the rest of a longer one is skipped (a runaway process can't
/// fill the memory).
const MAX_LINE: u64 = 64 * 1024 * 1024;

/// Newline-delimited JSON: the next non-empty line (without its line ending). Bytes that aren't
/// UTF-8 are replaced (D202: a program printing binary doesn't end the stream).
pub fn read_line_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    read_line(reader, false)
}

/// A program's output line by line (the debugger's captured programs): every line, empty ones
/// too, without its line ending; the last one even without a line break.
pub fn read_output_line<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    read_line(reader, true)
}

/// A program's output as it comes (the debugger's captured programs): what the pipe has now, up
/// to 8 KB, line breaks kept, so a line without its end (a prompt) isn't held back. The start of
/// a UTF-8 character cut at the end waits in `carry` for the rest; at the end of the stream
/// whatever is left there comes out (replaced if it isn't UTF-8).
pub fn read_output_chunk<R: Read>(
    reader: &mut R,
    carry: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    let mut buf = [0u8; 8192];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if n == 0 {
            if carry.is_empty() {
                return Ok(None);
            }
            let rest = String::from_utf8_lossy(carry).into_owned();
            carry.clear();
            return Ok(Some(rest));
        }
        carry.extend_from_slice(buf.get(..n).unwrap_or_default());
        let ready = carry.len() - unfinished_char(carry);
        if ready == 0 {
            continue;
        }
        let text = String::from_utf8_lossy(carry.get(..ready).unwrap_or_default()).into_owned();
        carry.drain(..ready);
        return Ok(Some(text));
    }
}

/// How many bytes at the end of `bytes` begin a UTF-8 character whose other bytes haven't come.
fn unfinished_char(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(4) {
        let Some(&b) = bytes.get(bytes.len() - back) else {
            break;
        };
        if b & 0xC0 == 0x80 {
            continue; // a continuation byte: its lead is further back
        }
        let width = match b {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if back < width { back } else { 0 };
    }
    0
}

fn read_line<R: BufRead>(reader: &mut R, keep_empty: bool) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader
            .by_ref()
            .take(MAX_LINE)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            return Ok(None);
        }
        if line.last() != Some(&b'\n') && n as u64 == MAX_LINE {
            // Too long: skip to the end of the line.
            let mut rest = Vec::new();
            loop {
                rest.clear();
                let m = reader
                    .by_ref()
                    .take(1024 * 1024)
                    .read_until(b'\n', &mut rest)?;
                if m == 0 || rest.last() == Some(&b'\n') {
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim_end_matches(['\r', '\n']);
        if keep_empty || !trimmed.trim().is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
}

pub fn write_line_message<W: Write>(writer: &mut W, body: &str) -> std::io::Result<()> {
    // A message must be one line: escape any raw newline (valid JSON never has one outside strings,
    // and inside strings it would already be escaped).
    writer.write_all(body.replace('\n', " ").as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_messages_with_multibyte_text() {
        let mut buf = Vec::new();
        write_message(&mut buf, r#"{"a":"é"}"#).unwrap();
        write_message(&mut buf, "{}").unwrap();
        let mut reader = Cursor::new(buf);
        assert_eq!(
            read_message(&mut reader).unwrap().as_deref(),
            Some(r#"{"a":"é"}"#)
        );
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{}"));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn ndjson_lines() {
        let mut buf = Vec::new();
        write_line_message(&mut buf, "{\n\"a\": 1}").unwrap();
        write_line_message(&mut buf, "{}").unwrap();
        let mut reader = Cursor::new([b"\r\n".as_slice(), &buf].concat());
        assert_eq!(
            read_line_message(&mut reader).unwrap().as_deref(),
            Some("{ \"a\": 1}")
        );
        assert_eq!(
            read_line_message(&mut reader).unwrap().as_deref(),
            Some("{}")
        );
        assert_eq!(read_line_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn output_lines_keep_empty_ones_and_the_last_unfinished_one() {
        let mut reader = Cursor::new(b"a\r\n\nb\n  \nprompt> ".to_vec());
        let mut lines = Vec::new();
        while let Some(l) = read_output_line(&mut reader).unwrap() {
            lines.push(l);
        }
        assert_eq!(lines, ["a", "", "b", "  ", "prompt> "]);
    }

    /// A reader that hands out the given pieces one per read, as a pipe does.
    struct Pieces(Vec<Vec<u8>>);
    impl Read for Pieces {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            let piece = self.0.remove(0);
            buf[..piece.len()].copy_from_slice(&piece);
            Ok(piece.len())
        }
    }

    #[test]
    fn output_chunks_come_as_they_are_and_keep_characters_whole() {
        // "é" is C3 A9: cut between two reads, it waits for its second byte.
        let mut reader = Pieces(vec![
            b"Name? ".to_vec(),
            b"caf\xc3".to_vec(),
            b"\xa9\nok".to_vec(),
            b"\xe2\x82".to_vec(),
        ]);
        let mut carry = Vec::new();
        let mut chunks = Vec::new();
        while let Some(c) = read_output_chunk(&mut reader, &mut carry).unwrap() {
            chunks.push(c);
        }
        assert_eq!(chunks, ["Name? ", "caf", "é\nok", "\u{fffd}"]);
        assert_eq!(unfinished_char(b"a\xf0\x9f\x98"), 3);
        assert_eq!(unfinished_char(b"a\xf0\x9f\x98\x80"), 0);
        assert_eq!(unfinished_char(b"abc"), 0);
    }

    #[test]
    fn ndjson_lines_that_are_not_utf8() {
        let mut reader = Cursor::new(b"ok \xff\xfe\n{}\n".to_vec());
        assert_eq!(
            read_line_message(&mut reader).unwrap().as_deref(),
            Some("ok \u{fffd}\u{fffd}")
        );
        assert_eq!(
            read_line_message(&mut reader).unwrap().as_deref(),
            Some("{}")
        );
    }

    #[test]
    fn accepts_extra_headers_and_case() {
        let raw = "content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        let mut reader = Cursor::new(raw.as_bytes().to_vec());
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{}"));
    }

    #[test]
    fn rejects_huge_content_length() {
        let raw = "Content-Length: 99999999999999\r\n\r\n{}";
        let mut reader = Cursor::new(raw.as_bytes().to_vec());
        let err = read_message(&mut reader).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
