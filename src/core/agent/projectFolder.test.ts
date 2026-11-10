import assert from "node:assert/strict";
import { test } from "node:test";
import { pathInMessage, suggestFolderName } from "./projectFolder";

test("folder names from requests", () => {
  assert.equal(suggestFolderName("make a snake game in python"), "snake-game-python");
  assert.equal(suggestFolderName("Can you build me a simple todo app with React?"), "todo-react");
  assert.equal(suggestFolderName("create a landing page for my bakery"), "landing-page-bakery");
  assert.equal(suggestFolderName("hello"), "hello");
  assert.equal(suggestFolderName("make it"), "new-project");
  assert.equal(suggestFolderName("build an AI chat UI"), "ai-chat-ui");
});

test("a place named in the request", () => {
  assert.equal(pathInMessage("make a game in C:\\dev\\games", null), "C:\\dev\\games");
  assert.equal(pathInMessage("put it under ~/code/site.", "/home/me"), "/home/me/code/site");
  assert.equal(pathInMessage("make a snake game", "/home/me"), null);
});
