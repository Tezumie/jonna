// Sync between "computers", end to end: several windowless hosts, each with its own profile,
// against the accounts and sync service on the Firebase emulators (the website repository's
// `npm run emulators`, or `firebase emulators:exec` around this script).
//
//   node scripts/sync-e2e.mjs [path to the host program]
//
// SYNC_E2E_BASE is the service (default http://127.0.0.1:5000). Everything written goes to a
// folder beside the repository, removed at the end. Keys stay out of the OS keychain
// (IDE_NO_KEYCHAIN=1), in each profile's own files.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
// The emulators' project: "demo-" and the product's short name, as the website's tests run it.
const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8"));
const PROJECT = process.env.SYNC_E2E_PROJECT ?? `demo-${product.nameShort.toLowerCase()}`;
const FIRESTORE =
  process.env.SYNC_E2E_FIRESTORE ??
  `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const scratch = resolve(root, "..", `.sync-e2e-${process.pid}`);
const TIMEOUT_MS = 120_000;
const gitConfig = join(scratch, "gitconfig");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

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
      env: { ...gitEnv, IDE_NO_KEYCHAIN: "1" },
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

/**
 * Ends the account's subscription, or brings it back (the billing webhook's job; here the test
 * plays it): the plan, and when the subscription that gave access stopped.
 */
async function setSubscription(account, active) {
  const patch = (path, mask, fields) =>
    fetch(`${FIRESTORE}/${path}?${mask.map((m) => `updateMask.fieldPaths=${m}`).join("&")}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  await patch(`users/${account.uid}`, ["plan"], {
    plan: { stringValue: active ? "sync" : "free" },
  });
  await patch(
    `billing/${account.uid}`,
    ["status", "lapsedAt"],
    active
      ? { status: { stringValue: "active" } }
      : {
          status: { stringValue: "canceled" },
          lapsedAt: { timestampValue: new Date().toISOString() },
        },
  );
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
await writeFile(
  gitConfig,
  '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[protocol "file"]\n\tallow = always\n',
);
const hosts = [];

/** Every file under a folder (not .git), as path to text. */
async function tree(dir, base = dir, out = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await tree(path, base, out);
    else out[path.slice(base.length + 1).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return out;
}
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
    check(
      s.devices[0].current && s.devices[0].name === "Desk" && s.devices[0].status === "approved",
      JSON.stringify(s.devices),
    );
    check(typeof s.recoveryCreatedAt === "number" && s.storageLimit > 0, JSON.stringify(s));
    await fails(desk.sync("setup", { typed: recoveryKey }), "Sync", "setup with nothing prepared");
  });

  await step("a second computer waits, shows the same code, and is approved", async () => {
    laptop = await computer(account, "laptop");
    hosts.push(laptop);
    const before = await laptop.sync("status");
    check(before.state === "off" && before.exists === true, JSON.stringify(before));
    await fails(laptop.sync("changes", { since: 0 }), "SyncOff", "reading before joining");
    await laptop.sync("join", { name: "Laptop" });
    const waiting = await laptop.sync("status");
    check(waiting.state === "pending" && waiting.code === null, JSON.stringify(waiting));
    const seen = (await desk.sync("status")).devices.find((d) => d.status === "pending");
    check(seen?.name === "Laptop" && seen.code === null, JSON.stringify(seen));
    // Not approved unseen. The laptop fixed its half of the code when it asked to join; the
    // desk now fixes the key it sees and gives its own half; only then does the laptop show
    // its half, so neither (nor the service between them) can steer the code.
    await fails(desk.sync("approve", { device: seen.id }), "Sync", "approving unchecked");
    const started = await desk.sync("review_device", { device: seen.id });
    check(!/d{3}/.test(JSON.stringify(started ?? null)), "the check returns no code");
    const early = (await desk.sync("status")).devices.find((d) => d.id === seen.id);
    check(early.code === null && early.checking === true, JSON.stringify(early));
    await fails(desk.sync("approve", { device: seen.id }), "Sync", "approving before the answer");
    // Reading its status is how the laptop answers.
    const shown = await laptop.sync("status");
    check(
      shown.state === "pending" && /^\d{3} \d{3}$/.test(shown.code ?? ""),
      JSON.stringify(shown),
    );
    const listed = (await desk.sync("status")).devices.find((d) => d.id === seen.id);
    check(listed.code === shown.code, JSON.stringify(listed));
    check((await laptop.sync("status")).code === shown.code, "the code stays the same");
    // A waiting computer can't read, write or remove anyone.
    await fails(laptop.sync("changes", { since: 0 }), "SyncOff", "a waiting computer reading");
    await desk.sync("approve", { device: seen.id });
    const after = await laptop.sync("status");
    check(after.state === "on" && after.devices.length === 2, JSON.stringify(after));
    // A computer gives itself another name; the other sees it.
    const kept = await laptop.sync("rename_device", { name: "  Travel laptop  " });
    check(kept === "Travel laptop", kept);
    const names = (await desk.sync("status")).devices.map((d) => d.name).sort();
    check(names.join() === "Desk,Travel laptop", names.join());
    await laptop.sync("rename_device", { name: "Laptop" });
  });

  await step(
    "a record written on one is read on the other; a stale write gets the other's",
    async () => {
      const put = await desk.sync("record_put", {
        collection: "settings",
        id: "user",
        expect: null,
        text: '{"a":1}',
      });
      check(put.outcome === "done" && put.version === 1, JSON.stringify(put));
      const changes = await laptop.sync("changes", { since: 0 });
      const mine = changes.records.find((r) => r.collection === "settings");
      check(
        mine?.text === '{"a":1}' && mine.version === 1 && changes.seq >= mine.seq,
        JSON.stringify(changes),
      );
      check(!changes.records.some((r) => r.unreadable), "everything opens");
      const clash = await laptop.sync("record_put", {
        collection: "settings",
        id: "user",
        expect: null,
        text: '{"b":2}',
      });
      check(
        clash.outcome === "conflict" && clash.current.text === '{"a":1}',
        JSON.stringify(clash),
      );
      const ok = await laptop.sync("record_put", {
        collection: "settings",
        id: "user",
        expect: 1,
        text: '{"a":1,"b":2}',
      });
      check(ok.outcome === "done" && ok.version === 2, JSON.stringify(ok));
      const got = await desk.sync("record_get", { collection: "settings", id: "user" });
      check(got.text === '{"a":1,"b":2}', JSON.stringify(got));
      const none = await desk.sync("record_get", { collection: "settings", id: "nothing" });
      check(none === null, JSON.stringify(none));
      await fails(
        desk.sync("record_put", { collection: "sys", id: "devices", expect: null, text: "{}" }),
        "Invalid",
        "the backend's own collection",
      );
      const gone = await desk.sync("record_put", {
        collection: "settings",
        id: "user",
        expect: 2,
        text: null,
      });
      check(gone.outcome === "done", JSON.stringify(gone));
      const after = await laptop.sync("changes", { since: changes.seq });
      check(
        after.records.some((r) => r.collection === "settings" && r.deleted && r.text === null),
        JSON.stringify(after),
      );
    },
  );

  await step("a chat and its images travel, into the other computer's folder", async () => {
    const chat = {
      meta: {
        title: "Plan the thing",
        updated: 1700000000000,
        workspace: "C:\\Users\\desk\\project",
        worktree: { path: "x" },
      },
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
    check(
      (await desk.sync("chat_push", { collection: "chats.p1", id: "nope", expect: null })) === null,
      "a chat with no file",
    );
    const stale = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: null });
    check(stale.outcome === "conflict" && stale.current.version === 1, JSON.stringify(stale));

    const listed = (await laptop.sync("changes", { since: 0 })).records.find((r) => r.id === "c1");
    check(
      JSON.parse(listed.text).meta.title === "Plan the thing" && listed.refs >= 3,
      JSON.stringify(listed),
    );

    const version = await laptop.sync("chat_pull", {
      collection: "chats.p1",
      id: "c1",
      saveAs: "c1",
      workspace: "/home/laptop/project",
    });
    check(version === 1, String(version));
    const got = JSON.parse(
      await readFile(join(laptop.data, "agent", "sessions", "c1.json"), "utf8"),
    );
    check(
      got.meta.workspace === "/home/laptop/project" && got.meta.worktree === undefined,
      JSON.stringify(got.meta),
    );
    check(
      got.items[0].text === chat.items[0].text && got.meta.title === chat.meta.title,
      "the chat's content",
    );
    const gotImage = await readFile(join(laptop.data, "agent", "media", "c1", "img1.bin"));
    check(gotImage.equals(image), "the image's bytes");

    // A copy under another id, with no folder.
    await laptop.sync("chat_pull", {
      collection: "chats.p1",
      id: "c1",
      saveAs: "c1-copy",
      workspace: null,
    });
    const copy = JSON.parse(
      await readFile(join(laptop.data, "agent", "sessions", "c1-copy.json"), "utf8"),
    );
    check(copy.meta.workspace === null, JSON.stringify(copy.meta));
    check(
      existsSync(join(laptop.data, "agent", "media", "c1-copy", "img1.bin")),
      "the copy's image",
    );

    // Changed and pushed again: only what changed uploads, and the other reads the new one.
    chat.items.push({ type: "user", id: "u2", text: "more", turn: 2 });
    await writeFile(join(desk.data, "agent", "sessions", "c1.json"), JSON.stringify(chat));
    const second = await desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: 1 });
    check(second.outcome === "done" && second.version === 2, JSON.stringify(second));
    // Over a chat that is here already, only when it is still as the caller saw it.
    const unseen = await laptop.sync("chat_pull", {
      collection: "chats.p1",
      id: "c1",
      saveAs: "c1",
      workspace: null,
    });
    check(unseen === null, "a chat here isn't replaced unseen");
    const [seenStamp] = await laptop.call("agent_session_stamps", { ids: ["c1"] });
    const replaced = await laptop.sync("chat_pull", {
      collection: "chats.p1",
      id: "c1",
      saveAs: "c1",
      workspace: null,
      ifStamp: seenStamp,
    });
    check(replaced === 2, String(replaced));
    await fails(
      laptop.sync("chat_pull", {
        collection: "chats.p1",
        id: "c1",
        saveAs: "../c1",
        workspace: null,
      }),
      "Invalid",
      "a chat saved under a path",
    );
    const again = JSON.parse(
      await readFile(join(laptop.data, "agent", "sessions", "c1.json"), "utf8"),
    );
    check(again.items.length === 2, "the second version");
    check(
      (await laptop.sync("chat_pull", {
        collection: "chats.p1",
        id: "missing",
        saveAs: "x",
        workspace: null,
      })) === null,
      "no such chat",
    );
  });

  await step("a project has one name on every computer, from any form of its address", async () => {
    const a = await desk.sync("project_name", { remote: "git@github.com:Owner/Repo.git" });
    const b = await laptop.sync("project_name", { remote: "https://github.com/Owner/Repo" });
    check(typeof a === "string" && a.length === 22 && a === b, `${a} ${b}`);
    check(
      (await desk.sync("project_name", { remote: "https://github.com/Owner/Other" })) !== a,
      "another repository",
    );
    check(
      (await desk.sync("project_name", { remote: "C:\\repos\\thing" })) === null,
      "a local path",
    );
  });

  await step("a git project's unfinished work is continued on another computer", async () => {
    // A shared remote, and the project cloned on both.
    const remote = join(scratch, "remote.git");
    git(scratch, "init", "-q", "--bare", remote);
    const deskProject = join(scratch, "desk-project");
    git(scratch, "clone", "-q", remote, deskProject);
    await writeFile(join(deskProject, ".gitignore"), "node_modules/\n*.log\n");
    await writeFile(join(deskProject, "a.txt"), "one\n");
    await writeFile(join(deskProject, "b.txt"), "two\n");
    await writeFile(join(deskProject, "gone.txt"), "will be deleted\n");
    git(deskProject, "add", "-A");
    git(deskProject, "commit", "-q", "-m", "first");
    git(deskProject, "push", "-q", "origin", "main");
    const laptopProject = join(scratch, "laptop-project");
    git(scratch, "clone", "-q", remote, laptopProject);

    // On the desk: a commit not pushed, on a new branch; something staged, something not,
    // a new file, a deleted one, and things git ignores.
    git(deskProject, "checkout", "-q", "-b", "feature");
    await writeFile(join(deskProject, "c.txt"), "committed, not pushed\n");
    git(deskProject, "add", "c.txt");
    git(deskProject, "commit", "-q", "-m", "second, unpushed");
    await writeFile(join(deskProject, "a.txt"), "one\nstaged line\n");
    git(deskProject, "add", "a.txt");
    await writeFile(join(deskProject, "a.txt"), "one\nstaged line\nunstaged line\n");
    await writeFile(join(deskProject, "b.txt"), "two changed\n");
    await mkdir(join(deskProject, "new dir"), { recursive: true });
    await writeFile(join(deskProject, "new dir", "untracked file.txt"), "new\n");
    await rm(join(deskProject, "gone.txt"));
    await mkdir(join(deskProject, "node_modules", "dep"), { recursive: true });
    await writeFile(join(deskProject, "node_modules", "dep", "index.js"), "ignored");
    await writeFile(join(deskProject, "debug.log"), "ignored");

    await desk.call("workspace_open", { path: deskProject });
    const made = await desk.sync("snapshot_create", {
      root: deskProject,
      collection: "snap.p1",
      everything: false,
      force: false,
    });
    check(
      made && made.summary.kind === "git" && made.summary.branch === "feature",
      JSON.stringify(made?.summary),
    );
    check(made.summary.files === 3 && made.summary.deleted === 1, JSON.stringify(made.summary));
    check(
      made.summary.deviceName === "Desk" &&
        made.summary.head === git(deskProject, "rev-parse", "HEAD"),
      "who and where",
    );
    const again = await desk.sync("snapshot_create", {
      root: deskProject,
      collection: "snap.p1",
      everything: false,
      force: false,
    });
    check(again === null, "nothing changed: no second snapshot");

    const listed = await laptop.sync("snapshot_files", { collection: "snap.p1", id: made.id });
    check(
      JSON.stringify(listed.map((f) => [f.path, f.deleted])) ===
        JSON.stringify([
          ["a.txt", false],
          ["b.txt", false],
          ["gone.txt", true],
          ["new dir/untracked file.txt", false],
        ]),
      JSON.stringify(listed),
    );

    await laptop.call("workspace_open", { path: laptopProject });
    check(
      (await laptop.sync("snapshot_local_changes", { root: laptopProject })).length === 0,
      "the laptop's copy is clean",
    );
    const restored = await laptop.sync("snapshot_restore", {
      collection: "snap.p1",
      id: made.id,
      root: laptopProject,
      stash: false,
    });
    check(
      restored.files === 3 &&
        restored.deleted === 1 &&
        restored.branch === "feature" &&
        !restored.detached,
      JSON.stringify(restored),
    );
    check(
      git(laptopProject, "rev-parse", "HEAD") === git(deskProject, "rev-parse", "HEAD"),
      "the same commit",
    );
    check(git(laptopProject, "symbolic-ref", "--short", "HEAD") === "feature", "the same branch");
    check(
      git(laptopProject, "status", "--porcelain") === git(deskProject, "status", "--porcelain"),
      `status: ${git(laptopProject, "status", "--porcelain")}`,
    );
    check(
      git(laptopProject, "diff", "--cached") === git(deskProject, "diff", "--cached"),
      "what was staged",
    );
    const [here, there] = [await tree(laptopProject), await tree(deskProject)];
    delete there["node_modules/dep/index.js"];
    delete there["debug.log"];
    check(JSON.stringify(here) === JSON.stringify(there), `files: ${JSON.stringify(here)}`);
  });

  await step("a restore doesn't overwrite local work without asking", async () => {
    const deskProject = join(scratch, "desk-project");
    const laptopProject = join(scratch, "laptop-project");
    await writeFile(join(deskProject, "b.txt"), "two changed again on the desk\n");
    const made = await desk.sync("snapshot_create", {
      root: deskProject,
      collection: "snap.p1",
      everything: false,
      force: false,
    });
    check(made !== null, "a changed file makes a new snapshot");
    // Unchanged files weren't read or sent again.
    check(made.uploadedBytes < 2000, `uploaded ${made.uploadedBytes}`);
    await writeFile(join(laptopProject, "local.txt"), "the laptop's own work\n");
    const dirty = await laptop.sync("snapshot_local_changes", { root: laptopProject });
    check(dirty.includes("local.txt"), JSON.stringify(dirty));
    await fails(
      laptop.sync("snapshot_restore", {
        collection: "snap.p1",
        id: made.id,
        root: laptopProject,
        stash: false,
      }),
      "SyncDirty",
      "a restore over local changes",
    );
    check(
      (await readFile(join(laptopProject, "local.txt"), "utf8")).includes("own work"),
      "nothing was touched",
    );
    const restored = await laptop.sync("snapshot_restore", {
      collection: "snap.p1",
      id: made.id,
      root: laptopProject,
      stash: true,
    });
    check(restored.stashed?.includes("Desk"), JSON.stringify(restored));
    check(
      git(laptopProject, "stash", "list").includes("Before continuing from Desk"),
      "the local work is in a stash",
    );
    check(
      (await readFile(join(laptopProject, "b.txt"), "utf8")) === "two changed again on the desk\n",
      "the new content",
    );
    check(
      git(laptopProject, "status", "--porcelain") === git(deskProject, "status", "--porcelain"),
      "status again",
    );
    // One file from the earlier snapshot.
    const first = (await laptop.sync("changes", { since: 0 })).records
      .filter((r) => r.collection === "snap.p1" && !r.deleted)
      .map((r) => r.id)
      .sort()[0];
    await laptop.sync("snapshot_restore_file", {
      collection: "snap.p1",
      id: first,
      root: laptopProject,
      path: "b.txt",
    });
    check(
      (await readFile(join(laptopProject, "b.txt"), "utf8")) === "two changed\n",
      "one file, from the older snapshot",
    );
    await fails(
      laptop.sync("snapshot_restore_file", {
        collection: "snap.p1",
        id: first,
        root: laptopProject,
        path: "../outside.txt",
      }),
      "Sync",
      "a path outside the project",
    );
  });

  await step("a git project with no remote travels whole, then only what is new", async () => {
    const source = join(scratch, "desk-solo");
    await mkdir(source, { recursive: true });
    git(source, "init", "-q");
    await writeFile(join(source, "big.txt"), randomBytes(300_000).toString("base64"));
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "one");
    // Two stashes: both travel, in order (only the newest is a ref).
    await writeFile(join(source, "big.txt"), "stashed first\n");
    git(source, "stash", "push", "-q", "-m", "older idea");
    await writeFile(join(source, "big.txt"), "stashed second\n");
    git(source, "stash", "push", "-q", "-m", "newer idea");
    await writeFile(join(source, "note.txt"), "uncommitted\n");
    await desk.call("workspace_open", { path: source });
    const first = await desk.sync("snapshot_create", {
      root: source,
      collection: "snap.solo",
      everything: false,
      force: false,
    });
    check(first.summary.kind === "git" && first.summary.files === 1, JSON.stringify(first.summary));

    // The other computer has nothing: an empty folder becomes the project.
    const target = join(scratch, "laptop-solo");
    await mkdir(target, { recursive: true });
    await laptop.call("workspace_open", { path: target });
    const restored = await laptop.sync("snapshot_restore", {
      collection: "snap.solo",
      id: first.id,
      root: target,
      stash: false,
    });
    check(restored.branch === "main" && restored.files === 1, JSON.stringify(restored));
    check(
      git(target, "log", "--format=%H %s") === git(source, "log", "--format=%H %s"),
      "the same history",
    );
    check(
      git(target, "stash", "list", "--format=%gs") ===
        git(source, "stash", "list", "--format=%gs") &&
        git(target, "stash", "list").includes("older idea"),
      `stashes: ${git(target, "stash", "list")}`,
    );
    check(
      JSON.stringify(await tree(target)) === JSON.stringify(await tree(source)),
      "the same files",
    );

    // A second commit: the next snapshot carries a small bundle, not the history again.
    await writeFile(join(source, "note.txt"), "committed now\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "two");
    const second = await desk.sync("snapshot_create", {
      root: source,
      collection: "snap.solo",
      everything: false,
      force: false,
    });
    check(
      second.uploadedBytes < 20_000,
      `the second snapshot uploaded ${second.uploadedBytes} bytes`,
    );
    const next = await laptop.sync("snapshot_restore", {
      collection: "snap.solo",
      id: second.id,
      root: target,
      stash: false,
    });
    check(!next.detached, JSON.stringify(next));
    check(
      git(target, "log", "--format=%H %s") === git(source, "log", "--format=%H %s"),
      "both commits",
    );
    check(git(target, "status", "--porcelain") === "", "clean, as on the desk");
    check(
      !git(target, "stash", "list").includes("Before continuing") &&
        git(target, "stash", "list", "--format=%gs") ===
          git(source, "stash", "list", "--format=%gs"),
      "the first snapshot's changes were replaced, not stashed; the desk's stashes are the only ones",
    );
    // The laptop holds the desk's state: it stores nothing of its own until something changes.
    const own = await laptop.sync("snapshot_create", {
      root: target,
      collection: "snap.solo",
      everything: false,
      force: false,
    });
    check(own === null, "no snapshot of a state that is a snapshot");
    await writeFile(join(target, "laptop.txt"), "work done on the laptop\n");
    const mine = await laptop.sync("snapshot_create", {
      root: target,
      collection: "snap.solo",
      everything: false,
      force: false,
    });
    check(
      mine?.summary.deviceName === "Laptop" && mine.summary.files === 1,
      JSON.stringify(mine?.summary),
    );
    // And back on the desk, which was left as that second snapshot.
    const back = await desk.sync("snapshot_restore", {
      collection: "snap.solo",
      id: mine.id,
      root: source,
      stash: false,
    });
    check(
      back.files === 1 && (await readFile(join(source, "laptop.txt"), "utf8")).includes("laptop"),
      JSON.stringify(back),
    );
  });

  await step("a folder without git travels, minus the heavy folders", async () => {
    const source = join(scratch, "desk-folder");
    await mkdir(join(source, "src", "deep"), { recursive: true });
    await mkdir(join(source, "node_modules", "x"), { recursive: true });
    await writeFile(join(source, "readme.md"), "# hello\n");
    await writeFile(join(source, "src", "deep", "main.py"), "print('hi')\n");
    await writeFile(join(source, "node_modules", "x", "index.js"), "heavy");
    await desk.call("workspace_open", { path: source });
    const made = await desk.sync("snapshot_create", {
      root: source,
      collection: "snap.folder",
      everything: false,
      force: false,
    });
    check(made.summary.kind === "folder" && made.summary.files === 2, JSON.stringify(made.summary));
    const target = join(scratch, "laptop-folder");
    await mkdir(target, { recursive: true });
    await laptop.call("workspace_open", { path: target });
    const restored = await laptop.sync("snapshot_restore", {
      collection: "snap.folder",
      id: made.id,
      root: target,
      stash: false,
    });
    check(restored.files === 2, JSON.stringify(restored));
    check(
      JSON.stringify(await tree(target)) ===
        JSON.stringify({ "readme.md": "# hello\n", "src/deep/main.py": "print('hi')\n" }),
      JSON.stringify(await tree(target)),
    );
    // The laptop edits a file; the desk makes a newer snapshot: restoring it asks first.
    const snap = (host, root) =>
      host.sync("snapshot_create", {
        root,
        collection: "snap.folder",
        everything: false,
        force: false,
      });
    const bring = (id, stash) =>
      laptop.sync("snapshot_restore", { collection: "snap.folder", id, root: target, stash });
    await writeFile(join(target, "readme.md"), "# the laptop's own words\n");
    await writeFile(join(source, "readme.md"), "# hello again\n");
    const newer = await snap(desk, source);
    await fails(bring(newer.id, false), "SyncDirty", "a folder's own edit");
    check((await readFile(join(target, "readme.md"), "utf8")).includes("laptop"), "left alone");
    const forced = await bring(newer.id, true);
    check((await readFile(join(target, "readme.md"), "utf8")) === "# hello again\n", "replaced");
    check(
      forced.notes.some((n) => n.includes("earlier versions")),
      JSON.stringify(forced.notes),
    );
    // A third snapshot replaces what the second put there without asking.
    await writeFile(join(source, "readme.md"), "# hello a third time\n");
    const third = await snap(desk, source);
    await bring(third.id, false);
    check(
      (await readFile(join(target, "readme.md"), "utf8")) === "# hello a third time\n",
      "a restored folder follows",
    );
    await fails(
      desk.sync("snapshot_create", {
        root: scratch,
        collection: "snap.folder",
        everything: false,
        force: true,
      }),
      "OutsideScope",
      "a folder that isn't the open one",
    );
  });

  await step("a pinned snapshot is named; a deleted one frees its storage", async () => {
    const all = (await desk.sync("changes", { since: 0 })).records.filter(
      (r) => r.collection === "snap.solo" && !r.deleted,
    );
    check(all.length === 3, `${all.length} snapshots`);
    await desk.sync("snapshot_pin", {
      collection: "snap.solo",
      id: all[0].id,
      name: "Before the rewrite",
    });
    const pinned = await laptop.sync("record_get", { collection: "snap.solo", id: all[0].id });
    check(
      JSON.parse(pinned.text).pinned === "Before the rewrite" && pinned.refs === all[0].refs,
      pinned.text,
    );
    // Still restorable after the pin rewrote its record.
    const files = await laptop.sync("snapshot_files", { collection: "snap.solo", id: all[0].id });
    check(files.length === 1, JSON.stringify(files));
    const before = (await desk.sync("status")).usageBytes;
    for (const r of (await desk.sync("changes", { since: 0 })).records.filter(
      (x) => x.collection === "snap.solo" && !x.deleted,
    )) {
      const gone = await desk.sync("record_put", {
        collection: "snap.solo",
        id: r.id,
        expect: r.version,
        text: null,
      });
      check(gone.outcome === "done", JSON.stringify(gone));
    }
    const after = await desk.sync("gc");
    check(typeof after === "number" && after < before - 250_000, `${before} then ${after}`);
    await fails(
      laptop.sync("snapshot_files", { collection: "snap.solo", id: all[0].id }),
      "Sync",
      "a deleted snapshot",
    );
    // What the other snapshots need is still there.
    const kept = (await desk.sync("changes", { since: 0 })).records.find(
      (r) => r.collection === "snap.folder" && !r.deleted,
    );
    check(
      (await laptop.sync("snapshot_files", { collection: "snap.folder", id: kept.id })).length ===
        2,
      "the others still open",
    );
    // A chat deleted on one computer is a sealed marker: the other can't fetch it as a chat.
    const marker = await desk.sync("record_put", {
      collection: "chats.p1",
      id: "gone",
      expect: null,
      text: JSON.stringify({ deleted: true }),
    });
    check(marker.outcome === "done", JSON.stringify(marker));
    const fetched = await laptop.sync("chat_pull", {
      collection: "chats.p1",
      id: "gone",
      saveAs: "gone",
      workspace: null,
    });
    check(fetched === null, "a deleted chat isn't fetched");
  });

  await step("a third computer joins with the recovery key", async () => {
    spare = await computer(account, "spare");
    hosts.push(spare);
    await fails(
      spare.sync("join_recovery", { name: "Spare", key: "not a key" }),
      "SyncRecoveryKey",
      "a mistyped key",
    );
    await spare.sync("join_recovery", {
      name: "Spare",
      key: recoveryKey.toLowerCase().replaceAll("-", " "),
    });
    const s = await spare.sync("status");
    check(s.state === "on" && s.devices.length === 3, JSON.stringify(s));
    const changes = await spare.sync("changes", { since: 0 });
    check(
      changes.records.some((r) => r.id === "c1" && r.text),
      "it reads what was synced before it joined",
    );
  });

  await step("a removed computer is locked out, and the others get new keys", async () => {
    const laptopId = (await laptop.sync("status")).deviceId;
    await desk.sync("remove_device", { device: laptopId });
    const gone = await laptop.sync("status");
    check(
      gone.state === "signedOut" || (gone.state === "off" && gone.notice === "removed"),
      JSON.stringify(gone),
    );
    await fails(
      laptop.sync("changes", { since: 0 }),
      gone.state === "signedOut" ? "SyncSignedOut" : "SyncOff",
      "the removed computer reading",
    );
    // The desk made new keys; the spare picks them up at its next check and reads new content.
    const put = await desk.sync("record_put", {
      collection: "settings",
      id: "after",
      expect: null,
      text: '"new keys"',
    });
    check(put.outcome === "done", JSON.stringify(put));
    const s = await spare.sync("status");
    check(s.state === "on" && s.devices.length === 2, JSON.stringify(s));
    const read = await spare.sync("record_get", { collection: "settings", id: "after" });
    check(read.text === '"new keys"' && !read.unreadable, JSON.stringify(read));
    // And what the spare writes, the desk reads.
    await spare.sync("record_put", {
      collection: "settings",
      id: "from-spare",
      expect: null,
      text: '"hi"',
    });
    check(
      (await desk.sync("record_get", { collection: "settings", id: "from-spare" })).text === '"hi"',
      "the other way",
    );
    // The chat from before the new keys still opens.
    const version = await spare.sync("chat_pull", {
      collection: "chats.p1",
      id: "c1",
      saveAs: "c1",
      workspace: null,
    });
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
    await fails(
      laptop.sync("join_recovery", { name: "Laptop", key: recoveryKey }),
      "SyncRecoveryKey",
      "the old key",
    );
    await laptop.sync("join_recovery", { name: "Laptop", key: next });
    check((await laptop.sync("status")).state === "on", "back with the new key");
    check(
      (await laptop.sync("record_get", { collection: "settings", id: "after" })).text ===
        '"new keys"',
      "and reads",
    );
    recoveryKey = next;
  });

  await step(
    "a device the server calls approved, but no device of the account approved, gets no keys",
    async () => {
      // The laptop joined by recovery key and is on the sealed list. Take it off that list as a
      // dishonest server couldn't, then remove another device so new keys are made.
      const s = await desk.sync("status");
      const spareId = s.devices.find((d) => d.name === "Spare").id;
      await desk.sync("remove_device", { device: spareId });
      const after = await desk.sync("status");
      check(
        after.devices.length === 2 && after.devices.every((d) => d.status === "approved"),
        JSON.stringify(after.devices),
      );
      check((await laptop.sync("status")).state === "on", "the listed device kept its place");
    },
  );

  await step("a subscription that ended: what is synced is read, nothing is written", async () => {
    await desk.sync("record_put", {
      collection: "settings",
      id: "kept",
      expect: null,
      text: '"x"',
    });
    await setSubscription(account, false);
    const s = await desk.sync("status");
    check(
      s.state === "on" && typeof s.lapsedUntil === "number" && s.lapsedUntil > Date.now(),
      JSON.stringify(s),
    );
    // Reading still works: a record, the changes, the chunks of a chat.
    check(
      (await desk.sync("record_get", { collection: "settings", id: "kept" })).text === '"x"',
      "a record is read",
    );
    check((await desk.sync("changes", { since: 0 })).records.length > 0, "the changes are read");
    await fails(
      desk.sync("record_put", { collection: "settings", id: "kept", expect: 1, text: '"y"' }),
      "SyncLapsed",
      "writing after the subscription ended",
    );
    await fails(
      desk.sync("chat_push", { collection: "chats.p1", id: "c1", expect: null }),
      "SyncLapsed",
      "uploading after the subscription ended",
    );
    // The other computer is told the same, and loses nothing it has.
    check(typeof (await laptop.sync("status")).lapsedUntil === "number", "the other computer too");
    // Renewed in time: everything is where it was.
    await setSubscription(account, true);
    const back = await desk.sync("status");
    check(back.state === "on" && back.lapsedUntil === null, JSON.stringify(back));
    const put = await desk.sync("record_put", {
      collection: "settings",
      id: "kept",
      expect: 1,
      text: '"y"',
    });
    check(put.outcome === "done", JSON.stringify(put));
  });

  await step("a team's library: published from one computer, applied on the other", async () => {
    // The account owns a team (the team service's job; here the test plays it).
    const doc = (path, fields) =>
      fetch(`${FIRESTORE}/${path}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
    const text = (v) => ({ stringValue: v });
    await doc(`teams/${account.uid}`, { ownerUid: text(account.uid), name: text("Acme studio") });
    await doc(`teams/${account.uid}/members/${account.uid}`, {
      role: text("owner"),
      publisher: { booleanValue: true },
    });
    await doc(`memberships/${account.uid}`, {
      teamId: text(account.uid),
      role: text("owner"),
      publisher: { booleanValue: true },
    });

    const empty = await desk.call("team_library", { base: BASE, rev: null });
    check(
      empty?.team?.id === account.uid &&
        empty.team.name === "Acme studio" &&
        empty.items.length === 0,
      JSON.stringify(empty),
    );
    const put = await desk.call("team_put", {
      base: BASE,
      id: "rules-1",
      kind: "rules",
      path: "AGENTS.md",
      text: "Use tabs.\n",
      isDefault: true,
      expect: null,
    });
    check(JSON.stringify(put).includes('"version":1'), JSON.stringify(put));
    await desk.call("team_put", {
      base: BASE,
      id: "cmd-1",
      kind: "commands",
      path: "commands/ship.md",
      text: "Ship it.\n",
      isDefault: false,
      expect: null,
    });

    // The other computer reads the list, fetches the texts and applies what is active.
    const listed = await laptop.call("team_library", { base: BASE, rev: null });
    check(
      listed.items.length === 2 && listed.items.every((i) => i.text === undefined),
      JSON.stringify(listed.items),
    );
    const got = await laptop.call("team_fetch", {
      base: BASE,
      team: account.uid,
      ids: ["rules-1", "cmd-1"],
    });
    check(got.fetched.length === 2 && got.failed.length === 0, JSON.stringify(got));
    check(
      (await laptop.call("team_item_text", { team: account.uid, id: "rules-1" })) === "Use tabs.\n",
      "the text kept",
    );
    const applied = await laptop.call("team_apply", { team: account.uid, active: ["rules-1"] });
    const rules = join(applied.dir, "AGENTS.md");
    check(
      existsSync(rules) && (await readFile(rules, "utf8")) === "Use tabs.\n",
      "the default is in the folder the loaders read",
    );
    check(!existsSync(join(applied.dir, "commands", "ship.md")), "what isn't on isn't there");
    check(
      applied.dir.replace(/\\/g, "/").includes(`/team/${account.uid}/active`) &&
        !/[/]data[/]sync[/]/.test(applied.dir),
      applied.dir,
    );

    // Added by this person: there too. Turned off again: gone.
    await laptop.call("team_apply", { team: account.uid, active: ["rules-1", "cmd-1"] });
    check(existsSync(join(applied.dir, "commands", "ship.md")), "an added item is applied");
    const fewer = await laptop.call("team_apply", { team: account.uid, active: ["cmd-1"] });
    check(!existsSync(rules) && fewer.removed >= 1, JSON.stringify(fewer));

    // Published over a version this computer never saw: theirs comes back, nothing is lost.
    const stale = await laptop.call("team_put", {
      base: BASE,
      id: "rules-1",
      kind: "rules",
      path: "AGENTS.md",
      text: "Use spaces.\n",
      isDefault: true,
      expect: null,
    });
    check(
      !JSON.stringify(stale).includes('"version":2') && JSON.stringify(stale).includes("Use tabs."),
      JSON.stringify(stale),
    );

    // A name that would leave the folder, or that Windows can't hold, never reaches the disk.
    for (const [id, path] of [
      ["bad-1", "skills/con/SKILL.md"],
      ["bad-2", "commands/aux.md"],
    ]) {
      await fetch(`${FIRESTORE}/teams/${account.uid}/library/${id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            kind: text(path.split("/")[0] === "skills" ? "skills" : "commands"),
            path: text(path),
            text: text("x"),
            size: { integerValue: "1" },
            version: { integerValue: "1" },
            isDefault: { booleanValue: true },
          },
        }),
      });
    }
    const hostile = await laptop.call("team_library", { base: BASE, rev: null });
    const kept = hostile.items.map((i) => i.id);
    await laptop
      .call("team_fetch", { base: BASE, team: account.uid, ids: ["bad-1", "bad-2"] })
      .catch(() => null);
    await laptop
      .call("team_apply", { team: account.uid, active: ["bad-1", "bad-2", "cmd-1"] })
      .catch(() => null);
    check(
      !existsSync(join(applied.dir, "skills", "con")) &&
        !existsSync(join(applied.dir, "commands", "aux.md")),
      `a reserved name was written (listed: ${kept.join(",")})`,
    );

    // Taken out of the library by a publisher; then the account leaves the team.
    check(
      (await desk.call("team_delete", { base: BASE, id: "cmd-1" })) === true,
      "an item is taken out",
    );
    await fetch(`${FIRESTORE}/memberships/${account.uid}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer owner" },
    });
    check(
      (await laptop.call("team_library", { base: BASE, rev: null })) === null,
      "no team, no library",
    );
    check(
      (await laptop.call("team_clear", { keep: null })) >= 1 && !existsSync(applied.dir),
      "the cache goes with the team",
    );
    await fetch(`${FIRESTORE}/teams/${account.uid}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer owner" },
    });
  });

  await step("a project shared with a team is read by a teammate, and by nobody else", async () => {
    const owner = { Authorization: "Bearer owner", "Content-Type": "application/json" };
    const doc = (path, fields) =>
      fetch(`${FIRESTORE}/${path}`, {
        method: "PATCH",
        headers: owner,
        body: JSON.stringify({ fields }),
      });
    const patch = (path, mask, fields) =>
      fetch(`${FIRESTORE}/${path}?${mask.map((m) => `updateMask.fieldPaths=${m}`).join("&")}`, {
        method: "PATCH",
        headers: owner,
        body: JSON.stringify({ fields }),
      });
    const drop = (path) => fetch(`${FIRESTORE}/${path}`, { method: "DELETE", headers: owner });
    const text = (v) => ({ stringValue: v });
    const share = (host, method, params = {}) =>
      host.call(`share_${method}`, { base: BASE, ...params });

    // A teammate and a stranger, each with sync on, on a computer of their own.
    const mate = await newAccount();
    const stranger = await newAccount();
    const others = {};
    for (const [name, who] of [
      ["mate", mate],
      ["stranger", stranger],
    ]) {
      await giveSync(who);
      const host = await computer(who, name);
      hosts.push(host);
      const key = await host.sync("prepare", { name });
      await host.sync("setup", { typed: key });
      check((await host.sync("status")).state === "on", `${name} syncs`);
      others[name] = host;
    }
    let mateDesk = others.mate;
    const strangerDesk = others.stranger;

    // The first account owns a team the teammate is in (the team service's job; played here).
    await doc(`teams/${account.uid}`, { ownerUid: text(account.uid), name: text("Acme studio") });
    for (const [who, role, name] of [
      [account, "owner", "Ada"],
      [mate, "member", "Bo"],
    ]) {
      await doc(`teams/${account.uid}/members/${who.uid}`, {
        role: text(role),
        name: text(name),
        email: text(who.email),
        publisher: { booleanValue: role === "owner" },
      });
      await doc(`memberships/${who.uid}`, {
        teamId: text(account.uid),
        role: text(role),
        publisher: { booleanValue: role === "owner" },
      });
    }

    // Each publishes a member key; the other pins it at first sight and can verify it.
    const mine = await share(desk, "me");
    const theirs = await share(mateDesk, "me");
    check(
      /^(\d{4} ){4}\d{4}$/.test(mine.fingerprint) && mine.published && theirs.published,
      JSON.stringify([mine, theirs]),
    );
    check(mine.fingerprint !== theirs.fingerprint, "two accounts, two keys");
    check(
      (await share(laptop, "me")).fingerprint === mine.fingerprint,
      "one key an account, on each of its computers",
    );
    await fails(share(strangerDesk, "me"), "ShareNoTeam", "an account in no team");
    const seen = (await share(desk, "members")).find((m) => m.uid === mate.uid);
    check(
      seen?.state === "new" && seen.fingerprint === theirs.fingerprint && seen.name === "Bo",
      JSON.stringify(seen),
    );
    await fails(
      share(desk, "set_verified", { uid: mate.uid, fingerprint: mine.fingerprint, verified: true }),
      "ShareKeyChanged",
      "verifying under another fingerprint",
    );
    await share(desk, "set_verified", {
      uid: mate.uid,
      fingerprint: theirs.fingerprint,
      verified: true,
    });
    check(
      (await share(laptop, "members")).find((m) => m.uid === mate.uid).state === "verified",
      "verified on every computer of the account",
    );

    // The project: a commit, a change not committed, a new file, and a key file.
    const project = join(scratch, "shared-project");
    await mkdir(project, { recursive: true });
    git(project, "init", "-q");
    await writeFile(join(project, "a.txt"), "one\n");
    await writeFile(join(project, "b.txt"), "two\n");
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", "first");
    await writeFile(join(project, "a.txt"), "one\nchanged, not committed\n");
    await writeFile(join(project, "new.txt"), "untracked\n");
    await writeFile(join(project, ".env"), "TOKEN=hunter2\n");
    await desk.call("workspace_open", { path: project });

    const id = `${account.uid}.shared1`;
    const started = await share(desk, "start", {
      root: project,
      project: "shared1",
      name: "Shared one",
      chats: false,
      onlyVerified: true,
    });
    check(
      started.id === id &&
        typeof started.snapshot === "string" &&
        started.keyFiles === 1 &&
        started.wrapsAdded === 1 &&
        !started.renewed &&
        started.waiting.length === 0,
      JSON.stringify(started),
    );
    const unchanged = await share(desk, "sync", {
      root: project,
      project: "shared1",
      onlyVerified: true,
    });
    check(
      unchanged.snapshot === null && unchanged.wrapsAdded === 0 && unchanged.keyFiles === 1,
      JSON.stringify(unchanged),
    );
    // The sharer's other computer has the share's keys from the account's own vault.
    const own = (await share(laptop, "list")).find((s) => s.id === id);
    check(own?.state === "mine" && own.mine && own.keyVersion === 1, JSON.stringify(own));
    check((await share(laptop, "snapshots", { id })).length === 1, "read on the other computer");
    // What holds keys never reaches a front end, and isn't a front end's to write.
    const kept = (await desk.sync("changes", { since: 0 })).records.filter(
      (r) => r.collection === "shares" || (r.collection === "sys" && r.id === "member"),
    );
    check(kept.length === 2 && kept.every((r) => r.text === null), JSON.stringify(kept));
    await fails(
      desk.sync("record_put", { collection: "shares", id: "shared1", expect: null, text: "{}" }),
      "Invalid",
      "a front end writing a share's keys",
    );

    // The teammate: lists it, reads the snapshot's files and one of them, without the key file.
    const listed = (await share(mateDesk, "list")).find((s) => s.id === id);
    check(
      listed?.state === "ready" &&
        !listed.mine &&
        listed.name === "Shared one" &&
        listed.owner.uid === account.uid &&
        listed.latest?.files === 2,
      JSON.stringify(listed),
    );
    const snaps = await share(mateDesk, "snapshots", { id });
    check(
      snaps.length === 1 && snaps[0].id === started.snapshot && snaps[0].summary.kind === "git",
      JSON.stringify(snaps),
    );
    const snapshot = snaps[0].id;
    const files = await share(mateDesk, "snapshot_files", { id, snapshot, root: null });
    check(
      JSON.stringify(files.files.map((f) => f.path)) === JSON.stringify(["a.txt", "new.txt"]),
      JSON.stringify(files),
    );
    check(
      JSON.stringify(files.skipped) === JSON.stringify([[".env", "a key file"]]),
      JSON.stringify(files.skipped),
    );
    const read = await share(mateDesk, "file_text", { id, snapshot, path: "a.txt" });
    check(read?.text === "one\nchanged, not committed\n", JSON.stringify(read));
    check(
      (await share(mateDesk, "file_text", { id, snapshot, path: ".env" })) === null,
      "the key file isn't in the share",
    );

    // A copy in a new folder: the commit, the change, the new file; no key file.
    const copy = join(scratch, "mate-copy");
    const opened = await share(mateDesk, "open_copy", { id, snapshot, target: copy });
    check(!opened.cloned && opened.restored.files === 2, JSON.stringify(opened));
    const [here, there] = [await tree(copy), await tree(project)];
    delete there[".env"];
    check(JSON.stringify(here) === JSON.stringify(there), `files: ${JSON.stringify(here)}`);
    check(git(copy, "rev-parse", "HEAD") === git(project, "rev-parse", "HEAD"), "the same commit");
    await fails(
      share(mateDesk, "open_copy", { id, snapshot, target: copy }),
      "ShareTargetNotEmpty",
      "a copy into a folder that has files",
    );
    // A reader writes nothing to a share: it has none of its own under that name.
    await mateDesk.call("workspace_open", { path: copy });
    await fails(
      share(mateDesk, "sync", { root: copy, project: "shared1", onlyVerified: false }),
      "ShareNotShared",
      "a reader syncing someone else's share",
    );

    // Anyone outside the team gets nothing, and is told nothing.
    await fails(share(strangerDesk, "list"), "ShareNoTeam", "a stranger listing");
    await fails(share(strangerDesk, "snapshots", { id }), "ShareGone", "a stranger reading");

    // A member key swapped on the service is never used. The sharer's side: the teammate
    // stands as "changed", and gets no keys until the new key is accepted by hand.
    const keyOf = async (uid) =>
      (await fetch(`${FIRESTORE}/memberKeys/${uid}`, { headers: owner }).then((r) => r.json()))
        .fields.publicKey.stringValue;
    const setKey = (uid, key) =>
      patch(`memberKeys/${uid}`, ["publicKey"], { publicKey: text(key) });
    const [realMine, realTheirs] = [await keyOf(account.uid), await keyOf(mate.uid)];
    await setKey(mate.uid, b64(32));
    const swapped = (await share(desk, "members")).find((m) => m.uid === mate.uid);
    check(
      swapped.state === "changed" &&
        swapped.fingerprint === theirs.fingerprint &&
        swapped.pendingFingerprint !== theirs.fingerprint,
      JSON.stringify(swapped),
    );
    const held = await share(desk, "sync", {
      root: project,
      project: "shared1",
      onlyVerified: true,
    });
    check(
      held.wrapsAdded === 0 &&
        held.waiting.some((w) => w.uid === mate.uid && w.why === "keyChanged"),
      JSON.stringify(held),
    );
    await setKey(mate.uid, realTheirs);
    check(
      (await share(desk, "members")).find((m) => m.uid === mate.uid).state === "verified",
      "the pinned key shown again",
    );
    // The reader's side, on a freshly started app (it holds no opened keys): with the sharer's
    // key swapped, nothing of the share is read.
    await setKey(account.uid, b64(32));
    mateDesk.stop();
    mateDesk = new Host("mate", mateDesk.profile);
    hosts.push(mateDesk);
    await mateDesk.call("$/hello", { protocol: 1, client: "sync-e2e" });
    check((await mateDesk.sync("status")).state === "on", "the teammate's app, started again");
    await fails(share(mateDesk, "snapshots", { id }), "ShareKeyChanged", "a swapped sharer key");
    check(
      (await share(mateDesk, "list")).find((s) => s.id === id).state === "keyChanged",
      "said in the list",
    );
    await setKey(account.uid, realMine);
    check((await share(mateDesk, "snapshots", { id })).length === 1, "the pinned key again: read");

    // The teammate is removed from the team (the account page's job; when it can't be asked
    // here, the test plays the service): the next sync of the share renews its keys.
    const removed = await fetch(`${BASE}/api/team/members/${mate.uid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${account.idToken}` },
    });
    if (removed.status !== 200) {
      await drop(`memberships/${mate.uid}`);
      await drop(`teams/${account.uid}/members/${mate.uid}`);
      await drop(`vaults/${id}/wraps/${mate.uid}`);
      await patch(`vaults/${id}`, ["rotationNeeded"], { rotationNeeded: { booleanValue: true } });
    }
    await writeFile(join(project, "b.txt"), "two, after the teammate left\n");
    const after = await share(desk, "sync", {
      root: project,
      project: "shared1",
      onlyVerified: true,
    });
    check(
      after.renewed && typeof after.snapshot === "string" && after.waiting.length === 0,
      JSON.stringify(after),
    );
    const now = (await share(desk, "list")).find((s) => s.id === id);
    check(now.keyVersion === 2 && !now.rotationNeeded, JSON.stringify(now));
    check((await share(laptop, "snapshots", { id })).length === 2, "the sharer reads both");
    // The removed teammate, whose app still holds the keys it opened, is refused all the same.
    await fails(share(mateDesk, "snapshots", { id }), "ShareGone", "reading after being removed");
    await fails(
      share(mateDesk, "file_text", { id, snapshot, path: "a.txt" }),
      "ShareGone",
      "reading a file after being removed",
    );
    await fails(share(mateDesk, "list"), "ShareNoTeam", "listing after being removed");

    // Stopped: gone from the team's list, and from the account's own vault.
    await share(desk, "stop", { id });
    check(!(await share(desk, "list")).some((s) => s.id === id), "no longer listed");
    await fails(share(laptop, "snapshots", { id }), "ShareKeys", "reading a stopped share");
    for (const who of [account, mate]) {
      await drop(`memberships/${who.uid}`);
      await drop(`teams/${account.uid}/members/${who.uid}`);
    }
    await drop(`teams/${account.uid}`);
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
    check(
      other.state === "off" && other.notice === "reset" && other.exists === true,
      JSON.stringify(other),
    );
  });
} finally {
  for (const h of hosts) h.stop();
  await new Promise((r) => setTimeout(r, 300));
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll sync steps passed");
process.exit(failures ? 1 : 0);
