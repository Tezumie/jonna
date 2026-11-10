---
name: release-notes
description: Draft release notes (or a CHANGELOG entry) from the commits since the last tag, grouped and written in a house style for users rather than developers. Use when the user is preparing a release, a version bump or a changelog.
argument-hint: "[version or range]"
---

# Release notes in a house style

Change the style rules below to your own; the steps stay the same.

## Steps

1. **Find the range.** `$ARGUMENTS` when given (a version or `v1.2.0..HEAD`); otherwise from the
   latest tag: `git describe --tags --abbrev=0`, then `git log --no-merges <tag>..HEAD`.
2. **Read the commits** and, where a subject is unclear, the diff or the pull request it came from.
3. **Sort** each change into: New, Improved, Fixed, Removed (and Security when there is one).
   Leave out refactors, test-only and build-only changes unless users notice them.
4. **Write** one line per change in the style below, then show the draft. If the project has a
   CHANGELOG.md, match its existing format and add the entry at the top.

## Style

- Written for the people who use the software: what they can do now, or what no longer goes
  wrong. Not how it was done.
- Present tense, sentence case, no period at the end of a line.
- Start with the thing that changed: "Search finds files in hidden folders", not "Fixed a bug
  where…".
- Name settings, commands and keys exactly as the user sees them, in `code`.
- Credit contributors outside the core team at the end of their line: (thanks @name).
- No emojis, no marketing words ("blazing", "seamless").
