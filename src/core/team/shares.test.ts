import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ShareCopy,
  ShareInfo,
  ShareMember,
  ShareMemberState,
  ShareState,
  ShareSynced,
  ShareWaiting,
} from "../ipc/share";
import {
  acceptKeyWords,
  askSentence,
  audienceSentence,
  canRead,
  chatsSentence,
  chatsToShare,
  cloneQuestion,
  copyReport,
  fingerprintGroups,
  KEY_FILES_NOTE,
  keyFilesLine,
  keysDue,
  memberActions,
  memberLabel,
  memberLine,
  memberTag,
  nameList,
  newsSentence,
  noTeamCode,
  ownShareOf,
  parseTeamShareScheme,
  readerChoices,
  readersLine,
  refreshDue,
  SHARE_KEYS_MS,
  SHARE_PAGE_MS,
  SHARE_PURPOSE,
  SHARE_REFRESH_MS,
  SHARE_RENEW_MS,
  sameFingerprint,
  sameReaders,
  shareAudience,
  sharedChatDocument,
  sharedChatTitle,
  shareErrorWords,
  shareLabel,
  shareRefusal,
  shareStateLine,
  sortMembers,
  sortShares,
  splitShareId,
  syncSentence,
  teamShareScheme,
  toggledReaders,
  unshareQuestion,
  verifyWords,
  waitingLines,
  waitingWhy,
} from "./shares";

const member = (uid: string, name: string, state: ShareMemberState, you = false): ShareMember => ({
  uid,
  name,
  you,
  state,
  fingerprint: state === "nokey" ? null : "12345 67890 12345 67890 12345 67890",
  pendingFingerprint: state === "changed" ? "11111 22222 33333 44444 55555 66666" : null,
  pinnedAt: state === "nokey" ? null : 5,
});

const share = (id: string, name: string, owner: string, state: ShareState): ShareInfo => ({
  id,
  project: splitShareId(id).project,
  name,
  chats: false,
  owner: { uid: splitShareId(id).owner, name: owner },
  mine: state === "mine",
  state,
  keyVersion: 1,
  rotationNeeded: false,
  usageBytes: 0,
  updatedAt: null,
  latest: null,
  chosen: false,
  readers: null,
});

const waiting = (name: string, why: ShareWaiting["why"]): ShareWaiting => ({
  uid: `u-${name}`,
  name,
  why,
});

test("sharing: what it is, in the words under the switch", () => {
  assert.equal(
    SHARE_PURPOSE,
    "Your team can see this project's snapshots and open a copy. They can't change it.",
  );
  assert.equal(KEY_FILES_NOTE, "Key files (.env, keys and tokens) are left out of what is shared.");
});

test("sharing: a share's id and the content source of its files", () => {
  assert.deepEqual(splitShareId("uid123.proj456"), { owner: "uid123", project: "proj456" });
  // An account's id may hold a dot; a project's never does.
  assert.deepEqual(splitShareId("a.b.proj"), { owner: "a.b", project: "proj" });
  assert.deepEqual(splitShareId("nodot"), { owner: "", project: "nodot" });

  const scheme = teamShareScheme("uid.proj", "1700000000000-dev");
  assert.equal(scheme, "teamShare:uid.proj/1700000000000-dev");
  assert.deepEqual(parseTeamShareScheme(scheme), {
    share: "uid.proj",
    snapshot: "1700000000000-dev",
  });
  for (const not of ["syncSnapshot:snap.x/1", "teamShare:", "teamShare:/1", "teamShare:uid.proj/"])
    assert.equal(parseTeamShareScheme(not), null, not);
});

test("sharing: names in a sentence", () => {
  assert.equal(nameList([]), "");
  assert.equal(nameList(["Ana"]), "Ana");
  assert.equal(nameList(["Ana", "Sam"]), "Ana and Sam");
  assert.equal(nameList(["Ana", "Sam", "Kim"]), "Ana, Sam and Kim");
  assert.equal(nameList(["A", "B", "C", "D", "E", "F", "G", "H"]), "A, B, C, D, E and 3 more");
  // A member the service gave no name for still reads as someone.
  assert.equal(nameList(["", "Sam"]), "A teammate and Sam");
});

test("sharing: a member's state as a tag, a line, and what can be done", () => {
  assert.equal(memberTag("verified"), "Verified");
  assert.equal(memberTag("new"), "Not verified");
  assert.equal(memberTag("changed"), "Key changed");
  assert.equal(memberTag("nokey"), "No key yet");

  assert.deepEqual(memberActions(member("a", "Ana", "new")), ["verify"]);
  assert.deepEqual(memberActions(member("a", "Ana", "verified")), ["unmark"]);
  assert.deepEqual(memberActions(member("a", "Ana", "changed")), ["accept"]);
  assert.deepEqual(memberActions(member("a", "Ana", "nokey")), []);
  // Nothing to do about yourself, whatever the state says.
  assert.deepEqual(memberActions(member("me", "Me", "new", true)), []);

  for (const state of ["verified", "new", "changed", "nokey"] as const)
    assert.ok(memberLine({ state, you: false }).length > 0, state);
  assert.match(memberLine({ state: "changed", you: false }), /until you accept the new key/);
  assert.match(memberLine({ state: "nokey", you: false }), /sync on/);
  assert.match(memberLine({ state: "new", you: true }), /This is you/);
});

test("sharing: a fingerprint is read in six groups of five, and compared by its digits", () => {
  const thirty = "123456789012345678901234567890";
  const grouped = "12345 67890 12345 67890 12345 67890";
  assert.equal(fingerprintGroups(thirty), grouped);
  // As the backend hands it over (grouped already), and however else it was typed.
  assert.equal(fingerprintGroups(grouped), grouped);
  assert.equal(fingerprintGroups("1234 5678 9012 3456 7890 1234 5678 90"), grouped);
  assert.equal(fingerprintGroups(grouped)?.split(" ").length, 6);
  assert.equal(fingerprintGroups("12345-67890"), "12345 67890");
  assert.equal(fingerprintGroups(null), null);
  assert.equal(fingerprintGroups(""), null);

  assert.equal(sameFingerprint(grouped, thirty), true);
  assert.equal(sameFingerprint(grouped, "12345 67890 12345 67890 12345 67891"), false);
  assert.equal(sameFingerprint("1234 5678", "12345678"), true);
  assert.equal(sameFingerprint("1234 5678", "1234 5679"), false);
  // Nothing equals nothing: two missing fingerprints are not "the same".
  assert.equal(sameFingerprint("", ""), false);
  assert.equal(sameFingerprint(null, undefined), false);
});

test("sharing: members are listed with you first, then a changed key, then by name", () => {
  const sorted = sortMembers([
    member("z", "Zed", "verified"),
    member("k", "kim", "new"),
    member("c", "Cy", "changed"),
    member("me", "Me", "new", true),
    member("a", "Ana", "nokey"),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["Me", "Cy", "Ana", "kim", "Zed"],
  );
  assert.deepEqual(memberLabel(member("a", "Ana", "changed")), {
    uid: "a",
    name: "Ana",
    you: false,
    state: "changed",
  });
});

test("sharing: the dialogs show the fingerprint that is acted on", () => {
  const verify = verifyWords("Ana", "123456789012345678901234567890");
  assert.equal(verify.title, "Mark Ana as verified?");
  assert.match(verify.message, /12345 67890 12345 67890 12345 67890/);
  assert.match(verify.message, /Sync, Team, People/);
  assert.match(verify.message, /every digit matches/);

  const accept = acceptKeyWords("Ana", "11111 22222 33333 44444 55555 66666");
  assert.equal(accept.title, "Accept the new key of Ana?");
  assert.match(accept.message, /changed/);
  assert.match(accept.message, /reset sync/);
  assert.match(accept.message, /something is wrong/);
  assert.match(accept.message, /11111 22222 33333 44444 55555 66666/);
  assert.match(accept.message, /not verified afterwards/);
  // A member without a name.
  assert.equal(verifyWords(" ", "1").title, "Mark this teammate as verified?");
});

test("sharing: a copy asks before it clones, showing the address and whose it is", () => {
  const asked = cloneQuestion("https://example.com/owner/repo.git", "Ana", "notes");
  assert.equal(asked.title, "Clone notes first?");
  assert.match(
    asked.message,
    /^Clone from https:\/\/example\.com\/owner\/repo\.git first\? It is the address Ana works from\./,
  );
  assert.match(asked.message, /nothing asks you to sign in/);
  assert.match(asked.message, /Choose No to copy without cloning/);
  // Without names.
  const bare = cloneQuestion("git@example.com:o/r.git", " ", "");
  assert.equal(bare.title, "Clone the project first?");
  assert.match(bare.message, /the address the teammate who shares it works from/);
  // A copy of a project this account shares itself.
  assert.match(cloneQuestion("git@example.com:o/r.git", "Me", "x", true).message, /you work from/);
});

test("sharing: why someone is waiting for a share's keys", () => {
  assert.equal(waitingWhy("noKey"), "hasn't opened the IDE with sync on yet");
  assert.equal(waitingWhy("noKey", true), "haven't opened the IDE with sync on yet");
  assert.equal(waitingWhy("notVerified"), "isn't verified");
  assert.equal(waitingWhy("keyChanged"), "key changed");

  assert.deepEqual(waitingLines([]), []);
  const one = waitingLines([waiting("Sam", "noKey")]);
  assert.equal(one.length, 1);
  assert.ok(one[0]?.startsWith("Waiting for keys: Sam hasn't opened the IDE with sync on yet."));

  const all = waitingLines([
    waiting("Sam", "noKey"),
    waiting("Kim", "keyChanged"),
    waiting("Ana", "notVerified"),
    waiting("Bo", "noKey"),
    waiting("Cy", "notVerified"),
  ]);
  assert.equal(all.length, 3);
  assert.ok(
    all[0]?.startsWith("Waiting for keys: Sam and Bo haven't opened the IDE with sync on yet."),
  );
  assert.ok(all[1]?.startsWith("Ana and Cy aren't verified"));
  assert.ok(all[2]?.startsWith("Kim's key changed"));
  assert.ok(
    waitingLines([waiting("Kim", "keyChanged"), waiting("Lu", "keyChanged")])[0]?.startsWith(
      "Kim's and Lu's keys changed",
    ),
  );
});

test("sharing: who a share reaches", () => {
  const members = [
    member("me", "Me", "verified", true),
    member("a", "Ana", "verified"),
    member("s", "Sam", "new"),
    member("k", "Kim", "changed"),
    member("b", "Bo", "nokey"),
  ];
  // Worked out from where each key stands: everyone with a key that didn't change.
  assert.deepEqual(shareAudience(members, false), {
    readers: ["Ana", "Sam"],
    waiting: [
      { uid: "k", name: "Kim", why: "keyChanged" },
      { uid: "b", name: "Bo", why: "noKey" },
    ],
  });
  // Only verified teammates: the unverified one waits too.
  const strict = shareAudience(members, true);
  assert.deepEqual(strict.readers, ["Ana"]);
  assert.deepEqual(
    strict.waiting.map((entry) => [entry.name, entry.why]),
    [
      ["Kim", "keyChanged"],
      ["Bo", "noKey"],
      ["Sam", "notVerified"],
    ],
  );
  // What the last share sync said wins over the guess.
  const known = shareAudience(
    members,
    false,
    [waiting("Sam", "noKey")].map((w) => ({ ...w, uid: "s" })),
  );
  assert.deepEqual(known.readers, ["Kim", "Ana", "Bo"]);
  assert.deepEqual(known.waiting, [{ uid: "s", name: "Sam", why: "noKey" }]);
  // Alone in the team.
  assert.deepEqual(shareAudience([member("me", "Me", "new", true)], false), {
    readers: [],
    waiting: [],
  });

  assert.equal(readersLine([]), "Nobody else in your team can read it yet.");
  assert.equal(readersLine(["Ana"]), "1 teammate can read it: Ana.");
  assert.equal(readersLine(["Ana", "Sam"]), "2 teammates can read it: Ana and Sam.");
});

test("sharing: the sentence after a share sync", () => {
  const synced = (over: Partial<ShareSynced>): ShareSynced => ({
    id: "u.p",
    snapshot: "17-d",
    keyFiles: 0,
    wrapsAdded: 0,
    renewed: false,
    waiting: [],
    audienceUnknown: false,
    ...over,
  });
  assert.equal(keyFilesLine(0), "");
  assert.equal(keyFilesLine(1), "1 key file was left out.");
  assert.equal(keyFilesLine(3), "3 key files were left out.");

  assert.equal(syncSentence(synced({})), "A snapshot was shared with your team.");
  assert.equal(
    syncSentence(synced({ snapshot: null })),
    "Nothing changed since the last shared snapshot.",
  );
  assert.equal(
    syncSentence(synced({ keyFiles: 3 })),
    "A snapshot was shared with your team. 3 key files were left out.",
  );
  const full = syncSentence(
    synced({
      keyFiles: 1,
      wrapsAdded: 2,
      renewed: true,
      waiting: [waiting("Sam", "noKey")],
    }),
  );
  assert.ok(
    full.startsWith(
      "A snapshot was shared with your team. 1 key file was left out. The share's keys were renewed. 2 teammates got the keys. Waiting for keys: Sam hasn't opened the IDE with sync on yet.",
    ),
    full,
  );
});

test("sharing: the question before a share is stopped", () => {
  assert.deepEqual(unshareQuestion("notes", "Studio"), {
    title: "Stop sharing notes?",
    message:
      "Stop sharing notes with Studio? The shared copy is deleted; your own synced copy is untouched.",
  });
  // The team's owner stopping a teammate's share.
  assert.match(
    unshareQuestion("notes", "Studio", "Ana").message,
    /Ana's own synced copy is untouched/,
  );
  assert.match(unshareQuestion("", "").message, /^Stop sharing this project with your team\?/);
});

test("sharing: how a share stands for this account", () => {
  assert.equal(canRead("mine"), true);
  assert.equal(canRead("ready"), true);
  assert.equal(canRead("waiting"), false);
  assert.equal(canRead("keyChanged"), false);

  assert.equal(shareStateLine(share("me.p", "notes", "Me", "mine")), "Shared by you");
  assert.equal(shareStateLine(share("a.p", "notes", "Ana", "ready")), null);
  assert.equal(
    shareStateLine(share("a.p", "notes", "Ana", "waiting")),
    "Waiting for keys from Ana",
  );
  assert.equal(
    shareStateLine(share("a.p", "notes", "Ana", "keyChanged")),
    "Ana's key changed: check People",
  );

  assert.equal(shareRefusal(share("a.p", "notes", "Ana", "ready")), null);
  assert.equal(shareRefusal(share("me.p", "notes", "Me", "mine")), null);
  assert.match(
    shareRefusal(share("a.p", "notes", "Ana", "waiting")) ?? "",
    /haven't reached you yet/,
  );
  assert.match(shareRefusal(share("a.p", "notes", "Ana", "keyChanged")) ?? "", /under People/);
});

test("sharing: shares are listed by name, then by whose they are", () => {
  const sorted = sortShares([
    share("s.p2", "zeta", "Sam", "ready"),
    share("b.p1", "Alpha", "Bo", "waiting"),
    share("a.p1", "alpha", "Ana", "ready"),
    share("me.p3", "mid", "Me", "mine"),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.id),
    ["a.p1", "b.p1", "me.p3", "s.p2"],
  );

  const shares = [share("me.p3", "mid", "Me", "mine"), share("a.p3", "mid", "Ana", "ready")];
  assert.equal(ownShareOf(shares, "p3")?.id, "me.p3");
  // A teammate's share of a project with the same id isn't this account's.
  assert.equal(ownShareOf([share("a.p3", "mid", "Ana", "ready")], "p3"), undefined);
  assert.equal(ownShareOf(shares, null), undefined);
  assert.equal(ownShareOf(shares, "other"), undefined);

  // Labels only: no key version, no usage.
  assert.deepEqual(shareLabel(share("a.p1", "alpha", "Ana", "ready")), {
    id: "a.p1",
    project: "p1",
    name: "alpha",
    owner: "Ana",
    mine: false,
    state: "ready",
    latest: null,
    // Whether its chats travel and whether it is for chosen people; never who they are.
    chats: false,
    chosen: false,
  });
});

test("sharing: what opening a copy came to", () => {
  const copy = (over: Partial<ShareCopy>): ShareCopy => ({
    path: "C:/work/copy",
    cloned: true,
    note: null,
    restored: { files: 3, deleted: 0, branch: "main", detached: false, notes: [], stashed: null },
    ...over,
  });
  const cloned = copyReport(copy({}), "notes");
  assert.equal(cloned.title, "A copy of notes is ready");
  assert.match(cloned.lines[0] ?? "", /cloned from the project's remote/);
  assert.match(cloned.lines[0] ?? "", /3 files written on main/);
  assert.ok(cloned.lines.includes("C:/work/copy"));
  assert.match(cloned.lines[cloned.lines.length - 1] ?? "", /not trusted until you say so/);

  const plain = copyReport(
    copy({
      cloned: false,
      note: "The remote couldn't be cloned from: no access.",
      restored: {
        files: 1,
        deleted: 0,
        branch: null,
        detached: false,
        notes: ["A file was too large."],
        stashed: null,
      },
    }),
    "",
  );
  assert.equal(plain.title, "A copy of the project is ready");
  assert.match(plain.lines[0] ?? "", /^The snapshot's 1 file was written into the folder\./);
  assert.match(plain.lines[0] ?? "", /wasn't cloned/);
  assert.equal(plain.lines[1], "The remote couldn't be cloned from: no access.");
  assert.equal(plain.lines[2], "A file was too large.");
});

test("sharing: a refused call as a sentence", () => {
  for (const code of [
    "ShareNoTeam",
    "ShareNotMember",
    "ShareWaiting",
    "ShareKeyChanged",
    "ShareNoMemberKey",
    "ShareNotSharer",
    "ShareGone",
    "ShareNotShared",
    "ShareTooMany",
    "ShareKeys",
    "ShareTargetNotEmpty",
    "SyncLapsed",
    "SyncFull",
  ]) {
    const words = shareErrorWords(code, "raw text from the call");
    assert.notEqual(words, "raw text from the call", code);
    assert.match(words, /\.$/, code);
  }
  assert.match(shareErrorWords("ShareTargetNotEmpty", ""), /new or an empty folder/);
  assert.match(shareErrorWords("SyncLapsed", ""), /can still be read/);
  assert.equal(shareErrorWords("SyncSignedOut", "x"), "Sign in to your account to use sync.");
  // A code with no sentence of its own says what the call said.
  assert.equal(
    shareErrorWords("Share", "That member has no key yet."),
    "That member has no key yet.",
  );
  assert.equal(shareErrorWords("", "  "), "Sharing failed.");

  assert.equal(noTeamCode("ShareNoTeam"), true);
  assert.equal(noTeamCode("ShareNotMember"), true);
  assert.equal(noTeamCode("ShareGone"), false);
});

test("sharing: nothing is read or seen to more often than every few minutes", () => {
  const now = 100 * 60_000;
  // Never read: read, whatever asks.
  assert.equal(refreshDue("loop", 0, now), true);
  assert.equal(refreshDue("page", 0, now), true);
  // The loop: every few minutes.
  assert.equal(refreshDue("loop", now - SHARE_REFRESH_MS + 1, now), false);
  assert.equal(refreshDue("loop", now - SHARE_REFRESH_MS, now), true);
  assert.ok(SHARE_REFRESH_MS >= 3 * 60_000);
  // A page being shown: again, unless it was read a moment ago.
  assert.equal(refreshDue("page", now - SHARE_PAGE_MS + 1, now), false);
  assert.equal(refreshDue("page", now - SHARE_PAGE_MS, now), true);
  // Asked for: always.
  assert.equal(refreshDue("now", now - 1, now), true);

  // A share's keys with no snapshot taken: not yet looked at, then now and then.
  assert.equal(keysDue(false, 0, now), true);
  assert.equal(keysDue(false, now - SHARE_KEYS_MS + 1, now), false);
  assert.equal(keysDue(false, now - SHARE_KEYS_MS, now), true);
  // The service wants new keys: sooner, but not every pass.
  assert.equal(keysDue(true, now - SHARE_RENEW_MS + 1, now), false);
  assert.equal(keysDue(true, now - SHARE_RENEW_MS, now), true);
  assert.ok(SHARE_RENEW_MS >= 60_000 && SHARE_RENEW_MS < SHARE_KEYS_MS);
});

const person = (uid: string, name: string, state: ShareMemberState, you = false): ShareMember => ({
  uid,
  name,
  you,
  state,
  fingerprint: null,
  pendingFingerprint: null,
  pinnedAt: null,
});

test("D453: a share for chosen people reaches them and nobody else", () => {
  const team = [
    person("me", "Me", "verified", true),
    person("ana", "Ana", "verified"),
    person("ben", "Ben", "new"),
    person("cy", "Cy", "nokey"),
  ];
  // The whole team: as before.
  assert.deepEqual(shareAudience(team, false).readers, ["Ana", "Ben"]);
  // Chosen: only they are readers, and only they are waited for.
  const chosen = shareAudience(team, false, null, ["ben", "cy"]);
  assert.deepEqual(chosen.readers, ["Ben"]);
  assert.deepEqual(
    chosen.waiting.map((w) => w.uid),
    ["cy"],
  );
  // What the last sync said of someone who isn't chosen any more is not shown.
  const known: ShareWaiting[] = [{ uid: "ana", name: "Ana", why: "notVerified" }];
  assert.deepEqual(shareAudience(team, true, known, ["ben"]).waiting, []);

  const rows = readerChoices(team, ["ben", "cy", "gone"], true);
  assert.deepEqual(
    rows.map((r) => [r.uid, r.picked]),
    [
      ["ana", false],
      ["ben", true],
      ["cy", true],
    ],
  );
  assert.equal(rows.find((r) => r.uid === "ana")?.note, "", "not picked: nothing to explain");
  assert.notEqual(rows.find((r) => r.uid === "ben")?.note, "", "picked, not verified: said");
  assert.ok(readerChoices(team, null, false).every((r) => r.picked));

  // Choosing people starts with everyone; unticking takes one off; someone gone isn't kept.
  assert.deepEqual(toggledReaders(team, null, "", false), ["ana", "ben", "cy"]);
  assert.deepEqual(toggledReaders(team, null, "ben", false), ["ana", "cy"]);
  assert.deepEqual(toggledReaders(team, ["ben", "gone"], "ana", true), ["ana", "ben"]);
  assert.deepEqual(toggledReaders(team, ["ben"], "stranger", true), ["ben"]);
  assert.deepEqual(toggledReaders(team, ["ben"], "me", true), ["ben"], "never oneself");

  assert.equal(sameReaders(null, null), true);
  assert.equal(sameReaders(null, []), false);
  assert.equal(sameReaders(["a", "b"], ["b", "a"]), true);
  assert.equal(audienceSentence(team, null), "Shared with your whole team.");
  assert.equal(audienceSentence(team, ["ben", "ana"]), "Shared with Ana and Ben only.");
  assert.equal(audienceSentence(team, []), "Shared with nobody else yet.");
  assert.match(shareErrorWords("ShareNeedsService", "x"), /whole team/);
});

test("D454: which chats are shared, and what a pass says", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const chats = [
    { id: "old", workspace: "C:/p", updated: 1 },
    { id: "new", workspace: "c:/P", updated: 9 },
    { id: "other", workspace: "C:/q", updated: 5 },
    { id: "loose", workspace: null, updated: 7 },
    { id: "busy", workspace: "C:/p", updated: 8 },
  ];
  // The project's own, newest first: never another folder's, never one with no folder.
  assert.deepEqual(
    chatsToShare(chats, "C:/p", same, (id) => id === "busy"),
    ["new", "old"],
  );
  assert.deepEqual(chatsToShare(chats, "C:/none", same), []);
  const many = Array.from({ length: 130 }, (_, i) => ({
    id: `c${i}`,
    workspace: "r",
    updated: i,
  }));
  const kept = chatsToShare(many, "r", same);
  assert.equal(kept.length, 100);
  assert.equal(kept[0], "c129");

  const none = { written: 0, unchanged: 4, removed: 0, skipped: 0, keyFiles: 0 };
  assert.equal(chatsSentence(none), "");
  assert.equal(
    chatsSentence({ written: 2, unchanged: 0, removed: 1, skipped: 1, keyFiles: 3 }),
    "2 chats shared. 1 chat taken out of what is shared. Tool calls that named key files were left out (3). 1 chat will follow.",
  );
  assert.equal(sharedChatTitle({ title: "  " }), "Untitled chat");
  assert.equal(
    sharedChatDocument({ title: "Fix the build" }, "Sam"),
    "Fix the build (Sam, shared).txt",
  );
});

test("D455: what is said when a teammate shares, or asks", () => {
  const shared = (id: string, name: string, owner: string, mine = false) => ({
    id,
    name,
    mine,
    owner: { uid: id.split(".")[0] ?? "", name: owner },
  });
  const shares = [
    shared("sam.p1", "Webshop", "Sam"),
    shared("me.p2", "Mine", "Me", true),
    shared("ana.p3", "Docs", ""),
  ];
  assert.equal(newsSentence([], shares), null);
  assert.deepEqual(newsSentence([{ id: "sam.p1", kind: "project" }], shares), {
    message: "Sam shared a project: Webshop.",
    share: "sam.p1",
  });
  assert.equal(
    newsSentence([{ id: "ana.p3", kind: "chats" }], shares)?.message,
    "A teammate shared the chats of Docs.",
  );
  // One's own, and one that isn't listed, are never news.
  assert.equal(
    newsSentence(
      [
        { id: "me.p2", kind: "project" },
        { id: "x.y", kind: "project" },
      ],
      shares,
    ),
    null,
  );
  assert.deepEqual(
    newsSentence(
      [
        { id: "sam.p1", kind: "project" },
        { id: "ana.p3", kind: "project" },
      ],
      shares,
    ),
    { message: "Your team shared 2 new things.", share: null },
  );
  assert.equal(askSentence([]), "");
  assert.equal(askSentence([{ name: "Sam" }]), "Sam asked you to share a project.");
  assert.equal(
    askSentence([{ name: "Sam" }, { name: " " }]),
    "Sam and A teammate asked you to share a project.",
  );
});
