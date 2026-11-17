//! Which project a folder is, across computers. With a git remote, the remote's address says
//! so: every form of one repository's address must give one name, so it is normalised first.

/// One repository's address in one form: lower-cased host and the path, with no scheme, user
/// name, password, port, trailing slash or `.git`. None for an address that only means
/// something on one computer (a local path, `file://`).
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        // A port, but not the colons inside an IPv6 address in brackets.
        let host = match host.rfind(':') {
            Some(at) if !host[at..].contains(']') => &host[..at],
            _ => host,
        };
        (host, path)
    } else if let Some((left, path)) = url.split_once(':') {
        // The short SSH form, `user@host:path`. A drive letter (`C:\repo`) is a local path.
        if left.len() == 1 || left.contains('/') || left.contains('\\') {
            return None;
        }
        (left.rsplit_once('@').map_or(left, |(_, h)| h), path)
    } else {
        return None;
    };
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{}/{}", host.to_ascii_lowercase(), path))
}

/// The address a folder's identity comes from, normalised: `origin`'s, else the first
/// remote's by name, among those that are an address anywhere but on this computer. None:
/// no git, or no such remote.
pub fn folder_remote(root: &std::path::Path) -> Option<String> {
    let remotes = crate::git::ops::remote_urls(root).unwrap_or_default();
    identity_remote(remotes.iter().map(|r| (r.name.as_str(), r.url.as_str())))
}

/// `folder_remote`'s choice among (name, address) pairs.
pub fn identity_remote<'a>(remotes: impl Iterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let mut named: Vec<(&str, &str)> = remotes.collect();
    // `origin` first, then by name.
    named.sort_by(|a, b| (a.0 != "origin", a.0).cmp(&(b.0 != "origin", b.0)));
    named.into_iter().find_map(|(_, url)| normalize_remote(url))
}

/// Whether a remote's address (`address`, as git or a share has it) names the repository a
/// folder is a clone of (`folder`: its identity remote, normalised, `folder_remote`). False
/// when either is missing or the address only means something on one computer.
pub fn same_remote(address: Option<&str>, folder: Option<&str>) -> bool {
    match (address.and_then(normalize_remote), folder) {
        (Some(address), Some(folder)) => address == folder,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_remote as n;
    use super::{identity_remote, same_remote};

    #[test]
    fn a_folder_is_the_shared_project_when_their_remotes_are_one_repository() {
        // The sharer's share says the HTTPS form; the reader cloned over SSH.
        let folder = identity_remote([("origin", "git@github.com:Owner/Repo")].into_iter());
        assert_eq!(folder.as_deref(), Some("github.com/Owner/Repo"));
        assert!(same_remote(
            Some("https://GitHub.com/Owner/Repo.git"),
            folder.as_deref()
        ));
        assert!(same_remote(
            Some("ssh://git@github.com:22/Owner/Repo.git"),
            folder.as_deref()
        ));
        assert!(!same_remote(
            Some("https://github.com/Owner/Other.git"),
            folder.as_deref()
        ));
        assert!(!same_remote(
            Some("https://gitlab.com/Owner/Repo.git"),
            folder.as_deref()
        ));
        // Either without a remote that is an address: never the same project.
        assert!(!same_remote(None, folder.as_deref()));
        assert!(!same_remote(Some("https://github.com/Owner/Repo"), None));
        assert!(!same_remote(None, None));
        assert!(!same_remote(Some("/srv/git/repo"), Some("/srv/git/repo")));
        assert!(!same_remote(Some("C:\\repos\\x"), Some("C:\\repos\\x")));
        assert!(!same_remote(Some("../repo"), Some("../repo")));
        assert!(!same_remote(Some(""), Some("")));
        // The folder's identity: origin, else the first by name that is an address.
        let pick = |remotes: &[(&str, &str)]| identity_remote(remotes.iter().copied());
        assert_eq!(
            pick(&[
                ("backup", "https://example.com/a/b"),
                ("origin", "git@github.com:Owner/Repo.git")
            ]),
            Some("github.com/Owner/Repo".into())
        );
        assert_eq!(
            pick(&[
                ("origin", "/srv/git/repo.git"),
                ("zeta", "https://example.com/z/z"),
                ("alpha", "https://example.com/a/b.git")
            ]),
            Some("example.com/a/b".into())
        );
        assert_eq!(pick(&[("origin", "/srv/git/repo.git")]), None);
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn every_form_of_one_repository_is_one_address() {
        let want = Some("github.com/Owner/Repo".to_string());
        for url in [
            "https://github.com/Owner/Repo.git",
            "https://github.com/Owner/Repo",
            "https://GitHub.com/Owner/Repo/",
            "https://user:secret@github.com:443/Owner/Repo.git",
            "git@github.com:Owner/Repo.git",
            "git@GITHUB.COM:Owner/Repo",
            "ssh://git@github.com/Owner/Repo.git",
            "ssh://git@github.com:22/Owner/Repo.git/",
            "git://github.com/Owner/Repo.git",
            "  https://github.com/Owner/Repo.git  ",
        ] {
            assert_eq!(n(url), want, "{url}");
        }
        assert_ne!(
            n("https://github.com/owner/repo"),
            want,
            "the path keeps its case"
        );
        assert_eq!(
            n("https://gitlab.example.com/group/sub/repo.git"),
            Some("gitlab.example.com/group/sub/repo".into())
        );
        assert_eq!(n("ssh://git@[::1]:2222/a/b.git"), Some("[::1]/a/b".into()));
    }

    #[test]
    fn an_address_on_one_computer_is_no_identity() {
        for url in [
            "",
            "/srv/git/repo.git",
            "../repo",
            "C:\\repos\\thing",
            "C:/repos/thing",
            "file:///srv/repo.git",
            "https://github.com",
            "host:",
        ] {
            assert_eq!(n(url), None, "{url}");
        }
    }
}
