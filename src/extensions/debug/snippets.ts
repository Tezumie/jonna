// "Add configuration…" (D204), VS Code's launch.json snippets: a starter configuration for each
// debugger the IDE runs, inserted into the file's `configurations` (or `compounds`) without
// disturbing what's there — comments and formatting kept, the new entry indented like the
// others. DOM-free and tested.

export interface ConfigSnippet {
  label: string;
  description: string;
  /** "configurations" or "compounds". */
  into: "configurations" | "compounds";
  body: Record<string, unknown>;
}

export const CONFIG_SNIPPETS: readonly ConfigSnippet[] = [
  {
    label: "Node.js: Launch program",
    description: "Runs a script with Node, its child processes and workers debugged too",
    into: "configurations",
    body: {
      name: "Launch program",
      type: "node",
      request: "launch",
      program: `\${workspaceFolder}/index.js`,
      cwd: `\${workspaceFolder}`,
    },
  },
  {
    label: "Node.js: Launch via npm",
    description: "Runs an npm script; every Node process it starts is debugged",
    into: "configurations",
    body: {
      name: "Launch via npm",
      type: "node",
      request: "launch",
      runtimeExecutable: "npm",
      runtimeArgs: ["run-script", "dev"],
      cwd: `\${workspaceFolder}`,
    },
  },
  {
    label: "Node.js: Attach",
    description: "Attaches to a program started with --inspect",
    into: "configurations",
    body: { name: "Attach", type: "node", request: "attach", port: 9229 },
  },
  {
    label: "Node.js: Attach to process",
    description: "Picks a running Node process and attaches to it",
    into: "configurations",
    body: {
      name: "Attach to process",
      type: "node",
      request: "attach",
      processId: `\${command:pickProcess}`,
    },
  },
  {
    label: "Node.js: Launch and open in Chrome",
    description: "Starts a server and debugs the page once it's listening (serverReadyAction)",
    into: "configurations",
    body: {
      name: "Server and browser",
      type: "node",
      request: "launch",
      program: `\${workspaceFolder}/server.js`,
      serverReadyAction: {
        pattern: "listening on.* (https?://\\S+|[0-9]+)",
        uriFormat: "http://localhost:%s",
        action: "debugWithChrome",
      },
    },
  },
  {
    label: "Python: Current file",
    description: "debugpy (pip install debugpy)",
    into: "configurations",
    body: {
      name: "Python: current file",
      type: "debugpy",
      request: "launch",
      program: `\${file}`,
      console: "integratedTerminal",
    },
  },
  {
    label: "Python: Attach",
    description: "Attaches to debugpy listening on a port",
    into: "configurations",
    body: {
      name: "Python: attach",
      type: "debugpy",
      request: "attach",
      connect: { host: "127.0.0.1", port: 5678 },
    },
  },
  {
    label: "LLDB: Launch",
    description: "C, C++, Rust or Swift with lldb-dap",
    into: "configurations",
    body: {
      name: "LLDB: launch",
      type: "lldb-dap",
      request: "launch",
      program: `\${workspaceFolder}/target/debug/app`,
      args: [],
      cwd: `\${workspaceFolder}`,
    },
  },
  {
    label: "GDB: Launch",
    description: "C or C++ with GDB 14+",
    into: "configurations",
    body: {
      name: "GDB: launch",
      type: "gdb",
      request: "launch",
      program: `\${workspaceFolder}/a.out`,
      args: [],
      cwd: `\${workspaceFolder}`,
    },
  },
  {
    label: "Go: Launch package",
    description: "Delve (dlv dap)",
    into: "configurations",
    body: {
      name: "Go: launch package",
      type: "go",
      request: "launch",
      mode: "debug",
      program: `\${workspaceFolder}`,
    },
  },
  {
    label: ".NET: Launch",
    description: "netcoredbg",
    into: "configurations",
    body: {
      name: ".NET: launch",
      type: "coreclr",
      request: "launch",
      preLaunchTask: "build",
      program: `\${workspaceFolder}/bin/Debug/net8.0/app.dll`,
      args: [],
      cwd: `\${workspaceFolder}`,
    },
  },
  {
    label: "Chrome: Launch",
    description: "Opens a page in Chrome with the debugger attached",
    into: "configurations",
    body: {
      name: "Chrome: launch",
      type: "chrome",
      request: "launch",
      url: "http://localhost:5173",
      webRoot: `\${workspaceFolder}`,
    },
  },
  {
    label: "Edge: Launch",
    description: "Opens a page in Edge with the debugger attached",
    into: "configurations",
    body: {
      name: "Edge: launch",
      type: "msedge",
      request: "launch",
      url: "http://localhost:5173",
      webRoot: `\${workspaceFolder}`,
    },
  },
  {
    label: "Chrome: Attach",
    description: "Attaches to Chrome started with --remote-debugging-port",
    into: "configurations",
    body: { name: "Chrome: attach", type: "chrome", request: "attach", port: 9222 },
  },
  {
    label: "Compound",
    description: "Starts several configurations together",
    into: "compounds",
    body: { name: "Server and client", configurations: [], stopAll: true },
  },
];

/** A fresh launch.json holding `snippet`. */
export function newLaunchJson(snippet: ConfigSnippet): string {
  const entry = indentJson(snippet.body, "    ");
  const other = snippet.into === "compounds" ? "configurations" : "compounds";
  return `{\n  // Run and debug (F5). Same format as VS Code: \${workspaceFolder}, \${file}… are filled in.\n  "version": "0.2.0",\n  "${snippet.into}": [\n    ${entry}\n  ],\n  "${other}": []\n}\n`;
}

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/**
 * Positions in JSONC text outside strings and comments: calls `visit(i)` for each such char.
 * Stops early when `visit` returns true.
 */
function scan(text: string, visit: (i: number, depth: number) => boolean): void {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    if (visit(i, depth)) return;
    if (c === "}" || c === "]") depth--;
  }
}

/**
 * `text` (a launch.json) with `snippet` added at the end of its `configurations` / `compounds`
 * array (created when missing). Null when the text isn't an object we can edit.
 */
export function insertSnippet(text: string, snippet: ConfigSnippet): string | null {
  if (!text.trim()) return newLaunchJson(snippet);
  const key = `"${snippet.into}"`;
  // The top-level key (depth 1), its array's "[" and matching "]".
  let keyAt = -1;
  let rootEnd = -1;
  scan(text, (i, depth) => {
    if (depth === 1 && text[i] === "}") rootEnd = i;
    return false;
  });
  // Strings are skipped by scan, so find the key by looking at each top-level string start.
  {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        const start = i;
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
        if (depth === 1 && text.slice(start, i + 1) === key && /^\s*:/.test(text.slice(i + 1))) {
          keyAt = start;
          break;
        }
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") depth--;
    }
  }
  if (rootEnd < 0) return null;
  if (keyAt < 0) {
    // Add the key before the root's closing brace.
    const before = text.slice(0, rootEnd).replace(/\s*$/, "");
    const needsComma = !/[{,]$/.test(before);
    const entry = indentJson(snippet.body, "    ");
    return `${before}${needsComma ? "," : ""}\n  ${key}: [\n    ${entry}\n  ]\n${text.slice(rootEnd)}`;
  }
  const open = text.indexOf("[", keyAt);
  if (open < 0) return null;
  let close = -1;
  let lastValue = -1;
  scan(text.slice(open), (i, depth) => {
    const c = text[open + i];
    if (depth === 1 && c === "]") {
      close = open + i;
      return true;
    }
    if (i > 0 && depth >= 1 && c !== undefined && !/\s|,/.test(c) && !(depth === 1 && c === "["))
      lastValue = open + i;
    return false;
  });
  if (close < 0) return null;
  const empty = lastValue < 0;
  // Indent like the line the array's key is on, one level in.
  const lineStart = text.lastIndexOf("\n", keyAt) + 1;
  const keyIndent = /^\s*/.exec(text.slice(lineStart, keyAt))?.[0] ?? "  ";
  const inner = `${keyIndent}  `;
  const entry = indentJson(snippet.body, inner);
  if (empty)
    return `${text.slice(0, open + 1)}\n${inner}${entry}\n${keyIndent}${text.slice(close)}`;
  const head = text.slice(0, lastValue + 1);
  return `${head},\n${inner}${entry}${text.slice(lastValue + 1)}`;
}
