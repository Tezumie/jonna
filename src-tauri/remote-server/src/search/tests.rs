use std::time::Duration;

use super::*;
use crate::outbox::Out;

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
    }
}

fn setup(name: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("rs-search-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src"))?;
    std::fs::create_dir_all(dir.join("dist"))?;
    std::fs::write(dir.join(".gitignore"), "dist/\n")?;
    std::fs::write(dir.join("src/a.ts"), "const Foo = 1;\nfoo(Foo);\n// food\n")?;
    std::fs::write(dir.join("src/b.md"), "no match here\nFOO bar\n")?;
    std::fs::write(dir.join("dist/out.js"), "foo foo foo\n")?;
    std::fs::write(dir.join("src/bin.dat"), b"foo\x00\x01")?;
    Ok(crate::workspace::canonicalize(&dir)?)
}

fn collect_in(roots: Vec<PathBuf>, o: SearchOptions) -> Result<Vec<SearchEvent>> {
    let matcher = matcher(&o)?;
    let walkers = roots
        .into_iter()
        .map(|root| walker(&root, &o).map(|w| (root, w)))
        .collect::<Result<Vec<_>>>()?;
    let events = std::cell::RefCell::new(Vec::new());
    run(walkers, o, matcher, &AtomicBool::new(false), |e| {
        events.borrow_mut().push(e)
    });
    Ok(events.into_inner())
}

fn collect(root: &Path, o: SearchOptions) -> Result<Vec<SearchEvent>> {
    collect_in(vec![root.to_path_buf()], o)
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
fn multi_line_detection_and_crlf() {
    let mut o = opts(r"a\nb");
    assert!(!is_multi_line(&o));
    o.is_regex = true;
    assert!(is_multi_line(&o));
    o.query = r"a\\nb".into();
    assert!(!is_multi_line(&o));
    assert!(is_multi_line(&opts("one\ntwo")));
    assert_eq!(crlf_tolerant(r"a\nb"), r"a\r?\nb");
    assert_eq!(crlf_tolerant(r"[^\n]+\n"), r"[^\n]+\r?\n");
    assert_eq!(crlf_tolerant(r"[]\n]\n"), r"[]\n]\r?\n");
}

#[test]
fn multi_line_regex_reports_the_first_line() -> Result<()> {
    let dir = setup("multi")?;
    std::fs::write(
        dir.join("src/a.ts"),
        "start\nfoo(\n  bar)\nfoo(\n  baz)\nfoo(x)\n",
    )?;
    std::fs::write(dir.join("src/b.md"), "foo(\r\n  bar)\r\n")?;
    let mut o = opts(r"foo\(\n\s*ba");
    o.is_regex = true;
    assert_eq!(
        file_matches(&collect(&dir, o)?),
        vec![
            ("src/a.ts".into(), 2, vec![(0, 4)]),
            ("src/a.ts".into(), 4, vec![(0, 4)]),
            ("src/b.md".into(), 1, vec![(0, 4)]),
        ]
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[test]
fn one_search_runs_every_folder_with_paths_relative_to_each() -> Result<()> {
    let first = setup("roots-a")?;
    let second = setup("roots-b")?;
    // A folder nested in the first: its files are reported once, in the first folder.
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
    assert!(Path::new(&files[0].0).starts_with(&first));
    assert!(Path::new(&files[1].0).starts_with(&second));
    assert!(matches!(
        events.last(),
        Some(SearchEvent::Done {
            files: 2,
            matches: 2,
            ..
        })
    ));
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
    std::fs::remove_dir_all(&first)?;
    std::fs::remove_dir_all(&second)?;
    Ok(())
}

/// The events as the app gets them: `search.event { search, event }`, `event.kind` naming it.
#[test]
fn searches_send_named_events_and_refuse_bad_input() -> Result<()> {
    let root = setup("named")?;
    let (out, rx) = Outbox::new();
    let searches = Searches::default();
    assert!(searches
        .start(json!(1), vec![root.clone()], opts(""), out.clone())
        .is_err());
    let mut bad = opts("(");
    bad.is_regex = true;
    assert!(searches
        .start(json!(1), vec![root.clone()], bad, out.clone())
        .is_err());
    assert!(searches
        .start(json!(1), vec![], opts("foo"), out.clone())
        .is_err());
    searches.start(json!("s-1"), vec![root.clone()], opts("foo"), out)?;
    let mut kinds = Vec::new();
    while let Ok(Out::Frame(bytes)) = rx.recv_timeout(Duration::from_secs(10)) {
        let message: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(message["notify"], "search.event");
        assert_eq!(message["params"]["search"], "s-1");
        let kind = message["params"]["event"]["kind"]
            .as_str()
            .map(String::from);
        let done = kind.as_deref() == Some("done");
        kinds.push(kind);
        if done {
            let event = &message["params"]["event"];
            assert_eq!(event["files"], 2);
            assert!(event["durationMs"].is_u64());
            break;
        }
    }
    assert_eq!(kinds.len(), 3);
    std::fs::remove_dir_all(&root)?;
    Ok(())
}
