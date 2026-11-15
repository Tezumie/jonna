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

#[cfg(test)]
mod tests {
    use super::normalize_remote as n;

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
