---
name: write-tests
description: Add unit tests for a function, module or bug fix in the style the project already uses (its framework, file layout, naming and helpers), and run them. Use when the user asks for tests, coverage, or a regression test for a fix.
argument-hint: "[file or function]"
---

# Write tests the project's way

## Steps

1. **Learn the project's test style first.** Find two or three existing tests near the code
   (`*.test.*`, `*_test.*`, `tests/`, `__tests__/`): the framework, how files are named and where
   they live, the assertion style, shared helpers and fixtures. Find the command that runs them
   (package.json scripts, Makefile, CI config).
2. **List the cases** before writing: the normal path, each branch, the edges (empty, one, many,
   invalid input, errors), and for a bug fix the exact input that failed.
3. **Write the tests** beside the existing ones, in their style. One behavior per test, named for
   what it shows ("rejects an empty name"), not for the function.
4. **Run them.** A new test for a fix should fail without the fix: check it when you can (stash the
   fix, run, restore).
5. **Report** what's covered and what isn't, and why.

## Don't

- Don't add a new test framework or library when the project has one.
- Don't test private details that may change; test what callers see.
- Don't mock what's cheap to run for real (pure functions, in-memory stores).
