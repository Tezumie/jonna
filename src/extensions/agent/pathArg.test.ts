import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPathArg } from "./pathArg";

test("path arguments from weak models", () => {
  assert.equal(
    cleanPathArg("path:\\C:\\Users\\me\\proj\\temp_scaffold"),
    "C:\\Users\\me\\proj\\temp_scaffold",
  );
  assert.equal(cleanPathArg(" `src/app.ts` "), "src/app.ts");
  assert.equal(cleanPathArg("cwd = web"), "web");
  assert.equal(cleanPathArg("/C:/x"), "C:/x");
  assert.equal(cleanPathArg("src/path:x"), "src/path:x");
  assert.equal(cleanPathArg("/home/me/proj"), "/home/me/proj");
});
