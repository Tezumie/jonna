use super::*;

fn setup(name: &str) -> Result<(PathBuf, Workspace)> {
    let dir = std::env::temp_dir().join(format!("ide-fs-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src"))?;
    fs::write(dir.join("src/main.ts"), "x")?;
    fs::write(dir.join(".gitignore"), "build/\n")?;
    fs::create_dir_all(dir.join("build"))?;
    fs::create_dir_all(dir.join(".git"))?;
    fs::write(dir.join("B.txt"), "")?;
    fs::write(dir.join("a.txt"), "")?;
    let ws = Workspace::default();
    let root = ws.open(&dir.to_string_lossy())?;
    Ok((root, ws))
}

#[test]
fn lists_dirs_first_and_flags_ignored() -> Result<()> {
    let (root, _ws) = setup("list")?;
    let names: Vec<(String, bool)> = list_dir(&root)?
        .into_iter()
        .map(|e| (e.name, e.ignored))
        .collect();
    assert_eq!(
        names,
        vec![
            ("build".into(), true),
            ("src".into(), false),
            (".gitignore".into(), false),
            ("a.txt".into(), false),
            ("B.txt".into(), false),
        ]
    );
    Ok(())
}

#[test]
fn natural_order() {
    let mut names = vec![
        "file-10.txt",
        "File-2.txt",
        "file-1.txt",
        "a",
        "B",
        "file-02.txt",
    ];
    names.sort_by(|a, b| natural_cmp(a, b));
    // Equal by natural order ("02" == "2"), so the plain byte order breaks the tie.
    assert_eq!(
        names,
        vec![
            "a",
            "B",
            "file-1.txt",
            "File-2.txt",
            "file-02.txt",
            "file-10.txt"
        ]
    );
}

#[test]
fn scope_rejects_escapes() -> Result<()> {
    let (root, ws) = setup("scope")?;
    let inside = root.join("src/new/file.ts");
    assert!(ws.resolve(&inside.to_string_lossy()).is_ok());
    let escape = format!("{}/../outside.txt", root.display());
    assert!(matches!(ws.resolve(&escape), Err(Error::OutsideScope(_))));
    assert!(matches!(ws.resolve("relative.txt"), Err(Error::Invalid(_))));
    Ok(())
}

#[test]
fn files_the_user_opened_from_outside_are_in_scope_alone() -> Result<()> {
    let (root, ws) = setup("extra")?;
    let outside = root
        .parent()
        .unwrap()
        .join(format!("ide-outside-{}", std::process::id()));
    fs::create_dir_all(&outside)?;
    fs::write(outside.join("a.rs"), "fn main() {}")?;
    fs::write(outside.join("b.rs"), "")?;
    let a = outside.join("a.rs").to_string_lossy().into_owned();
    assert!(matches!(ws.resolve(&a), Err(Error::OutsideScope(_))));
    ws.allow_file(&a)?;
    assert!(ws.resolve(&a).is_ok());
    // Only that file: not its neighbors, not its folder, never deleting or renaming it.
    assert!(ws.resolve(&outside.join("b.rs").to_string_lossy()).is_err());
    assert!(ws.resolve(&outside.to_string_lossy()).is_err());
    assert!(ws.resolve_entry(&a).is_err());
    assert!(ws.allow_file(&outside.to_string_lossy()).is_err());
    // One that doesn't exist yet (named on the command line, saved later): that path alone.
    let new = outside.join("new.md").to_string_lossy().into_owned();
    ws.allow_file(&new)?;
    assert!(ws.resolve(&new).is_ok());
    assert!(ws
        .resolve(&outside.join("other.md").to_string_lossy())
        .is_err());
    // In folders that don't exist either (`<cli> new/dir/file.txt`): saving creates them, as in
    // VS Code; their other files stay out.
    let deep = outside.join("no-dir").join("sub").join("x.md");
    let deep_s = deep.to_string_lossy().into_owned();
    ws.allow_file(&deep_s)?;
    let resolved = ws.resolve(&deep_s)?;
    write(&resolved, b"saved")?;
    assert_eq!(fs::read_to_string(&deep)?, "saved");
    assert!(
        ws.resolve(&deep_s).is_ok(),
        "still the same file once it exists"
    );
    assert!(ws
        .resolve(
            &outside
                .join("no-dir")
                .join("sub")
                .join("y.md")
                .to_string_lossy()
        )
        .is_err());
    assert!(ws.holds_extra(&simplify(fs::canonicalize(&outside)?)));
    // Network and relative paths are never let in.
    assert!(ws.allow_file("\\\\host\\share\\x.rs").is_err());
    assert!(ws.allow_file("\\\\?\\UNC\\host\\share\\x.rs").is_err());
    assert!(ws.allow_file("a.rs").is_err());
    // Opening another folder forgets them (D190).
    ws.open(&root.to_string_lossy())?;
    assert!(ws.resolve(&a).is_err());
    let _ = fs::remove_dir_all(&outside);
    Ok(())
}

#[test]
fn create_rename_delete() -> Result<()> {
    let (root, _ws) = setup("ops")?;
    let file = create_file(&root, "new.ts")?;
    assert!(create_file(&root, "new.ts").is_err());
    assert!(create_file(&root, "../x").is_err());
    let renamed = rename(&file, "renamed.ts")?;
    assert!(renamed.exists() && !file.exists());
    let dir = create_dir(&root, "folder")?;
    delete(&dir, &root)?;
    assert!(!dir.exists());
    assert!(delete(&root, &root).is_err());
    Ok(())
}

#[test]
fn move_and_copy_into_folders() -> Result<()> {
    let (root, ws) = setup("move")?;
    let file = ws.resolve(&root.join("a.txt").to_string_lossy())?;
    let src = ws.resolve(&root.join("src").to_string_lossy())?;
    let moved = move_into(&file, &src, &root)?;
    assert_eq!(moved, src.join("a.txt"));
    assert!(!file.exists());
    // A folder can't go into itself, and the root can't move.
    assert!(move_into(&src, &src, &root).is_err());
    assert!(move_into(&root, &src, &root).is_err());
    let copy = copy_into(&moved, &src)?;
    assert_eq!(copy, src.join("a copy.txt"));
    let copy2 = copy_into(&moved, &src)?;
    assert_eq!(copy2, src.join("a copy 2.txt"));
    let tree = copy_into(&src, &root)?;
    assert_eq!(tree, root.join("src copy"));
    assert!(tree.join("main.ts").exists());
    fs::remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn case_only_rename_never_replaces_another_file() {
    let dir = std::env::temp_dir().join(format!("ide-fs-case-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "lower").unwrap();
    let upper = dir.join("A.txt");
    if !upper.exists() {
        // Case-sensitive file system: both names can exist.
        std::fs::write(&upper, "upper").unwrap();
        assert!(super::rename(&dir.join("a.txt"), "A.txt").is_err());
        assert_eq!(std::fs::read_to_string(&upper).unwrap(), "upper");
    } else {
        // Case-insensitive: a.txt → A.txt is the same file, allowed.
        super::rename(&dir.join("a.txt"), "A.txt").unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A link inside a copied folder stays a link: copying its target would pull files from outside
/// the workspace into it.
#[cfg(unix)]
#[test]
fn copy_keeps_symlinks_as_links() -> Result<()> {
    let (root, _ws) = setup("copylink")?;
    let outside = root.with_extension("outside");
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(&outside)?;
    fs::write(outside.join("secret.txt"), "secret")?;
    let folder = root.join("linked");
    fs::create_dir_all(&folder)?;
    std::os::unix::fs::symlink(&outside, folder.join("dir-link"))?;
    std::os::unix::fs::symlink(outside.join("secret.txt"), folder.join("file-link"))?;
    let copy = copy_into(&folder, &root)?;
    for name in ["dir-link", "file-link"] {
        let meta = fs::symlink_metadata(copy.join(name))?;
        assert!(meta.file_type().is_symlink(), "{name}");
    }
    fs::remove_dir_all(&root)?;
    fs::remove_dir_all(&outside)?;
    Ok(())
}

#[test]
fn network_paths_are_told_apart_from_local_ones() {
    for p in [
        r"\\server\share\x",
        "//server/share/x",
        r"\\?\UNC\server\share",
        r"\\?\GLOBALROOT\Device\Mup\server\share\x",
        r"\\.\GLOBALROOT\Device\Mup\s\x",
        // A character across byte 7 after the prefix used to panic the slice.
        "\\\\?\\abcdef\u{e9}\\x",
    ] {
        assert!(super::is_unc(p), "{p}");
    }
    for p in [r"\\?\C:\Users\x", r"\\?\Volume{abc}\x", r"C:\x", "/home/x"] {
        assert!(!super::is_unc(p), "{p}");
    }
}

#[test]
fn a_helpers_worktree_is_an_extra_root_while_allowed() -> Result<()> {
    let (root, ws) = setup("roots")?;
    let base = root.parent().map(Path::to_path_buf).unwrap_or_default();
    // A linked worktree as `git worktree add` leaves it: `.git` is a file naming
    // `<repo>/.git/worktrees/<name>`, whose `commondir` leads back to `<repo>/.git`.
    let tree = base.join(format!("ide-fs-test-roots-wt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tree);
    fs::create_dir_all(tree.join("src"))?;
    fs::write(tree.join("src/lib.rs"), "x")?;
    let admin = root.join(".git").join("worktrees").join("wt");
    fs::create_dir_all(&admin)?;
    fs::write(admin.join("commondir"), "../..\n")?;
    fs::write(tree.join(".git"), format!("gitdir: {}\n", admin.display()))?;
    let file = tree.join("src/lib.rs").to_string_lossy().into_owned();
    assert!(ws.resolve(&file).is_err());
    let allowed = ws.allow_root(&tree.to_string_lossy())?;
    assert!(ws.resolve(&file).is_ok());
    assert!(ws.resolve(&tree.join("new.rs").to_string_lossy()).is_ok());
    assert!(ws.resolve_entry(&file).is_ok());
    // The root itself is never deleted or renamed.
    assert!(ws.resolve_entry(&tree.to_string_lossy()).is_err());
    assert_eq!(ws.root_of(&ws.resolve(&file)?)?, allowed);
    assert_eq!(ws.scope_root(&tree.to_string_lossy())?, allowed);
    // A plain folder (no worktree of this repository) is refused.
    let plain = base.join(format!("ide-fs-test-roots-plain-{}", std::process::id()));
    fs::create_dir_all(&plain)?;
    assert!(ws.allow_root(&plain.to_string_lossy()).is_err());
    assert!(ws.scope_root(&plain.to_string_lossy()).is_err());
    assert!(ws.allow_root("relative/dir").is_err());
    // Forgotten again: out of scope.
    ws.forget_root(&tree.to_string_lossy())?;
    assert!(ws.resolve(&file).is_err());
    // Opening a folder forgets them too.
    ws.allow_root(&tree.to_string_lossy())?;
    ws.open(&root.to_string_lossy())?;
    assert!(ws.resolve(&file).is_err());
    let _ = fs::remove_dir_all(&tree);
    let _ = fs::remove_dir_all(&plain);
    Ok(())
}

#[test]
fn other_workspace_folders_are_in_scope_like_the_root() -> Result<()> {
    let (root, ws) = setup("folders")?;
    let base = root.parent().map(Path::to_path_buf).unwrap_or_default();
    let pid = std::process::id();
    let other = base.join(format!("ide-fs-test-folders-other-{pid}"));
    let _ = fs::remove_dir_all(&other);
    fs::create_dir_all(other.join("src"))?;
    fs::write(other.join("src/lib.rs"), "x")?;
    let missing = base.join(format!("ide-fs-test-folders-missing-{pid}"));
    let nested = root.join("src");
    let file = other.join("src/lib.rs").to_string_lossy().into_owned();
    assert!(ws.resolve(&file).is_err());
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let statuses = ws.set_folders(&[
        s(&other),
        s(&missing),
        s(&root),
        s(&other),
        s(&nested),
        "relative/dir".into(),
    ])?;
    assert_eq!(statuses.len(), 6);
    let other_c = simplify(fs::canonicalize(&other)?);
    let nested_c = simplify(fs::canonicalize(&nested)?);
    assert_eq!(statuses[0].canonical.as_deref(), Some(s(&other_c).as_str()));
    assert!(statuses[0].error.is_none());
    assert!(statuses[1].canonical.is_none() && statuses[1].error.is_some());
    assert_eq!(statuses[2].canonical.as_deref(), Some(s(&root).as_str()));
    assert!(statuses[5].error.is_some());
    // Duplicates and the root are kept once (the root stays first), the missing one left out.
    assert_eq!(ws.folders(), vec![other_c.clone(), nested_c.clone()]);
    assert_eq!(
        ws.all_folders(),
        vec![root.clone(), other_c.clone(), nested_c.clone()]
    );
    // In scope like the root: read, create, rename and delete inside, never the folder itself.
    assert!(ws.resolve(&file).is_ok());
    assert!(ws.resolve(&s(&other.join("new/x.rs"))).is_ok());
    assert!(ws.resolve_entry(&file).is_ok());
    assert!(ws.resolve_entry(&s(&other)).is_err());
    // A folder nested in the root is a workspace folder of its own: never deleted either, also
    // when named in another case on a case-insensitive file system (D251 audit).
    assert!(ws.resolve_entry(&s(&nested)).is_err());
    if cfg!(windows) {
        assert!(ws.resolve_entry(&s(&root.join("SRC"))).is_err());
    }
    assert!(ws.resolve_entry(&s(&nested.join("main.ts"))).is_ok());
    assert_eq!(ws.root_of(&ws.resolve(&file)?)?, other_c);
    // The innermost folder owns a nested file (as the frontend's `folderOf`).
    assert_eq!(ws.root_of(&root.join("src/main.ts"))?, nested_c);
    assert_eq!(ws.root_of(&root.join("other.md"))?, root);
    assert_eq!(ws.folder_of(&other_c.join("src")), Some(other_c.clone()));
    assert_eq!(ws.scope_root(&s(&other))?, other_c);
    assert_eq!(ws.scope_root(&s(&nested))?, nested_c);
    assert!(ws.scope_root(&s(&base)).is_err());
    assert!(ws.is_scope_root(&other_c) && ws.is_scope_root(&root));
    assert!(!ws.is_scope_root(&other_c.join("src")));
    // The workspace file names the window instead of the root.
    let file_path = base.join(format!("ide-fs-test-{pid}.code-workspace"));
    fs::write(&file_path, "{}")?;
    assert_eq!(ws.location()?, root);
    let kept = ws.set_file(Some(&s(&file_path)))?;
    assert_eq!(kept, Some(simplify(fs::canonicalize(&file_path)?)));
    assert_eq!(Some(ws.location()?), kept);
    assert!(ws.set_file(Some("relative.code-workspace")).is_err());
    assert!(ws.set_file(Some(&s(&base.join("a.json")))).is_err());
    assert_eq!(ws.file(), kept, "a refused file leaves the one set");
    ws.set_file(None)?;
    assert_eq!(ws.location()?, root);
    // Opening a folder (and closing) forgets the other folders and the workspace file.
    ws.set_file(Some(&s(&file_path)))?;
    ws.open(&s(&root))?;
    assert!(ws.folders().is_empty() && ws.file().is_none());
    assert!(ws.resolve(&file).is_err());
    ws.set_folders(&[s(&other)])?;
    ws.close()?;
    assert!(ws.all_folders().is_empty());
    assert!(matches!(
        ws.set_folders(&[s(&other)]),
        Err(Error::NoWorkspace)
    ));
    let _ = fs::remove_dir_all(&other);
    let _ = fs::remove_file(&file_path);
    Ok(())
}

#[test]
fn only_local_code_workspace_files_are_workspace_files() {
    let dir = std::env::temp_dir();
    let ok = dir.join("Team.CODE-WORKSPACE");
    assert!(checked_workspace_file(&ok.to_string_lossy()).is_ok());
    let missing_dir = dir.join("ide-no-such-dir").join("a.code-workspace");
    assert!(checked_workspace_file(&missing_dir.to_string_lossy()).is_ok());
    for bad in [
        "a.code-workspace".to_string(),
        dir.join(".code-workspace").to_string_lossy().into_owned(),
        dir.join("a.json").to_string_lossy().into_owned(),
        format!("{}/../x.code-workspace", dir.display()),
        r"\\host\share\a.code-workspace".to_string(),
    ] {
        assert!(checked_workspace_file(&bad).is_err(), "{bad}");
    }
}

#[test]
fn a_remote_workspace_is_scoped_by_its_posix_paths() {
    assert_eq!(normalize_posix("/a/./b//c/").as_deref(), Some("/a/b/c"));
    assert_eq!(normalize_posix("/a/b/../../..").as_deref(), Some("/"));
    assert_eq!(normalize_posix(r"/a\b").as_deref(), Some("/a/b"));
    assert_eq!(normalize_posix("a/b"), None);
    assert!(posix_within("/home/me/app/x", "/home/me/app"));
    assert!(posix_within("/home/me/app", "/home/me/app"));
    assert!(!posix_within("/home/me/apple", "/home/me/app"));
    let ws = Workspace::default();
    let root = ws.open_remote("/home/me/app", "ssh:box").unwrap();
    assert_eq!(root, PathBuf::from("/home/me/app"));
    assert_eq!(ws.remote().as_deref(), Some("ssh:box"));
    assert_eq!(
        ws.resolve_remote("/home/me/app/src/../a.ts").unwrap(),
        PathBuf::from("/home/me/app/a.ts")
    );
    assert!(matches!(
        ws.resolve_remote("/home/me/app/../other"),
        Err(Error::OutsideScope(_))
    ));
    assert!(ws.resolve_remote("/home/me/apple").is_err());
    // Named with its remote: the same path on another host is another workspace.
    assert_eq!(
        ws.location().unwrap(),
        PathBuf::from("ssh://box/home/me/app")
    );
    ws.set_remote_folders(&["/srv/data".into(), "/home/me/app".into()])
        .unwrap();
    assert_eq!(ws.folders(), vec![PathBuf::from("/srv/data")]);
    assert!(ws.resolve_remote("/srv/data/x").is_ok());
    assert_eq!(
        ws.scope_root("/srv/data/").unwrap(),
        PathBuf::from("/srv/data")
    );
    assert!(ws.scope_root("/srv").is_err());
    assert!(ws.set_folders(&["/x".into()]).is_err());
    // Opening a local folder makes it local again.
    ws.close().unwrap();
    assert_eq!(ws.remote(), None);
}

/// Deleting a junction (or a folder link) removes the link, not what it points to; `remove_file`
/// was refused on it ("Access is denied").
#[cfg(windows)]
#[test]
fn deleting_a_junction_removes_the_link_alone() -> Result<()> {
    let (root, _ws) = setup("junction")?;
    let junction = root.join("linked");
    let made = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(root.join("src"))
        .stdout(std::process::Stdio::null())
        .status()?;
    assert!(made.success());
    delete(&junction, &root)?;
    assert!(fs::symlink_metadata(&junction).is_err());
    assert!(root.join("src").join("main.ts").is_file());
    fs::remove_dir_all(&root)?;
    Ok(())
}
