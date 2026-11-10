//! The remote protocol's framing (docs/remote.md): a 4-byte big-endian length, then that many
//! bytes of UTF-8 JSON. Also the framing between a window and its relay processes (`relay.rs`).

use std::io::{ErrorKind, Read, Write};

/// A frame over this is a protocol error (the server's limit too).
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// The next frame's bytes; None at a clean end of input (between frames).
pub fn read_frame(reader: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match reader.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(std::io::Error::new(ErrorKind::UnexpectedEof, "cut frame")),
            Ok(n) => got += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_be_bytes(head) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            format!("a frame of {len} bytes is over the limit"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one frame (length and body together, then flushes).
pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    if body.len() > MAX_FRAME {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "the message is too large to send",
        ));
    }
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    writer.write_all(&out)?;
    writer.flush()
}

/// `value` as one frame.
pub fn write_json(writer: &mut impl Write, value: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    write_frame(writer, &body)
}

/// The next frame as JSON; None at the end. A frame that isn't JSON is an error here (the
/// connection skips such frames itself).
pub fn read_json(reader: &mut impl Read) -> std::io::Result<Option<serde_json::Value>> {
    match read_frame(reader)? {
        None => Ok(None),
        Some(body) => serde_json::from_slice(&body)
            .map(Some)
            .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let mut buf = Vec::new();
        write_json(&mut buf, &serde_json::json!({ "id": 1, "method": "hello" })).unwrap();
        write_frame(&mut buf, b"").unwrap();
        assert_eq!(&buf[..4], &[0, 0, 0, 25]);
        let mut r = std::io::Cursor::new(buf);
        let first = read_json(&mut r).unwrap().unwrap();
        assert_eq!(first["method"], "hello");
        assert_eq!(read_frame(&mut r).unwrap(), Some(Vec::new()));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn a_cut_or_oversized_frame_is_an_error() {
        let mut r = std::io::Cursor::new(vec![0, 0, 0, 9, b'{']);
        assert!(read_frame(&mut r).is_err());
        let mut r = std::io::Cursor::new(vec![0, 0]);
        assert!(read_frame(&mut r).is_err());
        let big = ((MAX_FRAME + 1) as u32).to_be_bytes();
        let mut r = std::io::Cursor::new(big.to_vec());
        assert!(read_frame(&mut r).is_err());
    }
}
