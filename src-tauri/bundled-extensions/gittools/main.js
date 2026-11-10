// Git tools — GitLens-style extras for Source control, as an extension that comes with the IDE
// (D208; they were built in, D204). Runs in a sandboxed worker (API: docs/extensions.md):
//   - File blame: who last changed each line and how long ago, before the lines, colored by age
//     (ide.git.blame + ide.editor.setLineAnnotations).
//   - Line history: the commits that changed the selected lines (ide.git.lineLog).
//   - Compare: the files that differ between two refs (ide.git.diffNames, revParse, mergeBase).
//   - Stashes: list, expand to the files, apply / pop / drop (the IDE's git.stash* commands).
//   - GitHub notifications through the user's gh sign-in (ide.github).
// Views are sections of Source control (sectionOf "scm.view"); diffs open with editor.openDiff and
// the IDE's "git:<hash>@<path>" contents. `exports.model` is the DOM-free part, unit-tested in
// src/extensions/git/gittools.test.ts.

// ---- Model (no `ide` here) ------------------------------------------------------------------

const BLAME_WIDTH = 24;

/** "3 d", "2 mo", "1 yr": short enough for the gutter. */
function shortAge(seconds, now = Date.now() / 1000) {
  const d = Math.max(0, now - seconds);
  const units = [
    [365 * 86400, "yr"],
    [30 * 86400, "mo"],
    [7 * 86400, "wk"],
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(d / size);
    if (n >= 1) return `${n} ${name}`;
  }
  return "now";
}

/** "3 days ago", for rows. */
function longAge(seconds, now = Date.now() / 1000) {
  const d = Math.max(0, now - seconds);
  const units = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(d / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * The age bucket, 0 (newest) to 4 (oldest), relative to the file's own span of dates: recent
 * changes stand out. Uncommitted lines are 0.
 */
function heatBucket(time, oldest, newest) {
  if (newest <= oldest) return 0;
  const f = (newest - time) / (newest - oldest);
  return Math.max(0, Math.min(4, Math.floor(f * 5)));
}

/** One annotation per line of the blame's hunks: author and age on a hunk's first line. */
function blameAnnotations(hunks, now = Date.now() / 1000) {
  const times = hunks.filter((h) => !h.commit.uncommitted).map((h) => h.commit.time);
  const oldest = times.length ? Math.min(...times) : 0;
  const newest = times.length ? Math.max(...times) : 0;
  const out = [];
  for (const h of hunks) {
    const c = h.commit;
    const age = c.uncommitted ? "" : shortAge(c.time, now);
    const name = c.uncommitted ? "Not committed yet" : c.author || "?";
    const room = BLAME_WIDTH - age.length - 1;
    const shown = name.length > room ? `${name.slice(0, Math.max(1, room - 1))}…` : name;
    const first = `${shown}${" ".repeat(Math.max(1, BLAME_WIDTH - shown.length - age.length))}${age}`;
    const heat = c.uncommitted ? 0 : heatBucket(c.time, oldest, newest);
    const hover = c.uncommitted
      ? "Not committed yet"
      : `${c.author}${c.authorMail ? ` <${c.authorMail}>` : ""}, ${new Date(c.time * 1000).toLocaleString()}\n\n${c.summary}\n\n${c.hash.slice(0, 10)}`;
    for (let line = h.start; line <= h.end; line++)
      out.push({
        line,
        text: line === h.start ? first : " ".repeat(BLAME_WIDTH),
        heat,
        hash: c.hash,
        hover,
      });
  }
  return out;
}

/** "stash@{0}: On main: wip" → "wip · 3 days ago". */
function stashLabel(st, now = Date.now() / 1000) {
  const text = st.message.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, "") || st.message;
  return `${text} · ${longAge(st.time, now)}`;
}

/** The web page of a notification's subject (its API URL turned around), else the repository. */
function notificationUrl(n) {
  const api = (n.subject && n.subject.url) || "";
  const m =
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/?#]+)/.exec(
      api,
    );
  if (!m) return (n.repository && n.repository.html_url) || "https://github.com/notifications";
  const kind = m[2] === "pulls" ? "pull" : m[2] === "commits" ? "commit" : m[2];
  return `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

const slash = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether `path` is `root` or inside it (either separator; case-insensitive with `fold`). */
function isWithin(root, path, fold) {
  const r = fold ? slash(root).toLowerCase() : slash(root);
  const p = fold ? slash(path).toLowerCase() : slash(path);
  return p === r || p.startsWith(`${r}/`);
}

/** `path` relative to `root` with "/" ("" for the root itself); the path itself when outside. */
function relativeTo(root, path, fold) {
  if (!isWithin(root, path, fold)) return path;
  return slash(path).slice(slash(root).length).replace(/^\/+/, "");
}

/** A repository-relative "a/b.txt" under `root`, with the root's own separator. */
function joinPath(root, rel) {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

/** The deepest repository holding `path`, else the one named, else the selected one. */
function pickRepository(list, path, named, fold) {
  if (named) {
    const hit = list.find(
      (r) => r.root === named || r.name === named || slash(r.root).endsWith(`/${slash(named)}`),
    );
    if (hit) return hit;
  }
  if (path) {
    const holding = list
      .filter((r) => isWithin(r.root, path, fold))
      .sort((a, b) => b.root.length - a.root.length);
    if (holding[0]) return holding[0];
  }
  return list.find((r) => r.selected) || list[0] || null;
}

const NOTIFICATION_ICONS = {
  PullRequest: "git-pull-request",
  Issue: "circle-dot",
  Commit: "git-commit-horizontal",
  Release: "tag",
};

exports.model = {
  BLAME_WIDTH,
  shortAge,
  longAge,
  heatBucket,
  blameAnnotations,
  stashLabel,
  notificationUrl,
  isWithin,
  relativeTo,
  joinPath,
  pickRepository,
};

// ---- The extension -----------------------------------------------------------------------

const LINE_HISTORY_LIMIT = 50;

exports.activate = async (ide) => {
  const fold = ide.env.platform !== "linux";
  const key = (p) => (fold ? slash(p).toLowerCase() : slash(p));
  const later = (ms) => new Promise((r) => setTimeout(r, ms));

  const workspaceRoot = async () => (await ide.workspace.root().catch(() => null)) || "";
  /** A path from the input (relative to the open folder, or absolute) as an absolute one. */
  const absolute = async (path) => {
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path;
    const root = await workspaceRoot();
    return root ? joinPath(root, path) : path;
  };
  const activeFile = async () => {
    const a = await ide.editor.active().catch(() => null);
    return a || null;
  };
  const repository = async (path, named) => {
    const list = await ide.git.repositories();
    const r = pickRepository(list, path, named, fold);
    if (!r) throw new Error("This folder isn't a git repository.");
    return { ...r, several: list.length > 1 };
  };
  const showView = (id, caller) =>
    caller === "user" ? ide.commands.execute("view.show", { id }).catch(() => {}) : undefined;

  // ---- File blame -----------------------------------------------------------------------
  /** key → path, for every file whose blame is shown. */
  const blamed = new Map();
  const tokens = new Map();
  const timers = new Map();

  const blame = async (path) => {
    const k = key(path);
    const token = (tokens.get(k) || 0) + 1;
    tokens.set(k, token);
    const hunks = await ide.git.blame(path);
    if (tokens.get(k) !== token || !blamed.has(k)) return 0;
    const heat = (await ide.settings.get("git.blame.heatmap")) !== false;
    const notes = blameAnnotations(hunks);
    await ide.editor.setLineAnnotations(
      path,
      notes.map((n) => ({
        line: n.line,
        text: n.text,
        tone: heat ? n.heat : 4,
        hover: n.hover,
      })),
    );
    return notes.length;
  };
  const blameAgain = (path, delay) => {
    const k = key(path);
    clearTimeout(timers.get(k));
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        if (blamed.has(k)) blame(path).catch(() => {});
      }, delay),
    );
  };
  const eachBlamed = (delay) => {
    for (const path of blamed.values()) blameAgain(path, delay);
  };
  ide.events.on("documents.didChange", (e) => {
    if (e && typeof e.path === "string" && blamed.has(key(e.path))) blameAgain(e.path, 1500);
  });
  ide.events.on("files.didSave", (e) => {
    if (e && typeof e.path === "string" && blamed.has(key(e.path))) blameAgain(e.path, 100);
  });

  ide.commands.register("git.toggleFileBlame", async ({ path, value } = {}) => {
    const file = path ? await absolute(path) : (await activeFile())?.path;
    if (!file) throw new Error("Open a file in a git repository first.");
    const on = typeof value === "boolean" ? value : !blamed.has(key(file));
    if (!on) {
      blamed.delete(key(file));
      await ide.editor.setLineAnnotations(file, null);
      return { path: file, shown: false };
    }
    blamed.set(key(file), file);
    try {
      return { path: file, shown: true, lines: await blame(file) };
    } catch (err) {
      blamed.delete(key(file));
      await ide.editor.setLineAnnotations(file, null).catch(() => {});
      throw err;
    }
  });
  ide.state.register("ide://git/fileBlame", async () => {
    const root = await workspaceRoot();
    return [...blamed.values()].map((p) => (root ? relativeTo(root, p, fold) : p));
  });

  // ---- Line history ---------------------------------------------------------------------
  let history = null; // { root, path, start, end, entries }
  let historyBusy = false;
  const historyDiff = (h, e) => {
    const file = e.path || relativeTo(h.root, h.path, fold);
    const parent = e.parents[0];
    return {
      path: joinPath(h.root, file),
      base: `git:${parent || "0000000"}@${file}`,
      baseLabel: parent ? parent.slice(0, 7) : "Before",
      head: `git:${e.hash}@${file}`,
      headLabel: `${e.hash.slice(0, 7)} · ${e.subject.slice(0, 50)}`,
    };
  };
  const historyTree = ide.ui.registerTreeView("git.lineHistoryView", {
    getChildren(parent) {
      if (parent || !history) return [];
      return history.entries.map((e) => ({
        id: e.hash,
        label: e.subject || "(no message)",
        description: `${e.author}, ${longAge(e.time)}`,
        tooltip: `${e.subject}\n${e.author} · ${new Date(e.time * 1000).toLocaleString()} · ${e.hash.slice(0, 10)}\n+${e.added} −${e.removed} on these lines`,
        icon: "git-commit-horizontal",
        command: { id: "editor.openDiff", input: historyDiff(history, e) },
        actions: [
          {
            icon: "git-commit-horizontal",
            title: "Show commit",
            command: { id: "git.showCommit", input: { commit: e.hash } },
          },
        ],
      }));
    },
  });
  const historyMessage = () => {
    if (!history)
      return historyBusy
        ? "Loading…"
        : "Select lines in an editor and run Show line history: every commit that changed them.";
    const name = history.path.split(/[\\/]/).pop();
    const lines = `${history.start}${history.end > history.start ? `–${history.end}` : ""}`;
    return history.entries.length
      ? `${name}, lines ${lines}`
      : `${name}, lines ${lines}: no commits changed them (they may not be committed yet).`;
  };
  const showHistory = () => {
    historyTree.setMessage(historyMessage());
    historyTree.refresh();
  };
  showHistory();

  ide.commands.register(
    "git.lineHistory",
    async ({ path, startLine, endLine, open, repository: named } = {}, { caller }) => {
      let file = path ? await absolute(path) : undefined;
      let lo = startLine;
      let hi = endLine;
      if (!file || lo === undefined) {
        const active = await activeFile();
        file = file || active?.path;
        if (lo === undefined && active) {
          lo = active.selection.startLine;
          hi = hi ?? active.selection.endLine;
        }
      }
      if (!file || lo === undefined) throw new Error("Open a file and select the lines first.");
      const end = Math.max(lo, hi ?? lo);
      const repo = await repository(file, named);
      historyBusy = true;
      showHistory();
      let entries;
      try {
        entries = await ide.git.lineLog(file, lo, end, {
          limit: LINE_HISTORY_LIMIT,
          ...(named && { repository: named }),
        });
      } finally {
        historyBusy = false;
      }
      history = { root: repo.root, path: file, start: lo, end, entries };
      showHistory();
      await showView("git.lineHistoryView", caller);
      if (open) {
        const e = entries.find((x) => x.hash.startsWith(open));
        if (!e) throw new Error(`${open} didn't change those lines.`);
        await ide.commands.execute("editor.openDiff", historyDiff(history, e));
      }
      const root = (await workspaceRoot()) || repo.root;
      return {
        path: relativeTo(root, file, fold),
        lines: [lo, end],
        ...(repo.several && { repository: repo.name }),
        commits: entries.map((e) => ({
          hash: e.hash,
          author: e.author,
          date: new Date(e.time * 1000).toISOString(),
          subject: e.subject,
          added: e.added,
          removed: e.removed,
        })),
      };
    },
  );

  // ---- Compare --------------------------------------------------------------------------
  let comparison = null; // { root, left, right, leftHash, rightHash, baseHash, mergeBase, files }
  const compareDiff = (c, f) => ({
    path: joinPath(c.root, f.path),
    base: `git:${c.baseHash}@${f.origPath || f.path}`,
    baseLabel: c.mergeBase ? `${c.left} (merge base)` : c.left,
    head: `git:${c.rightHash}@${f.path}`,
    headLabel: c.right,
  });
  const compareTree = ide.ui.registerTreeView("git.compareView", {
    getChildren(parent) {
      if (parent || !comparison) return [];
      const c = comparison;
      return c.files.map((f) => {
        const slashAt = f.path.lastIndexOf("/");
        return {
          id: f.path,
          label: f.path.slice(slashAt + 1),
          description: `${f.status} ${slashAt > 0 ? f.path.slice(0, slashAt) : ""}`.trim(),
          tooltip: `${f.origPath ? `${f.origPath} → ` : ""}${f.path}`,
          icon: "file",
          command: { id: "editor.openDiff", input: compareDiff(c, f) },
        };
      });
    },
  });
  const showComparison = () => {
    const c = comparison;
    compareTree.setMessage(
      c
        ? `${c.left}${c.mergeBase ? " (merge base)" : ""} ↔ ${c.right} · ${c.files.length} file${c.files.length === 1 ? "" : "s"}${c.files.length ? "" : ": they're the same"}`
        : "Compare branches lists the files that differ between two branches, tags or commits.",
    );
    compareTree.refresh();
  };
  showComparison();
  const pickRef = async (named, placeholder) => {
    const { branches, tags } = await ide.git.refs(named ? { repository: named } : {});
    const picked = await ide.ui.showQuickPick(
      [
        ...branches.map((b) => ({
          label: b.name,
          description: `${b.current ? "current · " : ""}${b.commit} ${b.subject}`,
          icon: b.remote ? "cloud" : "git-branch",
        })),
        ...tags.map((t) => ({ label: t, description: "tag", icon: "tag" })),
      ],
      { placeholder },
    );
    return picked?.label;
  };
  ide.commands.register(
    "git.compareBranches",
    async ({ left, right, mergeBase, path, repository: named } = {}, { caller }) => {
      const repo = await repository(undefined, named);
      const opts = named ? { repository: named } : {};
      let l = left;
      let r = right;
      if (!l && caller === "user") {
        l = await pickRef(named, "Compare: pick the ref to compare from");
        if (!l) return null;
        if (!r) {
          r = await pickRef(named, `Compare ${l} with…`);
          if (!r) return null;
        }
      }
      if (!l) throw new Error("Name the `left` ref.");
      r = r || "HEAD";
      const [leftHash, rightHash] = await Promise.all([
        ide.git.revParse(l, opts),
        ide.git.revParse(r, opts),
      ]);
      const baseHash = mergeBase ? await ide.git.mergeBase(leftHash, rightHash, opts) : leftHash;
      const files = await ide.git.diffNames(baseHash, rightHash, opts);
      comparison = {
        root: repo.root,
        left: l,
        right: r,
        leftHash,
        rightHash,
        baseHash,
        mergeBase: mergeBase === true,
        files,
      };
      showComparison();
      await showView("git.compareView", caller);
      if (path) {
        const f = files.find((x) => x.path === path || x.origPath === path);
        if (!f) throw new Error(`${path} doesn't differ between ${l} and ${r}.`);
        await ide.commands.execute("editor.openDiff", compareDiff(comparison, f));
      }
      return { left: l, right: r, leftHash, rightHash, baseHash, files };
    },
  );
  ide.commands.register("git.compareSwap", async () => {
    const c = comparison;
    if (!c) throw new Error("Nothing is compared yet: run Compare branches first.");
    return ide.commands.execute("git.compareBranches", {
      left: c.right,
      right: c.left,
      mergeBase: c.mergeBase,
    });
  });

  ide.state.register("ide://git/lens", async () => {
    const root = await workspaceRoot();
    return {
      lineHistory: history && {
        path: root ? relativeTo(root, history.path, fold) : history.path,
        lines: [history.start, history.end],
        commits: history.entries.map((e) => ({ hash: e.hash, subject: e.subject })),
      },
      comparison: comparison && {
        left: comparison.left,
        right: comparison.right,
        mergeBase: comparison.mergeBase,
        files: comparison.files.map((f) => ({ path: f.path, status: f.status })),
      },
    };
  });

  // ---- Stashes --------------------------------------------------------------------------
  let stashes = [];
  let stashRepo = null; // { root, several }
  let stashToken = 0;
  const stashFiles = new Map(); // index → files
  const stashTree = ide.ui.registerTreeView("git.stashesView", {
    async getChildren(parent) {
      if (!parent) {
        const input = stashRepo?.several ? { repository: stashRepo.root } : {};
        return stashes.map((st) => ({
          id: `stash:${st.index}:${st.time}`,
          label: stashLabel(st),
          description: `stash@{${st.index}}`,
          tooltip: `${st.message}\n${new Date(st.time * 1000).toLocaleString()}`,
          icon: "archive",
          collapsible: true,
          actions: [
            {
              icon: "check",
              title: "Apply",
              command: { id: "git.stashApply", input: { index: st.index, ...input } },
            },
            {
              icon: "arrow-down",
              title: "Pop (apply and drop)",
              command: { id: "git.stashPop", input: { index: st.index, ...input } },
            },
            {
              icon: "trash-2",
              title: "Drop",
              command: { id: "git.stashDrop", input: { index: st.index, ...input } },
            },
          ],
        }));
      }
      const m = /^stash:(\d+):/.exec(parent.id);
      if (!m) return [];
      const index = Number(m[1]);
      const input = stashRepo?.several ? { repository: stashRepo.root } : {};
      let files = stashFiles.get(index);
      if (!files) {
        const shown = await ide.commands.execute("git.stashShow", { index, ...input });
        files = (shown && shown.files) || [];
        stashFiles.set(index, files);
      }
      return files.map((f) => {
        const slashAt = f.path.lastIndexOf("/");
        return {
          id: `stash:${index}:${f.path}`,
          label: f.path.slice(slashAt + 1),
          description: `${f.status} ${slashAt > 0 ? f.path.slice(0, slashAt) : ""}`.trim(),
          tooltip: f.path,
          icon: "file",
          command: { id: "git.stashShow", input: { index, path: f.path, ...input } },
        };
      });
    },
  });
  const loadStashes = async () => {
    const mine = ++stashToken;
    let list = [];
    let repo = null;
    try {
      const all = await ide.git.repositories();
      repo = all.find((r) => r.selected) || all[0] || null;
      if (repo) list = await ide.git.stashes({ repository: repo.root });
      if (repo) repo = { root: repo.root, several: all.length > 1 };
    } catch {
      list = [];
      repo = null;
    }
    if (mine !== stashToken) return;
    // Indexes shift when one is dropped: the files of what was expanded no longer match.
    if (JSON.stringify(list) !== JSON.stringify(stashes) || repo?.root !== stashRepo?.root)
      stashFiles.clear();
    stashes = list;
    stashRepo = repo;
    stashTree.setMessage(
      !repo
        ? "Open a git repository."
        : list.length
          ? ""
          : "No stashes. Stash changes to set them aside and bring them back later.",
    );
    stashTree.refresh();
  };
  // The header's "Stash changes…" (D209): the IDE's own git.stash (it asks for the message).
  ide.commands.register("git.stashChanges", async () => {
    const message = await ide.ui.showInput({
      prompt: "Stash message (optional)",
      placeholder: "Press Enter to stash without a message",
    });
    if (message === undefined) return { stashed: false };
    const result = await ide.commands.execute("git.stash", { message });
    await loadStashes();
    return result;
  });

  ide.commands.register("git.showStashes", async () => {
    await ide.commands.execute("view.show", { id: "git.stashesView" });
    await loadStashes();
    return { stashes: stashes.length };
  });

  // ---- GitHub notifications ------------------------------------------------------------
  let notes = { list: [], error: null, loading: false, loaded: false };
  const notesOn = async () => (await ide.settings.get("github.notifications.enabled")) !== false;
  const noteTree = ide.ui.registerTreeView("github.notificationsView", {
    async getChildren(parent) {
      if (parent) return [];
      if (!(await notesOn())) return [];
      if (!notes.loaded && !notes.loading) loadNotes().catch(() => {});
      return notes.list.map((n) => ({
        id: n.id,
        label: n.subject.title,
        description: `${n.repository.full_name.split("/")[1] || ""} · ${longAge(Date.parse(n.updated_at) / 1000)}`,
        tooltip: `${n.unread ? "Unread · " : ""}${n.subject.title}\n${n.repository.full_name} · ${n.reason.replace(/_/g, " ")} · open on GitHub`,
        icon: NOTIFICATION_ICONS[n.subject.type] || "bell",
        strong: n.unread === true,
        command: { id: "github.openNotification", input: { id: n.id } },
        ...(n.unread && {
          actions: [
            {
              icon: "check",
              title: "Mark as read",
              command: { id: "github.markNotificationRead", input: { id: n.id } },
            },
          ],
        }),
      }));
    },
  });
  const showNotes = async () => {
    noteTree.setMessage(
      !(await notesOn())
        ? "Turned off (github.notifications.enabled)."
        : notes.loading && !notes.list.length
          ? "Loading…"
          : notes.error
            ? `Couldn't load notifications: ${notes.error}`
            : notes.list.length
              ? ""
              : "No unread notifications. Through the GitHub CLI (gh), with your own sign-in.",
    );
    noteTree.refresh();
  };
  const loadNotes = async (all = false) => {
    notes = { ...notes, loading: true };
    await showNotes();
    try {
      const list = await ide.github.notifications({ all });
      notes = { list, error: null, loading: false, loaded: true };
    } catch (err) {
      notes = {
        list: [],
        error: err instanceof Error ? err.message : String(err),
        loading: false,
        loaded: true,
      };
      await showNotes();
      throw err;
    }
    await showNotes();
    return notes.list;
  };
  ide.commands.register("github.notifications", async ({ all } = {}, { caller }) => {
    await showView("github.notificationsView", caller);
    const list = await loadNotes(all === true);
    return list.map((n) => ({
      id: n.id,
      repository: n.repository.full_name,
      type: n.subject.type,
      title: n.subject.title,
      reason: n.reason,
      unread: n.unread,
      updated: n.updated_at,
      url: notificationUrl(n),
    }));
  });
  ide.commands.register("github.markNotificationRead", async ({ id, all } = {}) => {
    if (all) await ide.github.markAllNotificationsRead();
    else if (id) await ide.github.markNotificationRead(String(id));
    else throw new Error("Name the notification (`id`) or pass `all`.");
    await loadNotes().catch(() => {});
    return { read: all ? "all" : id };
  });
  ide.commands.register("github.markAllNotificationsRead", () =>
    ide.commands.execute("github.markNotificationRead", { all: true }),
  );
  ide.commands.register("github.openNotification", async ({ id } = {}) => {
    const n = notes.list.find((x) => x.id === id);
    if (!n) throw new Error(`No notification ${id} (run GitHub notifications first).`);
    const url = notificationUrl(n);
    await ide.commands.execute("ui.openLink", { url });
    if (n.unread) await ide.commands.execute("github.markNotificationRead", { id: n.id });
    return { opened: url };
  });
  ide.state.register("ide://github/notifications", () =>
    notes.list.map((n) => ({ id: n.id, title: n.subject.title, unread: n.unread })),
  );

  showNotes().catch(() => {});

  // ---- Changes ----------------------------------------------------------------------------
  // A commit, checkout, stash or pull changes the blame and the stashes; another repository
  // selected shows its stashes.
  let pending = null;
  ide.git.onDidChange(() => {
    if (pending) return;
    pending = later(300).then(() => {
      pending = null;
      eachBlamed(0);
      loadStashes().catch(() => {});
    });
  });
  ide.settings.onChange((keys) => {
    if (keys.includes("git.blame.heatmap")) eachBlamed(0);
    if (keys.includes("github.notifications.enabled")) {
      if (notes.loaded) showNotes().catch(() => {});
      else loadNotes().catch(() => {});
    }
  });
  await loadStashes();
};

exports.deactivate = () => {};
