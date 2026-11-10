// A stand-in for the GitHub CLI in UI tests (D148, D204): signed in, and `repo create` makes a
// bare repository next to the test folder ("../fake-github/<name>.git"), adds it as the remote
// and pushes, printing the URL GitHub would. D204: pull request #7 is the local `feature` branch
// into `main` (its files, contents and merge base come from the local repository), with one
// review thread on its first file (reply and resolve persist in ../fake-github/state.json), and
// two notifications that can be marked read. Anything else fails like an unknown command.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const base = join(dirname(resolve(process.cwd())), "fake-github");
const statePath = join(base, "state.json");
const flag = (f) => args.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3);
/** `-f name=value` / `-F name=value` fields of `gh api`. */
const field = (name) => {
  for (let i = 0; i < args.length - 1; i++)
    if ((args[i] === "-f" || args[i] === "-F") && args[i + 1].startsWith(`${name}=`))
      return args[i + 1].slice(name.length + 1);
  return undefined;
};
const tryGit = (...a) => {
  try {
    return git(...a).trim();
  } catch {
    return "";
  }
};
const head = () => tryGit("rev-parse", "feature") || tryGit("rev-parse", "HEAD");
const baseTip = () => tryGit("rev-parse", "main") || tryGit("rev-parse", "HEAD");

function prFiles() {
  const out = tryGit("diff", "--numstat", "-M", `${baseTip()}...${head()}`);
  const names = tryGit("diff", "--name-status", "-M", `${baseTip()}...${head()}`).split("\n");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      const [add, del, ...rest] = line.split("\t");
      const status = (names[i] ?? "M")[0];
      return {
        filename: rest[rest.length - 1],
        status:
          status === "A"
            ? "added"
            : status === "D"
              ? "removed"
              : status === "R"
                ? "renamed"
                : "modified",
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      };
    });
}

function loadState() {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8"));
  const first = prFiles()[0]?.filename ?? "README.md";
  return {
    threads: [
      {
        id: "PRRT_fake1",
        isResolved: false,
        isOutdated: false,
        path: first,
        line: 1,
        originalLine: 1,
        startLine: null,
        diffSide: "RIGHT",
        comments: {
          nodes: [
            {
              databaseId: 101,
              body: "Could this line be clearer?",
              createdAt: "2026-01-02T10:00:00Z",
              url: "https://github.com/tester/sample/pull/7#discussion_r101",
              author: { login: "reviewer" },
            },
          ],
        },
      },
    ],
    notifications: [
      {
        id: "1001",
        unread: true,
        reason: "review_requested",
        updated_at: "2026-01-03T09:00:00Z",
        subject: {
          title: "Add the feature",
          type: "PullRequest",
          url: "https://api.github.com/repos/tester/sample/pulls/7",
        },
        repository: { full_name: "tester/sample", html_url: "https://github.com/tester/sample" },
      },
      {
        id: "1002",
        unread: true,
        reason: "mention",
        updated_at: "2026-01-01T09:00:00Z",
        subject: {
          title: "A bug report",
          type: "Issue",
          url: "https://api.github.com/repos/tester/sample/issues/3",
        },
        repository: { full_name: "tester/sample", html_url: "https://github.com/tester/sample" },
      },
    ],
  };
}
/**
 * D323: what a test set for pull request #7 (../fake-github/pr.json, written by
 * tests/fixtures/setup/prwatch-m7-68.mjs): `view` fields over `pr view`'s (checks, mergeable,
 * state, comments) and `threads` added to the review threads.
 */
function prExtra() {
  const path = join(base, "pr.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
function saveState(state) {
  mkdirSync(base, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

if (args[0] === "--version") {
  console.log("gh version 0.0.0 (fake)");
} else if (args[0] === "auth" && args[1] === "status") {
  console.error("github.com\n  ✓ Logged in to github.com account tester (fake)");
} else if (args[0] === "repo" && args[1] === "create") {
  const name = args[2] ?? "";
  const remote = flag("remote") ?? "origin";
  mkdirSync(base, { recursive: true });
  const bare = join(base, `${name.split("/").pop()}.git`);
  git("init", "--bare", "-q", bare);
  git("remote", "add", remote, bare);
  if (args.includes("--push")) git("push", "-q", "-u", remote, "HEAD");
  console.log(`https://github.com/tester/${name.split("/").pop()}`);
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(
    JSON.stringify({
      number: 7,
      title: "Add the feature",
      url: "https://github.com/tester/sample/pull/7",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: head(),
      baseRefOid: baseTip(),
      state: "OPEN",
      body: "",
      author: { login: "tester" },
      isDraft: false,
      updatedAt: "2026-01-03T09:00:00Z",
      ...prExtra().view,
    }),
  );
} else if (args[0] === "pr" && args[1] === "merge") {
  // D352: merge (pr.json's state goes MERGED), auto-merge on (--auto) or off (--disable-auto).
  const extra = prExtra();
  const view = extra.view ?? {};
  if (args.includes("--disable-auto")) view.autoMergeRequest = null;
  else if (args.includes("--auto")) {
    if (!extra.repo?.autoMergeAllowed) {
      console.error("GraphQL: Auto merge is not allowed for this repository (fake)");
      process.exit(1);
    }
    view.autoMergeRequest = { mergeMethod: (args.at(-1) ?? "--merge").slice(2).toUpperCase() };
  } else {
    view.state = "MERGED";
    view.mergedWith = (args.at(-1) ?? "--merge").slice(2);
  }
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "pr.json"), JSON.stringify({ ...extra, view }));
} else if (args[0] === "repo" && args[1] === "view") {
  // D352: whether the repository allows auto-merge (pr.json's `repo`).
  console.log(JSON.stringify({ autoMergeAllowed: prExtra().repo?.autoMergeAllowed === true }));
} else if (args[0] === "pr" && args[1] === "list") {
  console.log("[]");
} else if (args[0] === "api") {
  const state = loadState();
  const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
  const endpoint =
    args.find(
      (a, i) =>
        i > 0 &&
        !a.startsWith("-") &&
        args[i - 1] !== "-X" &&
        args[i - 1] !== "-f" &&
        args[i - 1] !== "-F" &&
        args[i - 1] !== "-H",
    ) ?? "";
  const compare = /compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)/.exec(endpoint);
  const contents = /contents\/(.+)\?ref=([0-9a-f]+)/.exec(endpoint);
  const reply = /pulls\/7\/comments\/(\d+)\/replies/.exec(endpoint);
  if (endpoint === "graphql") {
    const query = field("query") ?? "";
    if (query.includes("reviewThreads")) {
      console.log(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [...state.threads, ...(prExtra().threads ?? [])] },
              },
            },
          },
        }),
      );
    } else if (/(un)?resolveReviewThread/.test(query)) {
      const id = field("thread");
      const t = state.threads.find((x) => x.id === id);
      if (!t) {
        console.error("Could not resolve to a node");
        process.exit(1);
      }
      t.isResolved = !query.includes("unresolve");
      saveState(state);
      console.log(JSON.stringify({ data: { thread: { id, isResolved: t.isResolved } } }));
    } else {
      console.error("unknown graphql (fake)");
      process.exit(1);
    }
  } else if (/pulls\/7\/files/.test(endpoint)) {
    console.log(JSON.stringify(prFiles()));
  } else if (compare) {
    console.log(tryGit("merge-base", compare[1], compare[2]));
  } else if (contents) {
    process.stdout.write(git("show", `${contents[2]}:${decodeURIComponent(contents[1])}`));
  } else if (reply) {
    const t = state.threads.find((x) =>
      x.comments.nodes.some((c) => String(c.databaseId) === reply[1]),
    );
    if (!t) process.exit(1);
    const id = 200 + t.comments.nodes.length;
    t.comments.nodes.push({
      databaseId: id,
      body: field("body") ?? "",
      createdAt: new Date().toISOString(),
      url: `https://github.com/tester/sample/pull/7#discussion_r${id}`,
      author: { login: "tester" },
    });
    saveState(state);
    console.log(JSON.stringify({ id }));
  } else if (endpoint.startsWith("notifications/threads/") && method === "PATCH") {
    const id = endpoint.split("/").pop();
    for (const n of state.notifications) if (n.id === id) n.unread = false;
    saveState(state);
  } else if (endpoint === "notifications" && method === "PUT") {
    for (const n of state.notifications) n.unread = false;
    saveState(state);
  } else if (endpoint.startsWith("notifications")) {
    const all = endpoint.includes("all=true");
    console.log(JSON.stringify(state.notifications.filter((n) => all || n.unread)));
  } else {
    console.error(`unknown api ${endpoint} (fake)`);
    process.exit(1);
  }
} else {
  console.error(`unknown command "${args.join(" ")}" for gh (fake)`);
  process.exit(1);
}
