---
name: debug-systematically
description: Track down a bug step by step — reproduce it, narrow it down, form one hypothesis at a time and test it, fix the cause rather than the symptom, and prove the fix with a test. Use when something fails, crashes, hangs or gives a wrong result and the cause isn't obvious.
---

# Debug systematically

## Steps

1. **Reproduce.** Get the exact command, input and output. Write the smallest script or test that
   shows the failure. If it doesn't reproduce, find out what differs (versions, environment,
   data, timing) before changing code.
2. **Read the error fully.** The first error in the output, its stack and the line it points to;
   not only the last line.
3. **Narrow it down.** Halve the input, the code path or the commit range (`git bisect`) until
   the failing part is small. Add logging where a value goes wrong, not everywhere.
4. **One hypothesis at a time.** Say what you think causes it and what result would prove you
   wrong, then run that check. Note each hypothesis and its result.
5. **Fix the cause.** Change the code that makes the value wrong, not the place that notices it.
   Look for the same mistake elsewhere.
6. **Prove it.** The reproduction now passes; turn it into a regression test; run the related
   tests. Remove the temporary logging.
7. **Report:** the cause in one sentence, the fix, and how it's tested.

## Don't

- Don't change several things at once: you won't know which one mattered.
- Don't silence an error (an empty catch, a skipped test) to make it go away.
