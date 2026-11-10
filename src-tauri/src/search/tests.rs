use std::sync::mpsc;

use super::*;

fn opts(query: &str) -> SearchOptions {
    SearchOptions {
        query: query.into(),
        is_regex: false,
        match_case: false,
        whole_word: false,
        include: vec![],
        exclude: vec![],
        max_results: None,
        use_ignore_files: true,
        follow_symlinks: false,
        preserve_case: false,
        lines: None,
        multi_line: false,
    }
}

#[test]
fn preserve_case_and_single_line_replace() {
    assert_eq!(super::preserve_case("FOO", "bar"), "BAR");
    assert_eq!(super::preserve_case("foo", "Bar"), "bar");
    assert_eq!(super::preserve_case("Foo", "bar"), "Bar");
    assert_eq!(super::preserve_case("fOo", "bar"), "bar");
    let dir = std::env::temp_dir().join(format!("ide-replace-lines-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.txt");
    std::fs::write(&file, "Foo one\nfoo two\nFOO three\n").unwrap();
    let mut o = opts("foo");
    o.preserve_case = true;
    o.lines = Some(vec![1, 3]);
    let r = super::replace(&o, "bar", std::slice::from_ref(&file), None).unwrap();
    assert_eq!(r.replacements, 2);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "Bar one\nfoo two\nBAR three\n"
    );
}

fn setup(name: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("ide-search-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src"))?;
    std::fs::create_dir_all(dir.join("dist"))?;
    std::fs::write(dir.join(".gitignore"), "dist/\n")?;
    std::fs::write(dir.join("src/a.ts"), "const Foo = 1;\nfoo(Foo);\n// food\n")?;
    std::fs::write(dir.join("src/b.md"), "no match here\nFOO bar\n")?;
    std::fs::write(dir.join("dist/out.js"), "foo foo foo\n")?;
    std::fs::write(dir.join("src/bin.dat"), b"foo\x00\x01")?;
    Ok(dir)
}

fn collect(root: &Path, o: SearchOptions) -> Result<Vec<SearchEvent>> {
    collect_in(vec![root.to_path_buf()], o)
}

fn collect_in(roots: Vec<PathBuf>, o: SearchOptions) -> Result<Vec<SearchEvent>> {
    let service = SearchService::default();
    let (tx, rx) = mpsc::channel();
    service.start(roots, o, false, move |e| {
        let _ = tx.send(e);
    })?;
    let mut out = Vec::new();
    while let Ok(e) = rx.recv() {
        let done = matches!(e, SearchEvent::Done { .. });
        out.push(e);
        if done {
            break;
        }
    }
    Ok(out)
}

type Found = (String, u64, Vec<(usize, usize)>);

fn file_matches(events: &[SearchEvent]) -> Vec<Found> {
    let mut out = Vec::new();
    for e in events {
        if let SearchEvent::File { rel, matches, .. } = e {
            for m in matches {
                out.push((rel.clone(), m.line, m.ranges.clone()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn finds_case_insensitive_skips_ignored_and_binary() -> Result<()> {
    let root = setup("basic")?;
    let found = file_matches(&collect(&root, opts("foo"))?);
    assert_eq!(
        found,
        vec![
            ("src/a.ts".into(), 1, vec![(6, 9)]),
            ("src/a.ts".into(), 2, vec![(0, 3), (4, 7)]),
            ("src/a.ts".into(), 3, vec![(3, 6)]),
            ("src/b.md".into(), 2, vec![(0, 3)]),
        ]
    );
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn case_word_regex_and_globs() -> Result<()> {
    let root = setup("opts")?;
    let mut o = opts("Foo");
    o.match_case = true;
    o.whole_word = true;
    assert_eq!(file_matches(&collect(&root, o)?).len(), 2);
    let mut o = opts(r"fo+d?\b");
    o.is_regex = true;
    o.include = vec!["*.md".into()];
    assert_eq!(
        file_matches(&collect(&root, o)?),
        vec![("src/b.md".into(), 2, vec![(0, 3)])]
    );
    let mut o = opts("foo");
    o.exclude = vec!["src".into()];
    assert!(file_matches(&collect(&root, o)?).is_empty());
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn replace_literal_and_regex() -> Result<()> {
    let root = setup("replace")?;
    let a = root.join("src/a.ts");
    let mut o = opts("foo");
    o.whole_word = true;
    let r = replace(&o, "$bar", std::slice::from_ref(&a), None)?;
    assert_eq!(r.replacements, 3);
    assert_eq!(
        std::fs::read_to_string(&a)?,
        "const $bar = 1;\n$bar($bar);\n// food\n"
    );
    let mut o = opts(r"\$(\w+)");
    o.is_regex = true;
    replace(&o, "<$1>", std::slice::from_ref(&a), None)?;
    assert_eq!(
        std::fs::read_to_string(&a)?,
        "const <bar> = 1;\n<bar>(<bar>);\n// food\n"
    );
    std::fs::remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn long_lines_are_clipped_around_the_match() {
    let line = format!("{}needle{}", "x".repeat(1000), "y".repeat(1000));
    let (text, ranges) = clip(&line, &[(1000, 1006)]);
    assert!(text.starts_with('…'));
    assert!(text.chars().count() <= MAX_LINE_CHARS + 1);
    let (s, e) = ranges[0];
    let utf16: Vec<u16> = text.encode_utf16().collect();
    assert_eq!(String::from_utf16_lossy(&utf16[s..e]), "needle");
}

#[test]
fn an_exact_file_with_glob_characters_matches_only_itself() -> Result<()> {
    let root = setup("exact")?;
    for d in ["app/[id]", "app/i", "app/d"] {
        std::fs::create_dir_all(root.join(d))?;
        std::fs::write(root.join(d).join("page.tsx"), "foo\n")?;
    }
    let mut o = opts("foo");
    o.include = vec!["app/[id]/page.tsx".into()];
    let found = file_matches(&collect(&root, o)?);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, "app/[id]/page.tsx");
    Ok(())
}

/// Following links never reaches files outside the workspace root.
#[cfg(unix)]
#[test]
fn followed_links_stay_inside_root() -> Result<()> {
    let dir = setup("links")?;
    let outside = dir.with_extension("outside");
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside)?;
    std::fs::write(outside.join("leak.txt"), "foo outside\n")?;
    std::os::unix::fs::symlink(&outside, dir.join("src/out-link"))?;
    std::os::unix::fs::symlink(dir.join("src/a.ts"), dir.join("src/in-link.ts"))?;
    let mut o = opts("foo");
    o.follow_symlinks = true;
    let files: Vec<String> = collect(&dir, o)?
        .into_iter()
        .filter_map(|e| match e {
            SearchEvent::File { rel, .. } => Some(rel),
            _ => None,
        })
        .collect();
    assert!(files.iter().all(|f| !f.contains("leak")), "{files:?}");
    assert!(files.iter().any(|f| f == "src/in-link.ts"), "{files:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&outside);
    Ok(())
}

#[test]
fn multi_line_detection_and_crlf() {
    let mut o = opts(r"a\nb");
    assert!(
        !is_multi_line(&o),
        "a literal backslash-n isn't a line break"
    );
    o.is_regex = true;
    assert!(is_multi_line(&o));
    o.query = r"a\\nb".into();
    assert!(!is_multi_line(&o), "an escaped backslash then n");
    assert!(is_multi_line(&opts("one\ntwo")));
    assert_eq!(crlf_tolerant(r"a\nb"), r"a\r?\nb");
    assert_eq!(crlf_tolerant("a\nb"), r"a\r?\nb");
    assert_eq!(crlf_tolerant(r"[^\n]+\n"), r"[^\n]+\r?\n");
    assert_eq!(crlf_tolerant(r"[]\n]\n"), r"[]\n]\r?\n");
    assert_eq!(crlf_tolerant(r"\\n"), r"\\n");
}

#[test]
fn multi_line_regex_reports_the_first_line() -> Result<()> {
    let dir = std::env::temp_dir().join(format!("ide-search-multi-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("a.ts"),
        "start\nfoo(\n  bar)\nfoo(\n  baz)\nfoo(x)\n",
    )?;
    std::fs::write(dir.join("crlf.txt"), "foo(\r\n  bar)\r\n")?;
    let mut o = opts(r"foo\(\n\s*ba");
    o.is_regex = true;
    assert_eq!(
        file_matches(&collect(&dir, o)?),
        vec![
            ("a.ts".into(), 2, vec![(0, 4)]),
            ("a.ts".into(), 4, vec![(0, 4)]),
            ("crlf.txt".into(), 1, vec![(0, 4)]),
        ]
    );
    // Two matches on one line, one of them running into the next.
    std::fs::write(dir.join("a.ts"), "x y\nz\n")?;
    std::fs::remove_file(dir.join("crlf.txt"))?;
    let mut o = opts(r"x|y\nz");
    o.is_regex = true;
    assert_eq!(
        file_matches(&collect(&dir, o)?),
        vec![("a.ts".into(), 1, vec![(0, 1), (2, 3)])]
    );
    // Replace across lines.
    let mut o = opts(r"y\nz");
    o.is_regex = true;
    let r = super::replace(&o, "yz", &[dir.join("a.ts")], None)?;
    assert_eq!(r.replacements, 1);
    assert_eq!(std::fs::read_to_string(dir.join("a.ts"))?, "x yz\n");
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn multi_line_option_lets_dot_cross_lines() -> Result<()> {
    let dir = std::env::temp_dir().join(format!("ide-search-dotall-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("a.ts"), "struct A {\n  x: u8,\n}\nother\n")?;
    let mut o = opts(r"struct A \{.*?x: u8");
    o.is_regex = true;
    // Without it, `.` stops at the line's end.
    assert!(file_matches(&collect(&dir, o.clone())?).is_empty());
    o.multi_line = true;
    assert!(is_multi_line(&o));
    assert_eq!(
        file_matches(&collect(&dir, o)?),
        vec![("a.ts".into(), 1, vec![(0, 10)])]
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn one_search_runs_every_folder_with_paths_relative_to_each() -> Result<()> {
    let first = setup("roots-a")?;
    let second = setup("roots-b")?;
    // A folder nested in the first: its files are reported once, by the innermost folder.
    let nested = first.join("src");
    let events = collect_in(vec![first.clone(), second.clone(), nested], opts("FOO bar"))?;
    let files: Vec<(String, String)> = events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::File { path, rel, .. } => Some((path.clone(), rel.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].1, "src/b.md");
    assert!(Path::new(&files[0].0).starts_with(&second));
    // The nested folder's file, relative to that folder.
    assert_eq!(files[1].1, "b.md");
    assert!(Path::new(&files[1].0).starts_with(first.join("src")));
    let done = events
        .iter()
        .filter(|e| matches!(e, SearchEvent::Done { .. }));
    assert_eq!(done.count(), 1);
    assert!(matches!(
        events.last(),
        Some(SearchEvent::Done {
            files: 2,
            matches: 2,
            ..
        })
    ));
    // The result cap counts across folders.
    let mut capped = opts("foo");
    capped.max_results = Some(2);
    let events = collect_in(vec![first.clone(), second.clone()], capped)?;
    assert!(matches!(
        events.last(),
        Some(SearchEvent::Done {
            truncated: true,
            ..
        })
    ));
    assert!(collect_in(Vec::new(), opts("foo")).is_err());
    std::fs::remove_dir_all(&first)?;
    std::fs::remove_dir_all(&second)?;
    Ok(())
}
