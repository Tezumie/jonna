// Sync between "computers", end to end: several windowless hosts, each with its own profile,
// against the accounts and sync service on the Firebase emulators (the website repository's
// `npm run emulators`, or `firebase emulators:exec` around this script).
//
//   node scripts/sync-e2e.mjs [path to the host program]
//
// SYNC_E2E_BASE is the service (default http://127.0.0.1:5000). Everything written goes to a
// folder beside the repository, removed at the end. Keys stay out of the OS keychain
// (IDE_NO_KEYCHAIN=1), in each profile's own files.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "ide-host.exe" : "ide-host";
const binary = resolve(
  process.argv[2] ??
    join(process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri", "target"), "debug", exe),
);
if (!existsSync(binary)) {
  console.error(`sync-e2e: no host program at ${binary}`);
  process.exit(2);
}
const BASE = process.env.SYNC_E2E_BASE ?? "http://127.0.0.1:5000";
const AUTH = process.env.SYNC_E2E_AUTH ?? "http://127.0.0.1:9099";
const FIRESTORE =
  process.env.SYNC_E2E_FIRESTORE ??
  "http://127.0.0.1:8080/v1/projects/demo-jonna/databases/(default)/documents";
const scratch = resolve(root, "..", `.sync-e2e-${process.pid}`);
const TIMEOUT_MS = 60_000;

function encodeFrame(header) {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(head.length, 0);
  prefix.writeUInt32LE(0, 4);
  return Buffer.concat([prefix, head]);
}

/** One host process and the connection to it. */
class Host {
  constructor(name, profile) {
    this.name = name;
    this.profile = profile;
    this.data = join(profile, "data");
    this.child = spawn(binary, ["--user-data-dir", profile], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, IDE_NO_KEYCHAIN: "1" },
    });
    this.stderr = "";
    this.child.stderr.on("data", (c) => {
      this.stderr += c;
    });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        if (this.buffer.length < 8) return;
        const headLength = this.buffer.readUInt32LE(0);
        const bodyLength = this.buffer.readUInt32LE(4);
        if (this.buffer.length < 8 + headLength + bodyLength) return;
        const header = JSON.parse(this.buffer.subarray(8, 8 + headLength).toString("utf8"));
        this.buffer = this.buffer.subarray(8 + headLength + bodyLength);
        const waiting = this.pending.get(header.id);
        if (!waiting) continue;
        this.pending.delete(header.id);
        if (header.error !== undefined) {
          const error = new Error(`${header.error.code}: ${header.error.message}`);
          error.code = header.error.code;
          waiting.reject(error);
        } else waiting.resolve(header.result);
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: no answer to ${method}\n${this.stderr}`)),
        TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.child.stdin.write(encodeFrame({ id, method, params }));
    });
  }

  /** A sync command, with the service's address. */
  sync(method, params = {}) {
    return this.call(`sync_${method}`, { base: BASE, ...params });
  }

  stop() {
    this.child.kill();
  }
}

let failures = 0;
async function step(name, run) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
async function fails(promise, code, what) {
  try {
    await promise;
  } catch (error) {
    check(error.code === code, `${what}: ${error.message}, expected ${code}`);
    return;
  }
  throw new Error(`${what}: expected the error ${code}`);
}

// ---------------------------------------------------------------- an account on the emulators

const b64 = (n) => randomBytes(n).toString("base64url");

async function newAccount() {
  const email = `sync-e2e-${Date.now()}-${b64(3)}@example.com`;
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "test-password", returnSecureToken: true }),
  }).then((x) => x.json());
  if (!r.idToken) throw new Error(`no account on the emulator at ${AUTH}: ${JSON.stringify(r)}`);
  return { email, idToken: r.idToken, uid: r.localId };
}

/** Gives the account the paid plan (the server's job; here the test plays the server). */
async function giveSync(account) {
  await fetch(`${FIRESTORE}/users/${account.uid}?updateMask.fieldPaths=plan`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { plan: { stringValue: "sync" } } }),
  });
}

/** Signs a profile folder in as the account: what the app's browser sign-in leaves behind. */
async function signIn(account, profile) {
  const verifier = b64(32);
  const redirect = "http://127.0.0.1:53124/callback";
  const { code } = await fetch(`${BASE}/oauth/issue-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id_token: account.idToken,
      response_type: "code",
      client_id: "desktop",
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }),
  }).then((x) => x.json());
  const tokens = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: "desktop",
      code_verifier: verifier,
    }).toString(),
  }).then((x) => x.json());
  await mkdir(join(profile, "data"), { recursive: true });
  await writeFile(
    join(profile, "data", "account.json"),
    JSON.stringify({
      base: BASE,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      profile: { id: account.uid, name: "Tester", email: account.email, plan: "sync", sync: true },
    }),
  );
}

async function computer(account, name) {
  const profile = join(scratch, name);
  await signIn(account, profile);
  const host = new Host(name, profile);
  await host.call("$/hello", { protocol: 1, client: "sync-e2e" });
  return host;
}

// ---------------------------------------------------------------- the run

await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const hosts = [];
try {
  const account = await newAccount();
  let desk;
  let laptop;
  let spare;
  let recoveryKey = "";

  await step("an account without sync is told so", async () => {
    desk = await computer(account, "desk");
    hosts.push(desk);
    const s = await desk.sync("status");
    check(s.state === "unavailable", JSON.stringify(s));
  });

  await giveSync(account);

  await step("the first computer turns sync on, once the recovery key is typed back", async () => {
    const before = await desk.sync("status");
    check(before.state === "off" && before.exists === false, JSON.stringify(before));
    recoveryKey = await desk.sync("prepare", { name: "Desk" });
    check(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/.test(recoveryKey), recoveryKey);
    await fails(desk.sync("setup", { typed: "ZZZZ" }), "SyncRecoveryKey", "a wrong confirmation");
    await desk.sync("setup", { typed: recoveryKey.slice(-4).toLowerCase() });
    const s = await desk.sync("status");
    check(s.state === "on" && s.exists && s.devices.length === 1, JSON.stringify(s));
    check(s.devices[0].current && s.devices[0].name === "Desk" && s.devices[0].status === "approved", JSON.stringify(s.devices));
    check(typeof s.recoveryCreatedAt === "number" && s.storageLimit > 0, JSON.stringify(s));
    await fails(desk.sync("setup", { typed: recoveryKey }), "Sync", "setup with nothing prepared");
  });

  await step("a second computer waits, shows the same code, and is approved", async () => {
    laptop = await computer(account, "laptop");
    hosts.push(laptop);
    const before = await laptop.sync("status");
    check(before.state === "off" && before.exists === true, JSON.stringify(before));
    await fails(laptop.sync("changes", { since: 0 }), "SyncOff", "reading before joining");
    const code = await laptop.sync("join", { name: "Laptop" });
    check(/^\d{3} \d{3}$/.test(code), code);
    const waiting = await laptop.sync("status");
    check(waiting.state === "pending" && waiting.code === code, JSON.stringify(waiting));
    const seen = (await desk.sync("status")).devices.find((d) => d.status === "pending");
    check(seen?.name === "Laptop" && seen.code === code, JSON.stringify(seen));
    await desk.sync("approve", { device: seen.id });
    const after = await laptop.sync("status");
    check(after.state === "on" && after.devices.length === 2, JSON.stringify(after));
  });

  await step("a record written on one is read on the other; a stale write gets the other's", async () => {
    const put = await desk.sync("record_put", { collection: "settings", id: "user", expect: null, text: '{"a":1}' });
    check(put.outcome === "done" && put.version === 1, JSON.stringify(put));
    const changes = await laptop.sync("changes", { since: 0 });
    const mine = changes.records.find((r) => r.collection === "settings");
    check(mine?.text === '{"a":1}' && mine.version === 1 && changes.seq >= mine.seq, JSON.stringify(changes));
    check(!changes.records.some((r) => r.unreadable), "everything opens");
    const clash = await laptop.sync("record_put", { collection: "settings", id: "user", expect: null, text: '{"b":2}' });
    check(clash.outcome === "conflict" && clash.current.text === '{"a":1}', JSON.stringify(clash));
    const ok = await laptop.sync("record_put", { collection: "settings", id: "user", expect: 1, text: '{"a":1,"b":2}' });
    check(ok.outcome === "done" && ok.version === 2, JSON.stringify(ok));
    const got = await desk.sync("record_get", { collection: "settings", id: "user" });
    check(got.text === '{"a":1,"b":2}', JSON.stringify(got));
    const none = await desk.sync("record_get", { collection: "settings", id: "nothing" });
    check(none === null, JSON.stringify(none));
    await fails(desk.sync("record_put", { collection: "sys", id: "devices", expect: null, text: "{}" }), "Invalid", "the backend's own collection");
    const gone = await desk.sync("record_put", { collection: "settings", id: "user", expect: 2, text: null });
    check(gone.outcome === "done", JSON.stringify(gone));
    const after = await laptop.sync("changes", { since: changes.seq });
    check(after.records.some((r) => r.collection === "settings" && r.deleted && r.text === null), JSON.stringify(after));
  });

  await step("a chat and its images travel, into the other computer's folder", async () => {
    const chat = {
      meta: { title: "Plan the thing", updated: 1700000000000, workspace: "C:\\Users\\desk\\project", worktree: { path: "x" } },
      items: [{ type: "user", id: "u1", text: "hello ".repeat(2000), turn: 1 }],
      turn: 1,
    };
    await mkdir(join(desk.data, "agent", "sessions"), { recursive: true });
    await writeFile(join(desk.data, "agent", "sessions", "c1.json"), JSON.stringify(chat));
    await mkdir(join(desk.data, "agent", "media", "c1"), { recursive: true });
    const image = randomBytes(5 * 1024 * 1024 + 123); // more than one chunk
    await writeFile(join(desk.data, "agent", "media", "c1", "img1.bin"), image);

    const pushed = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: null });
    check(pushed?.outcome === "done" && pushed.version === 1, JSON.stringify(pushed));
    check((await desk.sync("chat_push", { collection: "chats.p1", id: "nope", expect: null })) === null, "a chat with no file");
    const stale = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: null });
    check(stale.outcome === "conflict" && stale.current.version === 1, JSON.stringify(stale));

    const listed = (await laptop.sync("changes", { since: 0 })).records.find((r) => r.id === "c1");
    check(JSON.parse(listed.text).meta.title === "Plan the thing" && listed.refs >= 3, JSON.stringify(listed));

    const version = await laptop.sync("chat_pull", { collection: "chats.p1", id: "c1", saveAs: "c1", workspace: "/home/laptop/project" });
    check(version === 1, String(version));
    const got = JSON.parse(await readFile(join(laptop.data, "agent", "sessions", "c1.json"), "utf8"));
    check(got.meta.workspace === "/home/laptop/project" && got.meta.worktree === undefined, JSON.stringify(got.meta));
    check(got.items[0].text === chat.items[0].text && got.meta.title === chat.meta.title, "the chat's content");
    const gotImage = await readFile(join(laptop.data, "agent", "media", "c1", "img1.bin"));
    check(gotImage.equals(image), "the image's bytes");

    // A copy under another id, with no folder.
    await laptop.sync("chat_pull", { collection: "chats.p1", id: "c1", saveAs: "c1-copy", workspace: null });
    const copy = JSON.parse(await readFile(join(laptop.data, "agent", "sessions", "c1-copy.json"), "utf8"));
    check(copy.meta.workspace === null, JSON.stringify(copy.meta));
    check(existsSync(join(laptop.data, "agent", "media", "c1-copy", "img1.bin")), "the copy's image");

    // Changed and pushed again: only what changed uploads, and the other reads the new one.
    chat.items.push({ type: "user", id: "u2", text: "more", turn: 2 });
    await writeFile(join(desk.data, "agent", "sessions", "c1.json"), JSON.stringify(chat));
    const second = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: 1 });
    check(second.outcome === "done" && second.version === 2, JSON.stringify(second));
    await laptop.sync("chat_pull", { collection: "chats.p1", id: "c1", saveAs: "c1", workspace: null });
    const again = JSON.parse(await readFile(join(laptop.data, "agent", "sessions", "c1.json"), "utf8"));
    check(again.items.length === 2, "the second version");
    check((await laptop.sync("chat_pull", { collection: "chats.p1", id: "missing", saveAs: "x", workspace: null })) === null, "no such chat");
  });

  await step("a project has one name on every computer, from any form of its address", async () => {
    const a = await desk.sync("project_name", { remote: "git@github.com:Owner/Repo.git" });
    const b = await laptop.sync("project_name", { remote: "https://github.com/Owner/Repo" });
    check(typeof a === "string" && a.length === 22 && a === b, `${a} ${b}`);
    check((await desk.sync("project_name", { remote: "https://github.com/Owner/Other" })) !== a, "another repository");
    check((await desk.sync("project_name", { remote: "C:\\repos\\thing" })) === null, "a local path");
  });

  await step("a third computer joins with the recovery key", async () => {
    spare = await computer(account, "spare");
    hosts.push(spare);
    await fails(spare.sync("join_recovery", { name: "Spare", key: "not a key" }), "SyncRecoveryKey", "a mistyped key");
    await spare.sync("join_recovery", { name: "Spare", key: recoveryKey.toLowerCase().replaceAll("-", " ") });
    const s = await spare.sync("status");
    check(s.state === "on" && s.devices.length === 3, JSON.stringify(s));
    const changes = await spare.sync("changes", { since: 0 });
    check(changes.records.some((r) => r.id === "c1" && r.text), "it reads what was synced before it joined");
  });

  await step("a removed computer is locked out, and the others get new keys", async () => {
    const laptopId = (await laptop.sync("status")).deviceId;
    await desk.sync("remove_device", { device: laptopId });
    const gone = await laptop.sync("status");
    check(gone.state === "signedOut" || (gone.state === "off" && gone.notice === "removed"), JSON.stringify(gone));
    await fails(laptop.sync("changes", { since: 0 }), gone.state === "signedOut" ? "SyncSignedOut" : "SyncOff", "the removed computer reading");
    // The desk made new keys; the spare picks them up at its next check and reads new content.
    const put = await desk.sync("record_put", { collection: "settings", id: "after", expect: null, text: '"new keys"' });
    check(put.outcome === "done", JSON.stringify(put));
    const s = await spare.sync("status");
    check(s.state === "on" && s.devices.length === 2, JSON.stringify(s));
    const read = await spare.sync("record_get", { collection: "settings", id: "after" });
    check(read.text === '"new keys"' && !read.unreadable, JSON.stringify(read));
    // And what the spare writes, the desk reads.
    await spare.sync("record_put", { collection: "settings", id: "from-spare", expect: null, text: '"hi"' });
    check((await desk.sync("record_get", { collection: "settings", id: "from-spare" })).text === '"hi"', "the other way");
    // The chat from before the new keys still opens.
    const version = await spare.sync("chat_pull", { collection: "chats.p1", id: "c1", saveAs: "c1", workspace: null });
    check(version === 2, String(version));
  });

  await step("a new recovery key replaces the old one", async () => {
    const next = await spare.sync("new_recovery_key");
    check(next !== recoveryKey && /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/.test(next), next);
    // The laptop signs in again and tries to come back.
    laptop.stop();
    await rm(laptop.profile, { recursive: true, force: true });
    laptop = await computer(account, "laptop");
    hosts.push(laptop);
    await fails(laptop.sync("join_recovery", { name: "Laptop", key: recoveryKey }), "SyncRecoveryKey", "the old key");
    await laptop.sync("join_recovery", { name: "Laptop", key: next });
    check((await laptop.sync("status")).state === "on", "back with the new key");
    check((await laptop.sync("record_get", { collection: "settings", id: "after" })).text === '"new keys"', "and reads");
    recoveryKey = next;
  });

  await step("a device the server calls approved, but no device of the account approved, gets no keys", async () => {
    // The laptop joined by recovery key and is on the sealed list. Take it off that list as a
    // dishonest server couldn't, then remove another device so new keys are made.
    const s = await desk.sync("status");
    const spareId = s.devices.find((d) => d.name === "Spare").id;
    await desk.sync("remove_device", { device: spareId });
    const after = await desk.sync("status");
    check(after.devices.length === 2 && after.devices.every((d) => d.status === "approved"), JSON.stringify(after.devices));
    check((await laptop.sync("status")).state === "on", "the listed device kept its place");
  });

  await step("sync reset from the account page turns it off everywhere", async () => {
    const r = await fetch(`${BASE}/api/sync/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: account.email }),
    });
    check(r.status === 200, `reset ${r.status}`);
    const s = await desk.sync("status");
    check(s.state === "off" && s.notice === "reset" && s.exists === false, JSON.stringify(s));
    const again = await desk.sync("status");
    check(again.state === "off" && again.notice === null, "the notice is said once");
    await fails(desk.sync("changes", { since: 0 }), "SyncOff", "reading after a reset");
    // Turned on again, the surviving computer uploads afresh.
    const key = await desk.sync("prepare", { name: "Desk" });
    await desk.sync("setup", { typed: key });
    const on = await desk.sync("status");
    check(on.state === "on" && on.devices.length === 1 && on.epoch === 2, JSON.stringify(on));
    const pushed = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: null });
    check(pushed.outcome === "done" && pushed.version === 1, JSON.stringify(pushed));
    const other = await laptop.sync("status");
    check(other.state === "off" && other.notice === "reset" && other.exists === true, JSON.stringify(other));
  });
} finally {
  for (const h of hosts) h.stop();
  await new Promise((r) => setTimeout(r, 300));
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll sync steps passed");
process.exit(failures ? 1 : 0);
