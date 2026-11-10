// TODO tree — a bundled example extension (runs in a sandboxed worker, API: docs/extensions.md).
// Finds tagged comments with ide.workspace.findText (ripgrep in the backend, respects .gitignore)
// and shows them grouped by file or by tag. Refreshes when a file is saved or a setting changes.

const ICONS = {
  TODO: "circle-dot",
  FIXME: "circle-x",
  BUG: "circle-x",
  HACK: "triangle-alert",
  XXX: "triangle-alert",
  NOTE: "info",
};

let items = []; // { path, rel, line, tag, text }
let truncated = false;
let scanning = null;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function tags() {
  const t = await ide.settings.get("todoTree.tags");
  const list = Array.isArray(t) ? t.filter((x) => typeof x === "string" && x.trim()) : [];
  return list.length ? list.map((x) => x.trim()) : ["TODO", "FIXME", "HACK", "XXX", "BUG", "NOTE"];
}

/** "// TODO(ada): fix this" → { tag: "TODO", text: "fix this" }. */
function parse(text, tagList) {
  const re = new RegExp(`\\b(${tagList.map(escapeRe).join("|")})\\b(?:\\([^)]*\\))?:?\\s*(.*)`);
  const m = re.exec(text);
  if (!m) return null;
  const rest = m[2].replace(/\s*(?:\*\/|-->|#}|%>)\s*$/, "").trim();
  return { tag: m[1], text: rest || m[1] };
}

async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      if (!(await ide.workspace.root())) {
        items = [];
        return;
      }
      const tagList = await tags();
      const exclude = await ide.settings.get("todoTree.exclude");
      // A tag right after a comment marker (//, #, /*, *, <!--, --, ;), so prose isn't listed.
      const query = `(?://|#|/\\*|\\*|<!--|--|;)\\s*(?:${tagList.map(escapeRe).join("|")})\\b`;
      const result = await ide.workspace.findText(query, {
        isRegex: true,
        matchCase: true,
        exclude: Array.isArray(exclude) ? exclude : [],
        maxResults: 5000,
      });
      truncated = result.truncated;
      items = [];
      for (const m of result.matches) {
        const p = parse(m.text, tagList);
        if (p) items.push({ path: m.path, rel: m.rel, line: m.line, ...p });
      }
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

function leaf(t, withFile) {
  return {
    id: `${t.path}:${t.line}`,
    label: t.text.length > 120 ? `${t.text.slice(0, 119)}…` : t.text,
    description: withFile ? `${t.tag} · ${t.rel}:${t.line}` : `${t.tag} · line ${t.line}`,
    tooltip: `${t.rel}:${t.line}\n${t.tag}: ${t.text}`,
    icon: ICONS[t.tag] || "circle-dot",
    command: { id: "editor.openFile", input: { path: t.path, line: t.line } },
  };
}

function groups(byTag) {
  const map = new Map();
  for (const t of items) {
    const key = byTag ? t.tag : t.rel;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return map;
}

exports.activate = async (ide) => {
  const tree = ide.ui.registerTreeView("todoTree.view", {
    async getChildren(parent) {
      const byTag = (await ide.settings.get("todoTree.groupByTag")) === true;
      if (!parent) {
        if (!items.length && !scanning) await scan();
        if (!items.length)
          return [{ id: "empty", label: "No TODOs in this folder", icon: "check" }];
        const rows = [...groups(byTag)].map(([key, list]) => ({
          id: `g:${key}`,
          label: key,
          description: String(list.length),
          icon: byTag ? ICONS[key] || "tag" : "file",
          collapsible: true,
        }));
        if (truncated) rows.push({ id: "more", label: "Showing the first 5000", icon: "info" });
        return rows;
      }
      if (!parent.id.startsWith("g:")) return [];
      const list = groups(byTag).get(parent.id.slice(2)) || [];
      return list.map((t) => leaf(t, byTag));
    },
  });

  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await scan();
      tree.refresh();
    }, 500);
  };
  ide.events.on("files.didSave", later);
  ide.events.on("files.didCreate", later);
  ide.events.on("files.didDelete", later);
  ide.settings.onChange(later);

  ide.commands.register("todoTree.refresh", async () => {
    await scan();
    tree.refresh();
    return { count: items.length, truncated };
  });
  ide.commands.register("todoTree.list", async () => {
    await scan();
    return {
      count: items.length,
      truncated,
      items: items.map(({ rel, line, tag, text }) => ({ path: rel, line, tag, text })),
    };
  });
  ide.commands.register("todoTree.goTo", async () => {
    await scan();
    if (!items.length) {
      await ide.ui.notify("No TODOs found.");
      return { opened: null };
    }
    const pick = await ide.ui.showQuickPick(
      items.map((t) => ({ label: `${t.tag}: ${t.text}`, description: `${t.rel}:${t.line}`, t })),
      { placeholder: "Go to a TODO" },
    );
    if (!pick) return { opened: null };
    await ide.commands.execute("editor.openFile", { path: pick.t.path, line: pick.t.line });
    return { opened: `${pick.t.rel}:${pick.t.line}` };
  });

  await scan();
  tree.refresh();
};

exports.deactivate = () => {};
