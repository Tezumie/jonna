import assert from "node:assert/strict";
import { test } from "node:test";
import { LogLevels, logLevelName, logLevelNumber } from "./logLevels";

test("log levels: the default, a channel's own, VS Code's numbers", () => {
  const levels = new LogLevels();
  assert.equal(levels.default, "info");
  assert.equal(levels.levelOf("ext.acme~log"), "info");
  levels.set("default", "debug");
  assert.equal(levels.levelOf("ext.acme~log"), "debug");
  levels.set("ext.acme~log", "error");
  levels.set("ext.other~log", "trace");
  assert.equal(levels.levelOf("ext.acme~log"), "error");
  // One extension hears the default and its own channels only.
  assert.deepEqual(levels.messageFor("ext.acme~"), {
    default: 2,
    channels: { "ext.acme~log": 5 },
  });
  // Back to the default: its own level goes; Info as the default isn't stored.
  levels.set("ext.acme~log", null);
  levels.set("default", "info");
  assert.deepEqual(levels.toJSON(), { "ext.other~log": "trace" });
  assert.equal(logLevelNumber("off"), 0);
  assert.equal(logLevelName(4), "warning");
  assert.equal(logLevelName(9), undefined);
});

test("log levels: saved ones load, bad keys and levels are skipped", () => {
  const levels = new LogLevels();
  levels.load({ default: "warning", "ext.a~x": "off", "ext.a~y": "loud", other: "trace" });
  assert.deepEqual(levels.toJSON(), { default: "warning", "ext.a~x": "off" });
  levels.load(null);
  assert.deepEqual(levels.toJSON(), {});
});
