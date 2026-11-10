---
name: dependency-update
description: Update a dependency (or all outdated ones) safely — read its changelog for breaking changes, update the lock file with the project's package manager, fix what breaks, and run the checks and tests. Use when the user asks to upgrade, bump or update a package, library or toolchain version.
argument-hint: "[package]"
---

# Update dependencies safely

## Steps

1. **See what's outdated** with the project's own tool (`npm outdated`, `pnpm outdated`,
   `cargo outdated` or `cargo update --dry-run`, `pip list --outdated`, `go list -m -u all`).
   With `$ARGUMENTS`, only that package.
2. **Read the changelog** of each major or minor bump between the current and the new version:
   breaking changes, renamed options, a new minimum runtime version. Note what applies here.
3. **Update one at a time** (or one group that must move together) with the package manager, so
   the lock file changes with it. Never edit a lock file by hand.
4. **Fix what breaks:** build, type-check and lint; apply the migrations the changelog names.
5. **Run the tests.** When one fails, find out whether the update or the test is wrong.
6. **Report** each update: from → to, what changed in the code, anything left to watch.

## Don't

- Don't update everything in one step when something fails: you won't know which one broke it.
- Don't add `--force` or `--legacy-peer-deps` to get past an error without saying why.
- Check a new package's license when the project limits licenses.
