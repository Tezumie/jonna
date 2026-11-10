//! `tcp.listening`: the TCP ports listening on this machine, from `/proc/net/tcp` and `tcp6`,
//! with the program listening when its `/proc/<pid>/fd` is readable (best effort: other users'
//! programs show without one).

use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Listening {
    pub port: u16,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
}

/// The kernel's LISTEN state in `/proc/net/tcp*`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LISTEN: &str = "0A";

/// The listening sockets in one `/proc/net/tcp` or `tcp6` table: `(host, port, inode)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_table(text: &str) -> Vec<(String, u16, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.get(3).copied() != Some(LISTEN) {
                return None;
            }
            let (addr, port) = fields.get(1)?.split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            let inode = fields.get(9)?.parse::<u64>().ok()?;
            Some((parse_addr(addr)?, port, inode))
        })
        .collect()
}

/// An address as the kernel prints it: each 32-bit word in the machine's byte order, in hex.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_addr(hex: &str) -> Option<String> {
    let word = |s: &str| u32::from_str_radix(s, 16).ok().map(u32::to_ne_bytes);
    match hex.len() {
        8 => Some(Ipv4Addr::from(word(hex)?).to_string()),
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word(hex.get(i * 8..i * 8 + 8)?)?);
            }
            let v6 = Ipv6Addr::from(bytes);
            // A v4 socket on a dual-stack listener reads better as v4.
            Some(match v6.to_ipv4_mapped() {
                Some(v4) => v4.to_string(),
                None => v6.to_string(),
            })
        }
        _ => None,
    }
}

/// The listeners, one per (port, host), sorted by port; `owners` maps socket inodes to
/// `(pid, program name)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn collect(tables: &[String], owners: &HashMap<u64, (u32, String)>) -> Vec<Listening> {
    let mut found: BTreeMap<(u16, String), Listening> = BTreeMap::new();
    for table in tables {
        for (host, port, inode) in parse_table(table) {
            let owner = owners.get(&inode);
            found
                .entry((port, host.clone()))
                .or_insert_with(|| Listening {
                    port,
                    host,
                    pid: owner.map(|o| o.0),
                    process: owner.map(|o| o.1.clone()),
                });
        }
    }
    found.into_values().collect()
}

/// `tcp.listening` on this machine.
pub fn listening() -> Vec<Listening> {
    #[cfg(target_os = "linux")]
    {
        let tables: Vec<String> = ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .collect();
        let wanted: std::collections::HashSet<u64> = tables
            .iter()
            .flat_map(|t| parse_table(t).into_iter().map(|(_, _, inode)| inode))
            .collect();
        collect(&tables, &socket_owners(&wanted))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

/// Socket inode → (pid, program) for the `wanted` inodes, from the `/proc/<pid>/fd` links this
/// user may read.
#[cfg(target_os = "linux")]
fn socket_owners(wanted: &std::collections::HashSet<u64>) -> HashMap<u64, (u32, String)> {
    let mut owners = HashMap::new();
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return owners;
    };
    for entry in procs.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let inode = target
                .to_str()
                .and_then(|t| t.strip_prefix("socket:["))
                .and_then(|t| t.strip_suffix(']'))
                .and_then(|t| t.parse::<u64>().ok());
            if let Some(inode) = inode.filter(|i| wanted.contains(i)) {
                let name = std::fs::read_to_string(entry.path().join("comm"))
                    .map(|n| n.trim().to_string())
                    .unwrap_or_default();
                owners.entry(inode).or_insert((pid, name));
            }
        }
    }
    owners
}

#[cfg(test)]
mod tests {
    use super::*;

    const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 77 1 0000000000000000 100 0 0 10 0
";
    const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0000000000000000 100 0 0 10 0
";

    #[test]
    fn parses_listening_sockets() {
        // The kernel prints words in the machine's byte order; these tables are little-endian.
        if cfg!(target_endian = "big") {
            return;
        }
        assert_eq!(
            parse_table(TCP),
            vec![("127.0.0.1".into(), 8080, 4242), ("0.0.0.0".into(), 22, 77)]
        );
        let owners = HashMap::from([(4242u64, (31u32, "python3".to_string()))]);
        let all = collect(&[TCP.to_string(), TCP6.to_string()], &owners);
        let summary: Vec<(u16, &str, Option<u32>)> = all
            .iter()
            .map(|l| (l.port, l.host.as_str(), l.pid))
            .collect();
        assert_eq!(
            summary,
            vec![
                (22, "0.0.0.0", None),
                (22, "::1", None),
                (8080, "127.0.0.1", Some(31)),
                (8081, "::", None),
            ]
        );
        assert_eq!(all[2].process.as_deref(), Some("python3"));
    }
}
