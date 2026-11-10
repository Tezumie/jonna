// A stand-in "prettier" for tests/scripts/features-m6-39.jsonc: prints stdin in capitals, so the
// test can tell the project's formatter ran.
let text = "";
process.stdin.on("data", (chunk) => {
  text += chunk;
});
process.stdin.on("end", () => process.stdout.write(text.toUpperCase()));
