//! The wire's frame, both directions:
//! `[u32 LE header length][u32 LE body length][header: UTF-8 JSON][body: raw bytes]`.
//! The body is empty for ordinary messages. A header over 64 MiB or a body over 1 GiB is a
//! protocol error: the connection closes.

use std::io::{self, Read, Write};

pub const MAX_HEADER: u32 = 64 * 1024 * 1024;
pub const MAX_BODY: u32 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub header: Vec<u8>,
    pub body: Vec<u8>,
}

fn too_large(what: &str, length: u32, max: u32) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("a frame's {what} is {length} bytes (the limit is {max})"),
    )
}

/// Reads exactly `length` bytes, growing the buffer as they arrive (a length that lies costs
/// nothing up front).
fn read_exactly(reader: &mut impl Read, length: u32) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let read = reader.take(u64::from(length)).read_to_end(&mut bytes)?;
    if read as u64 != u64::from(length) {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(bytes)
}

/// The next frame; `None` when the stream ended cleanly between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut prefix = [0u8; 8];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let header_length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    let body_length = u32::from_le_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]);
    if header_length > MAX_HEADER {
        return Err(too_large("header", header_length, MAX_HEADER));
    }
    if body_length > MAX_BODY {
        return Err(too_large("body", body_length, MAX_BODY));
    }
    let header = read_exactly(reader, header_length)?;
    let body = read_exactly(reader, body_length)?;
    Ok(Some(Frame { header, body }))
}

/// Writes one frame (not flushed).
pub fn write_frame(writer: &mut impl Write, header: &[u8], body: &[u8]) -> io::Result<()> {
    let header_length = u32::try_from(header.len())
        .ok()
        .filter(|n| *n <= MAX_HEADER)
        .ok_or_else(|| too_large("header", u32::MAX, MAX_HEADER))?;
    let body_length = u32::try_from(body.len())
        .ok()
        .filter(|n| *n <= MAX_BODY)
        .ok_or_else(|| too_large("body", u32::MAX, MAX_BODY))?;
    writer.write_all(&header_length.to_le_bytes())?;
    writer.write_all(&body_length.to_le_bytes())?;
    writer.write_all(header)?;
    writer.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() -> io::Result<()> {
        let mut wire = Vec::new();
        write_frame(&mut wire, br#"{"id":1}"#, b"")?;
        write_frame(&mut wire, br#"{"id":2,"raw":true}"#, &[0, 1, 2, 255])?;
        assert_eq!(&wire[..8], &[8, 0, 0, 0, 0, 0, 0, 0]);
        let mut reader = wire.as_slice();
        assert_eq!(
            read_frame(&mut reader)?,
            Some(Frame {
                header: br#"{"id":1}"#.to_vec(),
                body: Vec::new()
            })
        );
        assert_eq!(
            read_frame(&mut reader)?,
            Some(Frame {
                header: br#"{"id":2,"raw":true}"#.to_vec(),
                body: vec![0, 1, 2, 255]
            })
        );
        assert_eq!(read_frame(&mut reader)?, None);
        Ok(())
    }

    #[test]
    fn a_stream_cut_inside_a_frame_is_an_error() {
        let mut wire = Vec::new();
        assert!(write_frame(&mut wire, br#"{"id":1}"#, b"abc").is_ok());
        for cut in [3, 8, 10, wire.len() - 1] {
            let mut reader = &wire[..cut];
            let error = read_frame(&mut reader).err().map(|e| e.kind());
            assert_eq!(error, Some(io::ErrorKind::UnexpectedEof), "cut at {cut}");
        }
    }

    #[test]
    fn oversized_frames_are_refused() {
        let mut header_too_long = (MAX_HEADER + 1).to_le_bytes().to_vec();
        header_too_long.extend_from_slice(&0u32.to_le_bytes());
        let error = read_frame(&mut header_too_long.as_slice())
            .err()
            .map(|e| e.kind());
        assert_eq!(error, Some(io::ErrorKind::InvalidData));
        let mut body_too_long = 2u32.to_le_bytes().to_vec();
        body_too_long.extend_from_slice(&(MAX_BODY + 1).to_le_bytes());
        let error = read_frame(&mut body_too_long.as_slice())
            .err()
            .map(|e| e.kind());
        assert_eq!(error, Some(io::ErrorKind::InvalidData));
    }
}
