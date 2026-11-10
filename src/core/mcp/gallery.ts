// The MCP server gallery (D204): a curated, built-in list of popular servers with what installing
// writes into an mcp.json (VS Code's format), so it shows without any network. Addresses and
// package names are the projects' own, as of this release; a server whose name is already
// configured shows as installed. DOM-free and tested.
import type { McpServerConfig } from "../settings/vscodeImport";
import type { McpIcon } from "./icons";

export interface GalleryInput {
  id: string;
  description: string;
  password: boolean;
  /** One of these is picked (a registry argument's `choices`, D223). */
  options?: string[];
  default?: string;
}

export interface GalleryEntry {
  id: string;
  title: string;
  description: string;
  category: "files" | "web" | "dev" | "data" | "work" | "docs";
  /** Where it runs: a local program (npx, uvx) or a remote address. */
  kind: "local" | "remote";
  config: McpServerConfig & { type?: "stdio" | "http" };
  inputs?: GalleryInput[];
  /** The remote server signs in with OAuth (the IDE's MCP sign-in). */
  oauth?: boolean;
  /** What must be installed for a local one. */
  needs?: string;
  /** What to look at before installing (a registry entry's risky runner options, D223). */
  warnings?: string[];
  homepage: string;
  /** A registry entry's server.json `icons`, checked (icons.ts). */
  icons?: McpIcon[];
}

export const MCP_GALLERY: readonly GalleryEntry[] = [
  {
    id: "filesystem",
    title: "Filesystem",
    description: "Read, write and search files in the folders you allow (here: the open folder).",
    category: "files",
    kind: "local",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
    },
    needs: "Node.js",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "git",
    title: "Git",
    description: "Read, search and change a git repository: status, diffs, log, branches, commits.",
    category: "dev",
    kind: "local",
    config: {
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-git", "--repository", "${workspaceFolder}"],
    },
    needs: "uv (Python)",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "fetch",
    title: "Fetch",
    description: "Fetches web pages and turns them into Markdown for the model.",
    category: "web",
    kind: "local",
    config: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    needs: "uv (Python)",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "memory",
    title: "Memory",
    description: "A knowledge graph the model keeps across chats: entities, relations, notes.",
    category: "data",
    kind: "local",
    config: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    needs: "Node.js",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    title: "Sequential thinking",
    description: "A tool for step-by-step problem solving that revises and branches its thoughts.",
    category: "dev",
    kind: "local",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    needs: "Node.js",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "time",
    title: "Time",
    description: "The current time and conversions between time zones.",
    category: "data",
    kind: "local",
    config: { type: "stdio", command: "uvx", args: ["mcp-server-time"] },
    needs: "uv (Python)",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "playwright",
    title: "Playwright",
    description:
      "Drives a real browser: navigate, click, fill forms, read pages by accessibility tree.",
    category: "web",
    kind: "local",
    config: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    needs: "Node.js",
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "chrome-devtools",
    title: "Chrome DevTools",
    description:
      "Chrome's DevTools for the model: performance traces, network, console, screenshots.",
    category: "web",
    kind: "local",
    config: { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    needs: "Node.js and Chrome",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
  },
  {
    id: "context7",
    title: "Context7",
    description: "Up-to-date, version-specific documentation and code examples for libraries.",
    category: "docs",
    kind: "remote",
    config: { type: "http", url: "https://mcp.context7.com/mcp" },
    homepage: "https://github.com/upstash/context7",
  },
  {
    id: "deepwiki",
    title: "DeepWiki",
    description: "Ask questions about public GitHub repositories and read their generated docs.",
    category: "docs",
    kind: "remote",
    config: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
    homepage: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
  },
  {
    id: "github",
    title: "GitHub",
    description: "Issues, pull requests, code search, Actions and repositories on GitHub.",
    category: "dev",
    kind: "remote",
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${input:github-token}" },
    },
    inputs: [{ id: "github-token", description: "GitHub personal access token", password: true }],
    homepage: "https://github.com/github/github-mcp-server",
  },
  {
    id: "sentry",
    title: "Sentry",
    description: "Errors, issues and releases from Sentry; signs in with your Sentry account.",
    category: "dev",
    kind: "remote",
    config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
    oauth: true,
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "linear",
    title: "Linear",
    description: "Find, create and update Linear issues and projects; signs in with Linear.",
    category: "work",
    kind: "remote",
    config: { type: "http", url: "https://mcp.linear.app/mcp" },
    oauth: true,
    homepage: "https://linear.app/docs/mcp",
  },
  {
    id: "notion",
    title: "Notion",
    description: "Search and edit Notion pages and databases; signs in with Notion.",
    category: "work",
    kind: "remote",
    config: { type: "http", url: "https://mcp.notion.com/mcp" },
    oauth: true,
    homepage: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "huggingface",
    title: "Hugging Face",
    description: "Search models, datasets, Spaces and papers on the Hugging Face Hub.",
    category: "data",
    kind: "remote",
    config: { type: "http", url: "https://huggingface.co/mcp" },
    oauth: true,
    homepage: "https://huggingface.co/settings/mcp",
  },
  {
    id: "brave-search",
    title: "Brave Search",
    description: "Web, news and image search through the Brave Search API.",
    category: "web",
    kind: "local",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: { BRAVE_API_KEY: "${input:brave-api-key}" },
    },
    inputs: [{ id: "brave-api-key", description: "Brave Search API key", password: true }],
    needs: "Node.js",
    homepage: "https://github.com/brave/brave-search-mcp-server",
  },
];

export function galleryEntry(id: string): GalleryEntry | undefined {
  return MCP_GALLERY.find((e) => e.id === id);
}

/** Entries matching a search (title, description, id), in gallery order. */
export function searchGallery(query: string): GalleryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return MCP_GALLERY.filter((e) =>
    words.every((w) =>
      `${e.id} ${e.title} ${e.description} ${e.category}`.toLowerCase().includes(w),
    ),
  );
}

/** What installing writes: the server's entry and its inputs, in mcp.json's shape. */
export function galleryConfig(entry: GalleryEntry): {
  server: Record<string, unknown>;
  inputs: {
    type: "promptString" | "pickString";
    id: string;
    description: string;
    password: boolean;
    options?: string[];
    default?: string;
  }[];
} {
  return {
    server: { ...entry.config },
    inputs: (entry.inputs ?? []).map((i) => ({
      type: i.options?.length ? "pickString" : "promptString",
      id: i.id,
      description: i.description,
      password: i.password,
      ...(i.options?.length && { options: i.options }),
      ...(i.default !== undefined && { default: i.default }),
    })),
  };
}
