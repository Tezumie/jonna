import assert from "node:assert/strict";
import { test } from "node:test";
import { listeningLine, serveToken } from "./serve";

const random = () => "made-up-by-the-program";

test("serve: the token is the flag's, else the environment's, else made up", () => {
  assert.deepEqual(serveToken("from-flag", "from-env", random), {
    token: "from-flag",
    made: false,
  });
  assert.deepEqual(serveToken(undefined, "from-env", random), { token: "from-env", made: false });
  assert.deepEqual(serveToken(undefined, undefined, random), {
    token: "made-up-by-the-program",
    made: true,
  });
});

test("serve: an empty token is no token (it would let anyone attach)", () => {
  assert.deepEqual(serveToken("", "", random), { token: "made-up-by-the-program", made: true });
  assert.deepEqual(serveToken(undefined, "", random), {
    token: "made-up-by-the-program",
    made: true,
  });
});

test("serve: the ready line hands over a token the program made, never one the caller chose", () => {
  const made = JSON.parse(listeningLine(4100, "/ws", serveToken(undefined, undefined, random)));
  assert.deepEqual(made, {
    type: "listening",
    host: "127.0.0.1",
    port: 4100,
    token: "made-up-by-the-program",
    folder: "/ws",
  });
  for (const chosen of [
    serveToken("s3cret-flag", undefined, random),
    serveToken(undefined, "s3cret-env", random),
  ]) {
    const line = listeningLine(4100, "/ws", chosen);
    assert.ok(!line.includes("s3cret"), line);
    assert.deepEqual(JSON.parse(line), {
      type: "listening",
      host: "127.0.0.1",
      port: 4100,
      folder: "/ws",
    });
    assert.ok(line.endsWith("\n") && line.trimEnd().indexOf("\n") < 0);
  }
});
