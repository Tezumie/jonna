---
name: review-checklist
description: Review a change (the working tree, a branch or a pull request) against a fixed checklist — correctness, edge cases, error handling, tests, naming, security — and report only findings that are verified. Use when the user asks for a review, a second look, or "anything wrong with this?".
---

# Review against a checklist

Edit the checklist below to match your team's playbook; the steps stay the same.

## Steps

1. **Find the change.** With no target given, review the uncommitted changes (`git diff` and
   `git diff --staged`); a branch: `git diff <base>...HEAD`; a pull request: its diff.
2. **Read around it.** For every changed function, read its callers and the code it calls. A
   finding needs the context, not only the hunk.
3. **Go through the checklist** for each file. Note a finding only when you can name the input
   or state that makes it go wrong.
4. **Verify** each finding: read the code again, or run the test that shows it. Drop what you
   can't support.
5. **Report** with `report_findings` (most severe first), or say plainly that nothing turned up.

## Checklist

- **Correctness:** off-by-one, wrong operator, inverted condition, a value used before it's set,
  a promise not awaited, state mutated while it's iterated.
- **Edge cases:** empty input, one element, very large input, unicode and Windows paths, a
  missing file, a network error, two calls at once.
- **Errors:** caught and dropped silently; messages that don't say what to do; cleanup skipped
  on the error path (files, timers, listeners).
- **Tests:** the change is covered; the test fails without it; no test only asserts a mock.
- **Names and shape:** names say what a thing is; no dead code; a function does one thing.
- **Security:** user input reaching a shell, a path, SQL or HTML unescaped; secrets in logs or
  in the repository.

## Don't

- Don't report style the formatter or linter already enforces.
- Don't restate the diff. Each finding says what breaks and when.
