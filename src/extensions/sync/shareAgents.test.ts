import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARE_COMMANDS, SHARE_COMMANDS_AGENTS_MAY_RUN, shareCommandAgent } from "./model";

test("sharing: what sends, opens or settles keys is the person's, not an agent's", () => {
  // Uploading the folder's state to other people, and putting a teammate's file into a tab
  // or a folder, are never an agent's to start.
  for (const id of [
    "sync.project.share",
    "sync.project.unshare",
    "sync.project.shareNow",
    "team.member.verify",
    "team.member.acceptKey",
    "team.startOver",
    "team.copyFingerprint",
    "team.share.openFile",
    "team.share.openCopy",
    // Who sees a project and its chats; a teammate's chat in a tab or among one's own chats;
    // a note sent to a teammate.
    "sync.project.shareWith",
    "sync.project.shareChats",
    "team.share.readChat",
    "team.share.continueChat",
    "team.member.askToShare",
    "team.asks.dismiss",
  ])
    assert.equal(shareCommandAgent(id), "hidden", id);
  // Lists and labels, read only, stay within an agent's reach.
  for (const id of [
    "team.members",
    "team.shares.list",
    "team.share.snapshots",
    "team.share.files",
    "team.share.view",
    "team.share.chats",
  ])
    assert.equal(shareCommandAgent(id), "discoverable", id);
  // Every command an agent may run is one of sharing's, and a new one is hidden until listed.
  for (const id of SHARE_COMMANDS_AGENTS_MAY_RUN) assert.ok(SHARE_COMMANDS.includes(id), id);
  assert.equal(shareCommandAgent("team.share.somethingNew"), "hidden");
});
