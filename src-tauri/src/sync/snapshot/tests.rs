//! The snapshot tests: they cut across the parts (a repository made with git, then captured,
//! compared and restored), so they are kept together.

use std::path::{Path, PathBuf};

use super::capture::*;
use super::compare::*;
use super::git::*;
use super::manifest::*;
use super::paths::*;
use super::restore::*;
use crate::error::Error;
use crate::sync::chunks::{self, Stored};
use crate::sync::crypto::Keyring;

#[test]
fn the_stored_list_is_in_stable_parts() {
    assert_eq!(shard_count(0), 1);
    assert_eq!(shard_count(399), 1);
    assert_eq!(shard_count(900), 2);
    assert_eq!(shard_count(100_000), 256);
    assert_eq!(shard_count(10_000_000), 1024);
    // A path is always in the same part, whatever else is in the list.
    assert_eq!(shard_of("src/main.rs", 16), shard_of("src/main.rs", 16));
    assert!(shard_of("src/main.rs", 16) < 16);
    let spread: std::collections::HashSet<usize> = (0..200)
        .map(|i| shard_of(&format!("src/file{i}.rs"), 16))
        .collect();
    assert!(spread.len() > 8, "paths spread over the parts");
}

#[test]
fn a_folder_leaves_out_what_its_ignore_files_say() {
    let dir = std::env::temp_dir().join(format!("sync-ignore-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["src", "data", "node_modules/x", "logs"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    for (file, text) in [
        ("src/main.py", "print()"),
        ("data/big.bin", "x"),
        ("node_modules/x/index.js", "x"),
        ("logs/today.log", "x"),
        ("notes.txt", "x"),
        (".syncignore", "data/\n"),
        (".gitignore", "*.log\n"),
    ] {
        std::fs::write(dir.join(file), text).unwrap();
    }
    let files = folder_files(&dir);
    assert_eq!(
        files,
        [".gitignore", ".syncignore", "notes.txt", "src/main.py"]
    );
    let estimate = estimate(&dir).unwrap();
    assert_eq!((estimate.kind.as_str(), estimate.files), ("folder", 4));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A git repository of its own under the system's temp folder, with one commit.
fn repo(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sync-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]).unwrap();
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ] {
        git(&dir, &["config", key, value]).unwrap();
    }
    for (file, text) in files {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(&dir, &["add", "-A"]).unwrap();
    git(&dir, &["commit", "-q", "-m", "first"]).unwrap();
    dir
}

fn text(dir: &Path, file: &str) -> String {
    std::fs::read_to_string(dir.join(file)).unwrap()
}

#[test]
fn a_stash_takes_the_listed_files_and_leaves_what_syncignore_names() {
    let dir = repo(
        "stash-paths",
        &[
            ("a.txt", "a"),
            ("gone.txt", "gone"),
            ("local.cfg", "committed"),
            (".syncignore", "local.cfg\ndata/\n"),
        ],
    );
    // The user's own stash, made before: it must still be there afterwards.
    std::fs::write(dir.join("a.txt"), "earlier work").unwrap();
    git(&dir, &["stash", "push", "-q", "-m", "mine"]).unwrap();
    let mine = stashes(&dir);
    assert_eq!(mine.len(), 1);

    std::fs::write(dir.join("a.txt"), "changed").unwrap();
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    std::fs::write(dir.join("new file.txt"), "new").unwrap();
    std::fs::write(dir.join("*.txt"), "odd name").ok();
    std::fs::write(dir.join("local.cfg"), "edited here").unwrap();
    std::fs::create_dir_all(dir.join("data")).unwrap();
    std::fs::write(dir.join("data").join("x.bin"), "data").unwrap();

    let dirty = local_changes(&dir).unwrap();
    assert!(dirty.contains(&"a.txt".to_string()), "{dirty:?}");
    assert!(dirty.contains(&"new file.txt".to_string()), "{dirty:?}");
    assert!(!dirty
        .iter()
        .any(|p| p == "local.cfg" || p.starts_with("data")));

    let made = stash_paths(&dir, &dirty, None).unwrap();
    assert!(made.is_some());
    assert_eq!(stashes(&dir).len(), 2);
    // The listed files are back at the commit.
    assert_eq!(text(&dir, "a.txt"), "a");
    assert_eq!(text(&dir, "gone.txt"), "gone");
    assert!(!dir.join("new file.txt").exists());
    // What .syncignore names is exactly as it was.
    assert_eq!(text(&dir, "local.cfg"), "edited here");
    assert_eq!(text(&dir, "data/x.bin"), "data");
    assert!(local_changes(&dir).unwrap().is_empty());

    git(&dir, &["stash", "drop", "-q"]).unwrap();
    assert_eq!(stashes(&dir), mine);

    // Nothing to save: no stash is made, so there is none to drop.
    assert_eq!(
        stash_paths(&dir, &["a.txt".to_string()], None).unwrap(),
        None
    );
    assert_eq!(stash_paths(&dir, &[], None).unwrap(), None);
    assert_eq!(stashes(&dir), mine);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_error_after_a_stash_says_where_the_changes_are() {
    let dir = repo("stash-named", &[("a.txt", "a")]);
    std::fs::write(dir.join("a.txt"), "work").unwrap();
    let name = "Before continuing from the laptop";
    let commit = stash_paths(&dir, &["a.txt".to_string()], Some(name))
        .unwrap()
        .unwrap();
    // Another stash put on top (the other computer's): the name still finds the right one.
    std::fs::write(dir.join("a.txt"), "other").unwrap();
    git(&dir, &["stash", "push", "-q", "-m", "theirs"]).unwrap();
    let aside = Aside::Stash {
        name: name.to_string(),
        commit,
    };
    let note = aside.describe(&dir);
    assert!(note.contains(name) && note.contains("stash@{1}"), "{note}");
    match with_aside(Error::Sync("SyncMissing", "Part is missing.".into()), &note) {
        Error::Sync("SyncMissing", text) => {
            assert!(text.starts_with("Part is missing. ") && text.contains("stash@{1}"));
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(matches!(
        with_aside(Error::Git("checkout failed".into()), &note),
        Error::Git(text) if text.contains("checkout failed") && text.contains(name)
    ));
    let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked");
    assert!(matches!(
        with_aside(Error::Io(io), &note),
        Error::Sync("Sync", text) if text.contains("locked") && text.contains(name)
    ));
    git(&dir, &["stash", "pop", "-q", "stash@{1}"]).ok();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_is_compared_a_chunk_at_a_time() {
    let ring = Keyring::generate().unwrap();
    let stored = |data: &[u8]| Stored {
        chunks: data
            .chunks(8)
            .map(|piece| ring.chunk_id(piece).unwrap())
            .collect(),
        size: data.len() as u64,
    };
    let same = |data: &[u8], with: &Stored| {
        // One byte at a time: a short read is not the end of a chunk.
        struct Slow<'a>(&'a [u8]);
        impl std::io::Read for Slow<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.len().min(buf.len()).min(1);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        same_content(&ring, &mut Slow(data), with, &mut [0u8; 8]).unwrap()
    };
    for data in [&b""[..], b"short", b"exactly8", b"more than one chunk here"] {
        assert!(same(data, &stored(data)), "{data:?}");
    }
    assert!(!same(
        b"more than one chunk here",
        &stored(b"more than one chunk HERE")
    ));
    assert!(!same(b"exactly8", &stored(b"exactly8 and more")));
    assert!(!same(b"exactly8 and more", &stored(b"exactly8")));
    assert!(!same(b"", &stored(b"x")));
    assert!(!same(b"x", &stored(b"")));
}

/// A snapshot's entry for a file with this content.
fn entry(ring: &Keyring, path: &str, data: &[u8]) -> FileEntry {
    FileEntry {
        p: path.to_string(),
        s: Stored {
            chunks: data
                .chunks(chunks::CHUNK_BYTES)
                .map(|piece| ring.chunk_id(piece).unwrap())
                .collect(),
            size: data.len() as u64,
        },
        x: false,
        t: 0,
    }
}

#[test]
fn a_snapshot_is_compared_with_the_folder() {
    let ring = Keyring::generate().unwrap();
    let dir = std::env::temp_dir().join(format!("sync-compare-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("folder.txt")).unwrap();
    for (file, text) in [
        ("src/same.rs", "fn main() {}"),
        ("src/edited.rs", "fn main() { 1 }"),
        ("resized.txt", "longer than it was"),
        ("empty.txt", ""),
        ("still-here.txt", "x"),
    ] {
        std::fs::write(dir.join(file), text).unwrap();
    }
    let manifest = Manifest {
        v: 1,
        files: vec![
            entry(&ring, "src/same.rs", b"fn main() {}"),
            // The same size, other content: only the content tells.
            entry(&ring, "src/edited.rs", b"fn main() { 2 }"),
            entry(&ring, "resized.txt", b"short"),
            entry(&ring, "empty.txt", b""),
            entry(&ring, "not/here.txt", b"new"),
            entry(&ring, "folder.txt", b"a file there"),
            entry(&ring, "../outside.txt", b"x"),
        ],
        deleted: vec![
            "still-here.txt".into(),
            "gone.txt".into(),
            ".git/config".into(),
        ],
        ..Default::default()
    };
    let compared = compare(&ring, &dir, &manifest, COMPARE_MAX);
    assert_eq!(compared.truncated, 0);
    let got: Vec<(&str, Standing, bool)> = compared
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.state, f.deleted))
        .collect();
    assert_eq!(
        got,
        [
            ("../outside.txt", Standing::Unknown, false),
            (".git/config", Standing::Unknown, true),
            ("empty.txt", Standing::Same, false),
            ("folder.txt", Standing::Differs, false),
            ("gone.txt", Standing::Same, true),
            ("not/here.txt", Standing::Missing, false),
            ("resized.txt", Standing::Differs, false),
            ("src/edited.rs", Standing::Differs, false),
            ("src/same.rs", Standing::Same, false),
            ("still-here.txt", Standing::Differs, true),
        ]
    );
    let sizes: Vec<u64> = compared.files.iter().map(|f| f.size).collect();
    assert_eq!(sizes, [1, 0, 0, 12, 0, 3, 5, 15, 12, 0]);

    // Past the limit nothing is read: listed, not compared, and counted.
    let few = compare(&ring, &dir, &manifest, 3);
    assert_eq!(few.truncated, 7);
    assert_eq!(few.files.len(), 10);
    assert_eq!(few.files[2].state, Standing::Same);
    assert!(few.files[3..].iter().all(|f| f.state == Standing::Unknown));
    // As the front end reads it.
    let json = serde_json::to_value(&few.files[5]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "path": "not/here.txt", "size": 3, "deleted": false, "state": "unknown" })
    );
    assert_eq!(
        serde_json::to_value(Standing::Missing).unwrap(),
        serde_json::json!("missing")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_is_shown_as_text_only_when_it_is_text() {
    let text = as_text("héllo\r\nworld".as_bytes().to_vec());
    assert_eq!(text.text.as_deref(), Some("héllo\r\nworld"));
    assert_eq!((text.size, text.reason), (13, None));
    assert_eq!(as_text(Vec::new()).text.as_deref(), Some(""));
    for binary in [&[0xff, 0xfe, 0x00][..], b"text\0with a nul"] {
        let got = as_text(binary.to_vec());
        assert_eq!((got.text, got.reason), (None, Some("binary")));
    }
    let large = as_text(vec![b'a'; TEXT_MAX_BYTES as usize + 1]);
    assert_eq!((large.text, large.reason), (None, Some("large")));
    assert_eq!(large.size, TEXT_MAX_BYTES + 1);
    assert!(as_text(vec![b'a'; TEXT_MAX_BYTES as usize]).text.is_some());
    assert_eq!(
        serde_json::to_value(too_large(9)).unwrap(),
        serde_json::json!({ "text": null, "size": 9, "reason": "large" })
    );
}

#[test]
fn the_folder_for_replaced_files_is_never_shared() {
    let parent = std::env::temp_dir().join(format!("sync-replaced-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&parent);
    let first = fresh_dir(&parent, "1700000000").unwrap();
    let second = fresh_dir(&parent, "1700000000").unwrap();
    let third = fresh_dir(&parent, "1700000000").unwrap();
    assert_eq!(first, parent.join("1700000000"));
    assert_eq!(second, parent.join("1700000000-1"));
    assert_eq!(third, parent.join("1700000000-2"));
    assert!(first.is_dir() && second.is_dir() && third.is_dir());
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn only_an_ordinary_address_becomes_a_remote() {
    for ok in [
        "https://github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
        "ssh://git@example.com:22/a/b",
    ] {
        assert!(safe_remote(ok), "{ok}");
    }
    for bad in [
        "ext::sh -c 'touch x'",
        "--upload-pack=touch x",
        "/srv/repo.git",
        "\\\\server\\share\\repo",
        "file:///srv/repo.git",
        "C:\\repos\\x",
        "",
    ] {
        assert!(!safe_remote(bad), "{bad}");
    }
}

#[test]
fn a_manifest_path_stays_inside_the_project() {
    let root = Path::new("/project");
    assert_eq!(
        safe_join(root, "src/a.rs").unwrap(),
        root.join("src").join("a.rs")
    );
    assert!(safe_join(root, "../outside").is_err());
    assert!(safe_join(root, "a/../../b").is_err());
    assert!(safe_join(root, "/etc/passwd").is_err());
    assert!(safe_join(root, ".git/config").is_err());
    assert!(safe_join(root, ".GIT/hooks/pre-commit").is_err());
    assert!(safe_join(root, "").is_err());
    for bad in [
        "sub/.git/hooks/x",
        ".git./config",
        ".git /config",
        "GIT~1/config",
        "a/.GIT/x",
        "a:b",
        "name./x",
    ] {
        assert!(safe_join(root, bad).is_err(), "{bad}");
    }
    for bad in ["NUL", "con.txt", "sub/COM1", "lpt9.log", "Aux"] {
        assert!(safe_join(root, bad).is_err(), "{bad}");
    }
    assert!(safe_join(root, "console.log").is_ok());
    assert!(safe_join(root, "docs/.gitignore").is_ok());
    assert!(safe_join(root, ".github/workflows/ci.yml").is_ok());
    #[cfg(windows)]
    assert!(safe_join(root, "C:\\Windows\\x").is_err());
}

#[test]
fn a_snapshot_never_makes_the_folder_a_repository_of_its_own() {
    let parts = |paths: &[&str]| RepositoryParts::named(paths.iter().copied());
    // What git takes for a repository without a `.git`: HEAD beside objects and refs,
    // and the config it would then run programs from.
    assert!(parts(&["HEAD", "objects/ab/cd", "refs/heads/main"]).is_repository());
    assert!(parts(&["HEAD", "config"]).is_repository());
    assert!(parts(&["head", "Config", "a.txt"]).is_repository());
    assert!(parts(&["HEAD", "OBJECTS/x", "Refs/x", "hooks/pre-commit"]).is_repository());
    // Ordinary projects: one of the names alone, or the names deeper down.
    assert!(!parts(&["HEAD"]).is_repository());
    assert!(!parts(&["config", "objects/a", "refs/b"]).is_repository());
    assert!(!parts(&["HEAD", "objects", "refs"]).is_repository());
    assert!(!parts(&["sub/HEAD", "sub/config", "sub/objects/a", "sub/refs/b"]).any());
    assert!(!parts(&["HEAD/x", "config/y", "src/config", "headers.h"]).any());

    let root = std::env::temp_dir().join(format!("ide-snap-bare-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    // Refused whole, before anything is written.
    assert!(not_a_repository_of_its_own(&root, ["HEAD", "config", "a.txt"]).is_err());
    assert!(not_a_repository_of_its_own(&root, ["HEAD", "objects/x", "refs/heads/m"]).is_err());
    assert!(not_a_repository_of_its_own(&root, ["a.txt", "config", "src/HEAD"]).is_ok());
    assert!(not_a_repository_of_its_own(&root, ["HEAD"]).is_ok());
    // A piece at a time: what is in the folder already counts.
    std::fs::write(root.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    assert!(not_a_repository_of_its_own(&root, ["config"]).is_err());
    assert!(not_a_repository_of_its_own(&root, ["objects/x"]).is_ok());
    std::fs::create_dir_all(root.join("refs")).unwrap();
    assert!(not_a_repository_of_its_own(&root, ["objects/x"]).is_err());
    // A snapshot that names none of them is not refused for what the folder has.
    std::fs::write(root.join("config"), "").unwrap();
    assert!(not_a_repository_of_its_own(&root, ["a.txt", "src/b.rs"]).is_ok());
    let _ = std::fs::remove_dir_all(&root);
}

/// A link at `link` to the folder `to`: a symbolic link, or on Windows a junction (which
/// needs no privilege). False when none could be made.
fn link_dir(to: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(to, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(to)
            .output()
            .is_ok_and(|out| out.status.success())
    }
}

#[test]
fn a_resolved_path_must_stay_under_names_a_snapshot_may_name() {
    let root = Path::new("/home/me/project");
    assert!(names_inside(root, root));
    assert!(names_inside(root, &root.join("src").join("deep")));
    // Resolved into the repository's own folder, under any spelling of its name.
    assert!(!names_inside(root, &root.join(".git")));
    assert!(!names_inside(root, &root.join(".git").join("hooks")));
    assert!(!names_inside(root, &root.join(".GIT")));
    assert!(!names_inside(root, &root.join("sub").join("GIT~1")));
    assert!(!names_inside(root, &root.join("sub").join(".git")));
    // Resolved out of the folder.
    assert!(!names_inside(root, Path::new("/home/me")));
    assert!(!names_inside(root, Path::new("/home/me/other")));
    assert!(!names_inside(root, Path::new("/home/me/project2/src")));
    assert!(!names_inside(root, Path::new("/etc")));
}

#[test]
fn a_restore_never_passes_through_a_link_in_the_folder() {
    let dir = std::env::temp_dir().join(format!("sync-links-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.join("project");
    let outside = dir.join("outside");
    for folder in [root.join(".git"), root.join("src"), outside.clone()] {
        std::fs::create_dir_all(folder).unwrap();
    }
    std::fs::write(root.join(".git").join("config"), "ORIGINAL").unwrap();
    std::fs::write(root.join("src").join("a.txt"), "a").unwrap();
    std::fs::write(outside.join("victim.txt"), "mine").unwrap();
    // What a snapshot's own commit can check out: a link to the repository's folder, and
    // one to somewhere else on the computer.
    if !link_dir(&root.join(".git"), &root.join("x")) || !link_dir(&outside, &root.join("y")) {
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    let project = Project::new(&root).unwrap();
    // Writing `x/config` would replace `.git/config`; `y/…` is outside the folder.
    for through in [
        "x/config",
        "x/hooks/post-checkout",
        "y/victim.txt",
        "y/new/deep.txt",
        "y/sub/../victim.txt",
    ] {
        assert!(project.place(through).is_err(), "{through}");
        assert!(project.place_for_writing(through).is_err(), "{through}");
    }
    assert_eq!(text(&root, ".git/config"), "ORIGINAL");
    assert_eq!(text(&outside, "victim.txt"), "mine");
    // The folder's own places, there or not yet.
    for inside in ["src/a.txt", "src/new/b.txt", "new.txt", "new/deep/c.txt"] {
        assert!(project.place(inside).is_ok(), "{inside}");
    }
    // The link checks are of what is on the way: a capture doesn't read through one.
    assert!(passes_a_link(&root, "y/victim.txt"));
    assert!(passes_a_link(&root, "x/config"));
    assert!(!passes_a_link(&root, "src/a.txt"));
    assert!(
        !passes_a_link(&root, "y"),
        "the link itself is named, as a link"
    );
    let listed = folder_files(&root);
    assert!(
        !listed
            .iter()
            .any(|f| f.starts_with("y/") || f.starts_with("x/")),
        "{listed:?}"
    );
    // Comparing reads nothing through a link either, and says nothing of what is there.
    let ring = Keyring::generate().unwrap();
    let manifest = Manifest {
        v: 1,
        files: vec![entry(&ring, "y/victim.txt", b"mine")],
        deleted: vec!["y/victim.txt".into(), "x/config".into()],
        ..Default::default()
    };
    let compared = compare(&ring, &root, &manifest, COMPARE_MAX);
    assert!(compared.files.iter().all(|f| f.state == Standing::Unknown));
    // A link at the place itself is replaced as the link it is: what it points at stays.
    let at = project.place_for_writing("y").unwrap();
    assert_eq!(at, root.join("y"));
    assert!(std::fs::symlink_metadata(root.join("y")).is_err());
    assert_eq!(text(&outside, "victim.txt"), "mine");
    let at = project.place_for_writing("x").unwrap();
    assert!(std::fs::symlink_metadata(&at).is_err());
    assert_eq!(text(&root, ".git/config"), "ORIGINAL");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_link_to_a_file_is_never_read_into_a_snapshot_or_followed_by_a_restore() {
    let dir = std::env::temp_dir().join(format!("sync-filelink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.join("project");
    let outside = dir.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside").unwrap();
    std::fs::write(root.join("own.txt"), "own").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();
    // A folder without git: a link is not among its files, nor what is behind one.
    assert_eq!(folder_files(&root), ["own.txt"]);
    // A git project: git names the link itself; the capture looks at it without
    // following it (`Capture::file` skips it as "a link").
    assert!(is_link(
        &std::fs::symlink_metadata(root.join("link.txt")).unwrap()
    ));
    assert!(passes_a_link(&root, "dir/secret.txt"));
    // A restore that writes or deletes `link.txt` replaces the link, not the file behind.
    let project = Project::new(&root).unwrap();
    let at = project.place_for_writing("link.txt").unwrap();
    std::fs::write(&at, "restored").unwrap();
    assert_eq!(text(&outside, "secret.txt"), "outside");
    assert_eq!(text(&root, "link.txt"), "restored");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_list_beyond_what_a_snapshot_holds_is_refused() {
    let ring = Keyring::generate().unwrap();
    let fine = Manifest {
        v: 1,
        files: vec![entry(&ring, "a.txt", b"a"), entry(&ring, "b.txt", b"")],
        ..Default::default()
    };
    assert!(within_limits(&fine).is_ok());
    let id = ring.chunk_id(b"x").unwrap();
    let lying = |size: u64, chunks: usize| FileEntry {
        p: "big.bin".into(),
        s: Stored {
            chunks: vec![id.clone(); chunks],
            size,
        },
        x: false,
        t: 0,
    };
    let with = |file: FileEntry| Manifest {
        v: 1,
        files: vec![file],
        ..Default::default()
    };
    // A file larger than a capture would have taken (a length nobody could hold).
    assert!(within_limits(&with(lying(MAX_FILE_BYTES + 1, 26))).is_err());
    assert!(within_limits(&with(lying(u64::MAX, 1))).is_err());
    assert!(within_limits(&with(lying(MAX_FILE_BYTES, 25))).is_ok());
    // One chunk named a hundred thousand times under a small length.
    assert!(within_limits(&with(lying(10, 100_000))).is_err());
    // More files, deletions or bundles than a snapshot holds.
    let mut many = fine.clone();
    many.files = vec![entry(&ring, "a.txt", b"a"); MAX_FILES + 1];
    assert!(within_limits(&many).is_err());
    let mut many = fine.clone();
    many.deleted = vec!["gone.txt".to_string(); MAX_FILES + 1];
    assert!(within_limits(&many).is_err());
    let mut many = fine.clone();
    many.git = Some(GitState {
        bundles: vec![Bundle::default(); MAX_BUNDLE_CHAIN + 2],
        ..Default::default()
    });
    assert!(within_limits(&many).is_err());
    // A bundle or a staged patch that is a chunk bomb.
    let mut bomb = fine.clone();
    bomb.git = Some(GitState {
        bundles: vec![Bundle {
            file: lying(10, 5_000).s,
            tips: Vec::new(),
        }],
        ..Default::default()
    });
    assert!(within_limits(&bomb).is_err());
    // What a copy brings is counted before anything is fetched: files, bundles, the patch.
    let mut heavy = with(lying(MAX_FILE_BYTES, 25));
    heavy.files.push(lying(MAX_FILE_BYTES, 25));
    heavy.git = Some(GitState {
        bundles: vec![Bundle {
            file: lying(1_000, 1).s,
            tips: Vec::new(),
        }],
        staged: Some(lying(24, 1).s),
        ..Default::default()
    });
    assert_eq!(carried_bytes(&heavy), 2 * MAX_FILE_BYTES + 1_024);
    assert!(within_bytes(&heavy, 2 * MAX_FILE_BYTES + 1_024).is_ok());
    assert!(within_bytes(&heavy, 2 * MAX_FILE_BYTES).is_err());
    assert!(within_bytes(&fine, MAX_COPY_BYTES).is_ok());
    // Lengths that would overflow a sum are still more than a copy may bring.
    let mut endless = fine.clone();
    endless.git = Some(GitState {
        bundles: vec![
            Bundle {
                file: lying(u64::MAX, 1).s,
                tips: Vec::new(),
            };
            2
        ],
        ..Default::default()
    });
    assert!(within_bytes(&endless, MAX_COPY_BYTES).is_err());
}

#[test]
fn what_a_snapshot_says_of_git_is_a_commit_and_a_branch_or_refused() {
    assert!(commit_id(&"a1".repeat(20)));
    assert!(commit_id(&"0f".repeat(32)));
    for bad in [
        "",
        "HEAD",
        "--upload-pack=x",
        "abc123",
        "refs/heads/main",
        &"g".repeat(40)[..],
        &"a".repeat(65)[..],
    ] {
        assert!(!commit_id(bad), "{bad}");
    }
    for ok in ["main", "feature/x-1", "release_2.0", "ünïcode"] {
        assert!(branch_name(ok), "{ok}");
    }
    for bad in [
        "", "-b", "--detach", "a..b", "a b", "x@{1}", "a~1", "a^", "a:b", "a\nb", "a*",
    ] {
        assert!(!branch_name(bad), "{bad}");
    }
}

fn commit(dir: &Path, files: &[(&str, &str)], message: &str) -> String {
    for (file, text) in files {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(dir, &["add", "-A"]).unwrap();
    git(dir, &["commit", "-q", "-m", message]).unwrap();
    sha(dir, "HEAD")
}

fn sha(dir: &Path, rev: &str) -> String {
    git(dir, &["rev-parse", rev]).unwrap().trim().to_string()
}

/// Says that `origin` (at `url`) has everything up to the commit checked out now.
fn pushed(dir: &Path, url: &str) {
    let branch = git(dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
    git(dir, &["remote", "add", "origin", url]).unwrap();
    git(
        dir,
        &[
            "update-ref",
            &format!("refs/remotes/origin/{}", branch.trim()),
            "HEAD",
        ],
    )
    .unwrap();
}

fn revisions(dir: &Path, range: &BundleRange) -> Vec<String> {
    let mut args = vec!["rev-list".to_string()];
    args.extend(range.args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(dir, &refs)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

fn has_commit(dir: &Path, commit: &str) -> bool {
    git(dir, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_ok()
}

fn share_scope(named: bool) -> Scope {
    Scope {
        head_only: true,
        not_remotes: remotes_left_out(Some("origin"), named, true, false),
        leave_out: Some(crate::sync::share::plan::key_file),
    }
}

#[test]
fn a_shares_bundle_carries_only_what_the_commit_checked_out_needs() {
    let dir = repo("share-head", &[("a.txt", "a")]);
    let base = sha(&dir, "HEAD");
    pushed(&dir, "https://example.com/owner/repo.git");
    let main = git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
    let main = main.trim();
    let head = commit(&dir, &[("notes.txt", "notes")], "not pushed");
    // Another branch with a key file committed and not pushed, and a stash with one.
    git(&dir, &["checkout", "-q", "-b", "side"]).unwrap();
    let side = commit(&dir, &[(".env", "TOKEN=hunter2")], "a key on a branch");
    git(&dir, &["checkout", "-q", main]).unwrap();
    std::fs::write(dir.join("a.txt"), "work").unwrap();
    std::fs::write(dir.join(".env.local"), "TOKEN=stashed").unwrap();
    git(&dir, &["stash", "push", "-u", "-q"]).unwrap();
    let stash = sha(&dir, "refs/stash");

    // The vault's own snapshot carries all of it, as before.
    let vault = Scope {
        head_only: false,
        not_remotes: remotes_left_out(Some("origin"), true, false, false),
        leave_out: None,
    };
    let all = revisions(&dir, &bundle_range(&dir, &[], &vault));
    assert!(all.contains(&head) && all.contains(&side) && all.contains(&stash));

    // A share: the commit checked out, down to what the remote has. Nothing else.
    let range = bundle_range(&dir, &[], &share_scope(true));
    assert_eq!(range.tips, std::slice::from_ref(&head));
    assert_eq!(range.args(), ["HEAD", "--not", "--remotes=origin"]);
    assert_eq!(revisions(&dir, &range), std::slice::from_ref(&head));
    // None of those commits holds a key file (the ones on the branch and in the stash
    // don't travel, so they don't count).
    let leave = crate::sync::share::plan::key_file;
    assert!(left_out_in_commits(&dir, &range, leave).unwrap().is_empty());

    // The bundle as it is made, taken into a copy that has what the remote has.
    let file = dir.with_extension("bundle");
    let mut args = vec![
        "bundle".to_string(),
        "create".into(),
        file.to_string_lossy().to_string(),
    ];
    args.extend(range.args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(&dir, &refs).unwrap();
    let copy = dir.with_extension("copy");
    let _ = std::fs::remove_dir_all(&copy);
    std::fs::create_dir_all(&copy).unwrap();
    git(&copy, &["init", "-q"]).unwrap();
    let from = dir.to_string_lossy().to_string();
    let tracking = format!("refs/remotes/origin/{main}:refs/heads/base");
    git(&copy, &["fetch", "-q", &from, &tracking]).unwrap();
    assert!(has_commit(&copy, &base) && !has_commit(&copy, &head));
    take_bundle(&copy, &file).unwrap();
    assert!(has_commit(&copy, &head), "the commit checked out arrived");
    assert!(!has_commit(&copy, &side), "the other branch stayed");
    assert!(!has_commit(&copy, &stash), "the stash stayed");
    git(&copy, &["checkout", "-q", "--detach", &head]).unwrap();
    assert_eq!(text(&copy, "notes.txt"), "notes");
    assert!(!copy.join(".env").exists() && !copy.join(".env.local").exists());

    // The next snapshot leaves out what that bundle carried.
    let chain = [Bundle {
        file: Stored::default(),
        tips: range.tips.clone(),
    }];
    let next = commit(&dir, &[("more.txt", "more")], "later");
    let range = bundle_range(&dir, &chain, &share_scope(true));
    assert_eq!(revisions(&dir, &range), [next]);
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir_all(&copy);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn key_files_in_commits_that_would_travel_refuse_a_shares_capture() {
    let dir = repo(
        "share-keys",
        &[("a.txt", "a"), ("old.key", "pushed long ago")],
    );
    pushed(&dir, "https://example.com/owner/repo.git");
    let leave = crate::sync::share::plan::key_file;
    // Deleting a key file the remote already has carries nothing of it.
    std::fs::remove_file(dir.join("old.key")).unwrap();
    commit(&dir, &[("b.txt", "b")], "tidy");
    let range = bundle_range(&dir, &[], &share_scope(true));
    assert!(left_out_in_commits(&dir, &range, leave).unwrap().is_empty());
    // Committed and not pushed: in the bundle, whatever is left out of the files. Even
    // when a later commit removed it again.
    commit(
        &dir,
        &[(".env", "TOKEN=hunter2"), ("conf/server.pem", "KEY")],
        "oops",
    );
    std::fs::remove_file(dir.join(".env")).unwrap();
    commit(&dir, &[("c.txt", "c")], "removed again");
    let range = bundle_range(&dir, &[], &share_scope(true));
    let found = left_out_in_commits(&dir, &range, leave).unwrap();
    assert_eq!(found, [".env", "conf/server.pem"]);
    match key_files_in_history(&found) {
        Error::Sync("ShareKeyFilesInHistory", text) => {
            assert!(
                text.contains(".env, conf/server.pem") && text.contains("Push or remove"),
                "{text}"
            );
        }
        other => panic!("unexpected: {other:?}"),
    }
    // Many of them: the first ten are named, the rest counted.
    let many: Vec<String> = (0..13).map(|n| format!("k{n:02}.pem")).collect();
    assert!(matches!(
        key_files_in_history(&many),
        Error::Sync("ShareKeyFilesInHistory", text)
            if text.contains("k09.pem and 3 more") && !text.contains("k10.pem")
    ));
    // Once they are pushed (the remote has those commits) nothing of them travels.
    let branch = git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
    git(
        &dir,
        &[
            "update-ref",
            &format!("refs/remotes/origin/{}", branch.trim()),
            "HEAD",
        ],
    )
    .unwrap();
    let range = bundle_range(&dir, &[], &share_scope(true));
    assert!(revisions(&dir, &range).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_share_that_doesnt_name_its_remote_carries_the_whole_history() {
    // Which remotes count as having commits.
    let left_out = remotes_left_out;
    assert_eq!(
        left_out(Some("origin"), true, false, false).as_deref(),
        Some("--remotes"),
        "the vault's own: any remote's"
    );
    assert_eq!(
        left_out(Some("origin"), true, true, false).as_deref(),
        Some("--remotes=origin"),
        "a share: the one remote its reader clones from"
    );
    assert_eq!(left_out(Some("origin"), false, true, false), None);
    assert_eq!(left_out(Some("origin"), true, false, true), None);
    assert_eq!(left_out(None, false, false, false), None);
    assert_eq!(left_out(Some("we*ird"), true, true, false), None);

    // A project whose origin is a folder on this computer: the share doesn't say where
    // (`plan::public_remote` drops it), so a reader can't get anything from it.
    let dir = repo("share-local", &[("a.txt", "a")]);
    let first = sha(&dir, "HEAD");
    let head = commit(&dir, &[("b.txt", "b")], "second");
    pushed(&dir, "/srv/git/thing.git");
    assert_eq!(
        crate::sync::share::plan::public_remote("/srv/git/thing.git"),
        None
    );
    // Counted as a remote (as before), nothing would travel, and a copy has no commits.
    let as_before = Scope {
        head_only: true,
        not_remotes: Some("--remotes".into()),
        leave_out: None,
    };
    assert!(revisions(&dir, &bundle_range(&dir, &[], &as_before)).is_empty());
    // Counted as none: the whole history the commit needs is in the bundle.
    let range = bundle_range(&dir, &[], &share_scope(false));
    assert_eq!(range.args(), ["HEAD"]);
    assert_eq!(revisions(&dir, &range), [head.clone(), first.clone()]);
    let file = dir.with_extension("bundle");
    git(&dir, &["bundle", "create", &file.to_string_lossy(), "HEAD"]).unwrap();
    // A copy with nothing in it gets every commit from the bundle alone.
    let copy = dir.with_extension("copy");
    let _ = std::fs::remove_dir_all(&copy);
    std::fs::create_dir_all(&copy).unwrap();
    git(&copy, &["init", "-q"]).unwrap();
    take_bundle(&copy, &file).unwrap();
    assert!(has_commit(&copy, &head) && has_commit(&copy, &first));
    git(&copy, &["checkout", "-q", "--detach", &head]).unwrap();
    assert_eq!(text(&copy, "b.txt"), "b");
    // Still looked through for key files: the whole history travels.
    commit(&dir, &[("id_rsa", "KEY")], "a key");
    let range = bundle_range(&dir, &[], &share_scope(false));
    let leave = crate::sync::share::plan::key_file;
    assert_eq!(
        left_out_in_commits(&dir, &range, leave).unwrap(),
        ["id_rsa"]
    );
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir_all(&copy);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_staged_file_that_stays_out_is_not_in_the_staged_patch() {
    let dir = repo("staged-left-out", &[("a.txt", "a\n")]);
    std::fs::write(dir.join("a.txt"), "a\nstaged\n").unwrap();
    std::fs::write(dir.join(".env"), "TOKEN=hunter2\n").unwrap();
    std::fs::create_dir_all(dir.join("conf")).unwrap();
    std::fs::write(dir.join("conf").join("server.pem"), "PRIVATE-KEY-BYTES\n").unwrap();
    git(&dir, &["add", "-A"]).unwrap();
    // The vault's own snapshot: everything staged, as before.
    let whole = staged_patch(&dir, None).unwrap();
    assert!(whole.contains("hunter2") && whole.contains("PRIVATE-KEY-BYTES"));
    fn leave(path: &str) -> Option<&'static str> {
        (path == ".env" || path.ends_with(".pem")).then_some("a key file")
    }
    let patch = staged_patch(&dir, Some(leave)).unwrap();
    assert!(patch.contains("+staged"), "{patch}");
    assert!(!patch.contains("hunter2"), "{patch}");
    assert!(!patch.contains("PRIVATE-KEY-BYTES"), "{patch}");
    assert!(!patch.contains(".env") && !patch.contains("server.pem"));
    // Nothing staged that stays out: the same patch as without the rule.
    git(&dir, &["reset", "-q", "--", ".env", "conf/server.pem"]).unwrap();
    assert_eq!(
        staged_patch(&dir, Some(leave)).unwrap(),
        staged_patch(&dir, None).unwrap()
    );
    let _ = std::fs::remove_dir_all(&dir);
}
