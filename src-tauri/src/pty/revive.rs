//! Terminals that outlive a page reload (VS Code's process revival). The Rust side outlives the
//! webview: when the main page reloads, its terminals are detached rather than killed — their
//! output keeps being read into a ring of recent bytes — and the reloaded page reattaches each one
//! by id and key, getting the bytes it hasn't seen replayed. A terminal no page takes back within
//! the grace period is killed, so nothing is left running unseen. A real quit still ends them all.
//! Pure parts here (tested); the sessions themselves are in `mod.rs`.

use std::collections::VecDeque;
use std::time::Duration;

/// How long a detached terminal waits for a page to take it back before it's killed.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(60);

/// Recent output kept per terminal for a reattaching page (1 MiB: a few screens of a busy build,
/// far more than the 100 lines a page saves).
pub const RING_BYTES: usize = 1024 * 1024;

/// The last `capacity` bytes of a terminal's output, with absolute offsets: byte `n` is the n-th
/// byte the terminal ever printed. A page remembers the offset its saved screen reflects, and
/// gets exactly what came after it.
#[derive(Debug)]
pub struct Ring {
    bytes: VecDeque<u8>,
    capacity: usize,
    /// Offset just past the last byte (everything ever pushed).
    end: u64,
}

/// What a reattaching page is sent before the live output resumes.
#[derive(Debug, PartialEq, Eq)]
pub struct Replay {
    /// Offset of the first byte of `bytes`.
    pub from: u64,
    pub bytes: Vec<u8>,
    /// The bytes start exactly where the page's saved screen ended (it can draw that screen first
    /// and carry on). False: the page's offset is unknown or too old, and `bytes` starts at the
    /// first whole line kept instead (the page then draws only these).
    pub complete: bool,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            capacity: capacity.max(1),
            end: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.end += data.len() as u64;
        if data.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.capacity..]);
            return;
        }
        let overflow = (self.bytes.len() + data.len()).saturating_sub(self.capacity);
        self.bytes.drain(..overflow);
        self.bytes.extend(data);
    }

    /// Offset of the oldest byte kept.
    pub fn start(&self) -> u64 {
        self.end - self.bytes.len() as u64
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn end(&self) -> u64 {
        self.end
    }

    /// The bytes after `since` (a page's saved screen), or the whole lines kept when `since` is
    /// unknown or older than what's kept.
    pub fn replay(&self, since: Option<u64>) -> Replay {
        let start = self.start();
        if let Some(since) = since {
            if since >= start && since <= self.end {
                let skip = usize::try_from(since - start).unwrap_or(usize::MAX);
                return Replay {
                    from: since,
                    bytes: self.bytes.iter().skip(skip).copied().collect(),
                    complete: true,
                };
            }
        }
        // Nothing dropped yet: everything from the start. Otherwise from the first byte after a
        // line break, so the replay doesn't begin inside an escape sequence or a character.
        let skip = if start == 0 {
            0
        } else {
            self.bytes
                .iter()
                .position(|&b| b == b'\n')
                .map_or(self.bytes.len(), |i| i + 1)
        };
        Replay {
            from: start + skip as u64,
            bytes: self.bytes.iter().skip(skip).copied().collect(),
            complete: false,
        }
    }
}

/// Whether a detached terminal has waited out its grace period.
pub fn expired(detached_for: Option<Duration>, grace: Duration) -> bool {
    detached_for.is_some_and(|d| d >= grace)
}

/// The reattach key compared without stopping at the first difference.
pub fn same_key(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_last_bytes_with_their_offsets() {
        let mut ring = Ring::new(8);
        ring.push(b"abc");
        assert_eq!((ring.start(), ring.end()), (0, 3));
        ring.push(b"defgh");
        assert_eq!((ring.start(), ring.end()), (0, 8));
        ring.push(b"ij");
        assert_eq!((ring.start(), ring.end()), (2, 10));
        assert_eq!(ring.replay(Some(5)).bytes, b"fghij");
        // A chunk bigger than the ring keeps its tail.
        ring.push(b"0123456789");
        assert_eq!((ring.start(), ring.end()), (12, 20));
        assert_eq!(ring.replay(Some(12)).bytes, b"23456789");
    }

    #[test]
    fn a_page_gets_what_came_after_its_saved_screen() {
        let mut ring = Ring::new(64);
        ring.push(b"$ ls\r\na b\r\n$ ");
        let r = ring.replay(Some(6));
        assert!(r.complete);
        assert_eq!(r.from, 6);
        assert_eq!(r.bytes, b"a b\r\n$ ");
        // Up to date: nothing to replay, still complete.
        let r = ring.replay(Some(ring.end()));
        assert!(r.complete && r.bytes.is_empty());
        // No saved screen: all of it (nothing was dropped yet).
        let r = ring.replay(None);
        assert!(!r.complete);
        assert_eq!((r.from, r.bytes.len()), (0, 13));
        // An offset from another process (past the end): treated as unknown.
        assert!(!ring.replay(Some(1000)).complete);
    }

    #[test]
    fn an_old_offset_replays_whole_lines_only() {
        let mut ring = Ring::new(10);
        ring.push(b"line one\r\nline two\r\nend");
        // Kept: "two\r\nend" plus a partial line before it.
        let r = ring.replay(Some(0));
        assert!(!r.complete);
        assert_eq!(r.bytes, b"end");
        assert_eq!(r.from, ring.end() - 3);
        // No line break kept at all: nothing safe to replay.
        let mut long = Ring::new(4);
        long.push(b"abcdefgh");
        assert!(long.replay(None).bytes.is_empty());
    }

    #[test]
    fn orphans_expire_after_the_grace_period() {
        let grace = Duration::from_secs(60);
        assert!(!expired(None, grace));
        assert!(!expired(Some(Duration::from_secs(59)), grace));
        assert!(expired(Some(Duration::from_secs(60)), grace));
        assert!(same_key("a1b2", "a1b2"));
        assert!(!same_key("a1b2", "a1b3"));
        assert!(!same_key("a1b2", "a1b"));
    }
}
