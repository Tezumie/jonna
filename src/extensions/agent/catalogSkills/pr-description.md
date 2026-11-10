---
name: pr-description
description: Write a pull request title and description from the branch's commits and diff, following the repository's template when it has one — what changed, why, how it was tested, what reviewers should look at. Use when the user is opening or updating a pull request.
---

# Pull request description

## Steps

1. **Collect the change:** the base branch (`main` unless the user says otherwise),
   `git log --no-merges <base>..HEAD` and `git diff <base>...HEAD --stat`, then the diff of the
   files that matter.
2. **Look for a template:** `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`,
   `docs/pull_request_template.md`. Fill it in when there is one; otherwise use the shape below.
3. **Draft** and show it. Open or update the pull request only when the user asks.

## Shape

- **Title:** what it does, in the imperative, under 70 characters ("Retry uploads after a
  network error").
- **Summary:** two or three sentences: the problem and the approach.
- **Changes:** a short list by area, not by file.
- **Testing:** the tests added or run, and the manual steps someone can repeat.
- **Notes for reviewers:** what's risky, what was left out on purpose, follow-ups.
- Link the issue it closes ("Closes #123") when the commits or branch name name one.
