// Small working extensions to copy (D191, wishlist 15): models follow an example far better than
// reference text. Each is complete — manifest and code — and uses only the API in docs/extensions.md
// (the same calls as the test fixtures in tests/fixtures/extensions, which the UI tests run).

export interface ExtensionExample {
  name: string;
  summary: string;
  files: Record<string, string>;
}

const manifest = (o: Record<string, unknown>) => `${JSON.stringify(o, null, 2)}\n`;

export const EXAMPLES: readonly ExtensionExample[] = [
  {
    name: "status-bar",
    summary: "A status bar item that counts clicks (a command, a status bar item that runs it).",
    files: {
      "extension.json": manifest({
        id: "local.click-counter",
        version: "0.1.0",
        displayName: "Click counter",
        description: "Counts clicks on its status bar item.",
        icon: "zap",
        main: "main.js",
        activation: ["*"],
        permissions: [],
        contributes: {
          commands: [
            {
              id: "clickCounter.click",
              title: "Click counter: count",
              description: "Adds one.",
              effects: [],
            },
          ],
        },
      }),
      "main.js": `exports.activate = (ide) => {
  let clicks = 0;
  const item = ide.ui.createStatusBarItem({
    id: "count",
    text: "$(zap) 0",
    tooltip: "Click to count",
    command: "clickCounter.click",
  });
  ide.commands.register("clickCounter.click", async () => {
    clicks++;
    await item.update({ text: \`$(zap) \${clicks}\` });
    return { clicks };
  });
};
`,
    },
  },
  {
    name: "tree-view",
    summary: "A sidebar view with a tree of items; clicking one runs a command with input.",
    files: {
      "extension.json": manifest({
        id: "local.bookmarks-lite",
        version: "0.1.0",
        displayName: "Bookmarks lite",
        description: "A sidebar list of places to jump to.",
        icon: "bookmark",
        main: "main.js",
        activation: ["*"],
        permissions: [],
        contributes: {
          commands: [
            {
              id: "bookmarksLite.say",
              title: "Bookmarks lite: say",
              description: "Shows the item's name.",
              effects: [],
            },
          ],
          views: [
            {
              id: "bookmarksLite.list",
              title: "Bookmarks lite",
              location: "sidebar",
              type: "tree",
              icon: "bookmark",
            },
          ],
        },
      }),
      "main.js": `exports.activate = (ide) => {
  const groups = { Work: ["Inbox", "Today"], Ideas: ["Later"] };
  ide.commands.register("bookmarksLite.say", async (input) => {
    await ide.ui.notify(\`You picked \${input?.name ?? "nothing"}\`);
    return { name: input?.name ?? null };
  });
  ide.ui.registerTreeView("bookmarksLite.list", {
    getChildren(parent) {
      // Top level: the groups (collapsible); under a group: its items, which run a command.
      if (!parent)
        return Object.keys(groups).map((g) => ({ id: g, label: g, icon: "folder", collapsible: true }));
      return (groups[parent.id] ?? []).map((name) => ({
        id: \`\${parent.id}/\${name}\`,
        label: name,
        icon: "bookmark",
        command: { id: "bookmarksLite.say", input: { name } },
      }));
    },
  });
};
`,
    },
  },
  {
    name: "hover",
    summary:
      "Editor hovers and completions for a language (registerHoverProvider, registerCompletionProvider).",
    files: {
      "extension.json": manifest({
        id: "local.word-hints",
        version: "0.1.0",
        displayName: "Word hints",
        description: "Hovers that explain TODO and FIXME, and completes them.",
        icon: "file-text",
        main: "main.js",
        activation: ["onStartupFinished"],
        permissions: ["fs.read"],
        contributes: {},
      }),
      "main.js": `const HINTS = {
  TODO: "Something still to do. Find them all with Search: TODO",
  FIXME: "Something known to be broken.",
};

exports.activate = (ide) => {
  // "*" = every language; ctx has the word under the pointer (and path, line, column).
  ide.languages.registerHoverProvider("*", (ctx) => (ctx.word && HINTS[ctx.word] ? \`**\${ctx.word}**: \${HINTS[ctx.word]}\` : null));
  ide.languages.registerCompletionProvider("*", () =>
    Object.keys(HINTS).map((label) => ({ label, kind: "keyword", detail: HINTS[label] })),
  );
};
`,
    },
  },
  {
    name: "webview",
    summary:
      "A panel with its own HTML page that talks to main.js by messages, in the IDE's colors.",
    files: {
      "extension.json": manifest({
        id: "local.ping-panel",
        version: "0.1.0",
        displayName: "Ping panel",
        description: "A panel page that pings main.js and shows the answer.",
        icon: "bell",
        main: "main.js",
        activation: ["*"],
        permissions: [],
        contributes: {
          commands: [
            {
              id: "pingPanel.open",
              title: "Ping panel: open",
              description: "Shows the panel.",
              effects: [],
            },
          ],
          views: [
            {
              id: "pingPanel.page",
              title: "Ping",
              location: "panel",
              type: "webview",
              path: "page.html",
              icon: "bell",
            },
          ],
        },
      }),
      "main.js": `exports.activate = (ide) => {
  const page = ide.ui.webview("pingPanel.page");
  page.onMessage((m) => {
    if (m && typeof m.ping === "number") page.postMessage({ pong: m.ping + 1, at: new Date().toISOString() });
  });
  ide.commands.register("pingPanel.open", () => {
    page.reveal();
    return { opened: true };
  });
};
`,
      "page.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: var(--font-ui, sans-serif); background: var(--bg-app); color: var(--fg-default); padding: 12px; }
      button { background: var(--accent); color: var(--fg-on-accent); border: 0; border-radius: var(--radius-sm); padding: 4px 10px; }
    </style>
  </head>
  <body>
    <button id="ping">Ping</button>
    <p id="answer">No answer yet.</p>
    <script src="page.js"></script>
  </body>
</html>
`,
      "page.js": `const NS = "ide-webview";
const post = (message) => parent.postMessage({ ns: NS, message }, "*");
let n = 0;
addEventListener("message", (e) => {
  if (e.data?.ns !== NS) return;
  if (e.data.theme) {
    for (const [k, v] of Object.entries(e.data.theme.vars)) document.documentElement.style.setProperty(k, v);
    return;
  }
  document.getElementById("answer").textContent = JSON.stringify(e.data.message);
});
document.getElementById("ping").addEventListener("click", () => post({ ping: n++ }));
parent.postMessage({ ns: NS, ready: true }, "*");
`,
    },
  },
  {
    name: "viewer",
    summary: "A file viewer: opens *.note files in its own page and saves them back (fs.write).",
    files: {
      "extension.json": manifest({
        id: "local.note-viewer",
        version: "0.1.0",
        displayName: "Note viewer",
        description: "Opens .note files in a simple editing page.",
        icon: "pencil",
        activation: ["*"],
        permissions: ["fs.write"],
        contributes: {
          viewers: [
            {
              id: "noteViewer.viewer",
              title: "Note",
              extensions: [".note"],
              path: "viewer.html",
              default: true,
            },
          ],
        },
      }),
      "viewer.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; background: var(--bg-app); color: var(--fg-default); font-family: var(--font-ui, sans-serif); }
      textarea { box-sizing: border-box; width: 100%; height: calc(100vh - 32px); background: var(--bg-surface); color: inherit; border: 0; padding: 12px; font: inherit; resize: none; }
      p { margin: 0; padding: 6px 12px; color: var(--fg-muted); }
    </style>
  </head>
  <body>
    <p id="state">Loading…</p>
    <textarea id="text"></textarea>
    <script src="viewer.js"></script>
  </body>
</html>
`,
      "viewer.js": `const NS = "ide-webview";
const area = document.getElementById("text");
const state = document.getElementById("state");
let timer = 0;
addEventListener("message", (e) => {
  if (e.data?.ns !== NS) return;
  if (e.data.theme) {
    for (const [k, v] of Object.entries(e.data.theme.vars)) document.documentElement.style.setProperty(k, v);
    return;
  }
  // The file: { path, name, text, canSave } (again when it changes on disk).
  if (e.data.file) {
    if (document.activeElement !== area) area.value = e.data.file.text ?? "";
    state.textContent = e.data.file.error ?? e.data.file.name;
  }
  if ("saved" in e.data) state.textContent = e.data.saved ? "Saved" : \`Not saved: \${e.data.error}\`;
});
area.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => parent.postMessage({ ns: NS, save: area.value }, "*"), 500);
});
parent.postMessage({ ns: NS, ready: true }, "*");
`,
    },
  },
  {
    name: "editor-edit",
    summary: "Changes the text in the active editor (ide.editor.active / insert / replace).",
    files: {
      "extension.json": manifest({
        id: "local.stamp",
        version: "0.1.0",
        displayName: "Stamp",
        description: "Inserts the date at the cursor; uppercases the first line.",
        icon: "calendar",
        main: "main.js",
        activation: ["*"],
        permissions: ["fs.read", "fs.write"],
        contributes: {
          commands: [
            {
              id: "stamp.date",
              title: "Stamp: insert date",
              description: "Types today's date at the cursor.",
              effects: ["write"],
            },
            {
              id: "stamp.upperFirst",
              title: "Stamp: uppercase first line",
              description: "Uppercases line 1.",
              effects: ["write"],
            },
          ],
          menus: [{ location: "editor/context", command: "stamp.date" }],
        },
      }),
      "main.js": `exports.activate = (ide) => {
  ide.commands.register("stamp.date", async () => {
    const editor = await ide.editor.active();
    if (!editor) {
      await ide.ui.notify("Open a file first.", { kind: "warning" });
      return { inserted: false };
    }
    await ide.editor.insert(new Date().toISOString().slice(0, 10));
    return { inserted: true, path: editor.path };
  });
  ide.commands.register("stamp.upperFirst", async () => {
    const text = await ide.editor.text();
    const first = text.split("\\n")[0] ?? "";
    await ide.editor.replace({ startLine: 1 }, \`\${first.toUpperCase()}\\n\`);
    return { line: first.toUpperCase() };
  });
};
`,
    },
  },
];

/** One example as Markdown: its files in fenced blocks, then how to use it. */
export function exampleText(e: ExtensionExample): string {
  const lang = (f: string) => (f.endsWith(".json") ? "json" : f.endsWith(".html") ? "html" : "js");
  const files = Object.entries(e.files)
    .map(([f, text]) => `### ${f}\n\`\`\`${lang(f)}\n${text.trimEnd()}\n\`\`\``)
    .join("\n\n");
  return `# ${e.name}: ${e.summary}\n\n${files}\n\nTo build your own from it: extensions.create { name }, then write these files over the template's (keep your own id and names), extensions.validate { folder }, and extensions.try { id, command }.`;
}
