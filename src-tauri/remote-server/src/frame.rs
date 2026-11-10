//! Framing: a 4-byte big-endian length, then that many bytes of UTF-8 JSON (docs/remote.md).

use std::io::{self, Read, Write};

use crate::error::{Error, Result};

/// Larger messages end the connection: the length is most likely garbage (a shell profile
/// printing to standard output before the server started, say).
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// The next message, or None when the input ended cleanly between messages.
pub fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < len.len() {
        match input.read(&mut len[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(Error::Protocol("input ended inside a frame header".into())),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    let size = u32::from_be_bytes(len) as usize;
    if size > MAX_FRAME {
        return Err(Error::Protocol(format!(
            "a message of {size} bytes is over the limit"
        )));
    }
    let mut body = vec![0u8; size];
    input.read_exact(&mut body).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            Error::Protocol("input ended inside a message".into())
        } else {
            Error::Io(e)
        }
    })?;
    Ok(Some(body))
}

/// Writes one message (the caller flushes).
pub fn write_frame(output: &mut impl Write, body: &[u8]) -> io::Result<()> {
    let len = u32::try_from(body.len())
        .ok()
        .filter(|&n| n as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "message too large"))?;
    output.write_all(&len.to_be_bytes())?;
    output.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_ends_cleanly() -> Result<()> {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{\"id\":1}")?;
        write_frame(&mut buf, b"")?;
        assert_eq!(&buf[..4], &[0, 0, 0, 8]);
        let mut input = &buf[..];
        assert_eq!(read_frame(&mut input)?.as_deref(), Some(&b"{\"id\":1}"[..]));
        assert_eq!(read_frame(&mut input)?.as_deref(), Some(&b""[..]));
        assert!(read_frame(&mut input)?.is_none());
        Ok(())
    }

    #[test]
    fn refuses_truncated_and_oversized_frames() {
        let mut half: &[u8] = &[0, 0];
        assert!(matches!(read_frame(&mut half), Err(Error::Protocol(_))));
        let mut short: &[u8] = &[0, 0, 0, 5, b'a'];
        assert!(matches!(read_frame(&mut short), Err(Error::Protocol(_))));
        let mut huge: &[u8] = &[0xff, 0xff, 0xff, 0xff];
        assert!(matches!(read_frame(&mut huge), Err(Error::Protocol(_))));
    }
}
