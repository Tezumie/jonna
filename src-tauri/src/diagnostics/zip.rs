//! A small zip writer for the problem report (D204): deflated entries, no folders, no zip64 (the
//! report is a few MB at most). flate2 is already a dependency (deflate and the CRC); a zip crate
//! would add a dozen more for what's about a hundred lines.

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use std::io::Write;

/// The archive's bytes for `(name, contents)` entries. Names are plain file names.
pub fn build(entries: &[(String, Vec<u8>)]) -> std::io::Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    // 1980-01-01 00:00, the zip epoch (the files' time doesn't matter here).
    let (time, date): (u16, u16) = (0, (1 << 5) | 1);
    for (name, data) in entries {
        let mut crc = Crc::new();
        crc.update(data);
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data)?;
        let packed = enc.finish()?;
        let offset = out.len() as u32;
        let name = name.as_bytes();
        let header = |sig: u32, central: bool| {
            let mut h: Vec<u8> = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes()); // made by
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // needed: 2.0
            h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend_from_slice(&8u16.to_le_bytes()); // deflate
            h.extend_from_slice(&time.to_le_bytes());
            h.extend_from_slice(&date.to_le_bytes());
            h.extend_from_slice(&crc.sum().to_le_bytes());
            h.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            if central {
                h.extend_from_slice(&0u16.to_le_bytes()); // comment
                h.extend_from_slice(&0u16.to_le_bytes()); // disk
                h.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
                h.extend_from_slice(&0u32.to_le_bytes()); // external attributes
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name);
            h
        };
        out.extend_from_slice(&header(0x0403_4b50, false));
        out.extend_from_slice(&packed);
        central.extend_from_slice(&header(0x0201_4b50, true));
    }
    let central_offset = out.len() as u32;
    let count = entries.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]); // disk numbers
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::build;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    fn u16_at(b: &[u8], i: usize) -> usize {
        u16::from_le_bytes([b[i], b[i + 1]]) as usize
    }
    fn u32_at(b: &[u8], i: usize) -> usize {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize
    }

    /// Reads the archive back through its central directory, as unzip does.
    #[test]
    fn entries_read_back() {
        let entries = vec![
            (
                "report.md".to_string(),
                b"# Problem\n\nIt broke.\n".repeat(50),
            ),
            ("screenshot.png".to_string(), vec![0u8, 1, 2, 3, 255]),
        ];
        let zip = build(&entries).expect("zip");
        let end = zip.len() - 22;
        assert_eq!(u32_at(&zip, end), 0x0605_4b50);
        assert_eq!(u16_at(&zip, end + 10), 2);
        let mut at = u32_at(&zip, end + 16);
        for (name, data) in &entries {
            assert_eq!(u32_at(&zip, at), 0x0201_4b50);
            let packed = u32_at(&zip, at + 20);
            let name_len = u16_at(&zip, at + 28);
            let local = u32_at(&zip, at + 42);
            assert_eq!(&zip[at + 46..at + 46 + name_len], name.as_bytes());
            let start = local + 30 + u16_at(&zip, local + 26);
            let mut text = Vec::new();
            DeflateDecoder::new(&zip[start..start + packed])
                .read_to_end(&mut text)
                .expect("inflate");
            assert_eq!(&text, data);
            at += 46 + name_len;
        }
    }
}
