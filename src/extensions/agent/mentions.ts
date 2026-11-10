// The @-mentions added in D200: @git (the uncommitted changes), @commit (a commit's diff),
// @branch (this branch against the default branch), @chat (another chat's summary and
// transcript), @rules (every rules file) and @symbol (a definition's code, found in the
// repository map's symbols). Values and labels are in core/agent/mentions.ts; this gathers what
// each sends when the message goes, and the picks that follow choosing one.
import { conversationMarkdown } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import {
  CONTEXT_MENTIONS,
  excerpt,
  formatContextMention,
  parseContextMention,
  symbolCode,
  withoutHiddenFiles,
} from "../../core/agent/mentions";
import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { gitIpc } from "../../core/ipc/git";
import { joinPath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";
import { readText } from "./changeset";
import { isThisWorkspace } from "./chatWorkspace";
import { agentIgnored } from "./ignore";
import { repoMapFor } from "./repoMap";
import { rulesFor } from "./rules";
import type { SessionManager } from "./sessions";

export { CONTEXT_MENTIONS };

const DIFF_LIMIT = 60_000;
const CHAT_LIMIT = 24_000;

const cutDiff = (diff: string) =>
  diff.length > DIFF_LIMIT
    ? `${diff.slice(0, DIFF_LIMIT)}\n… (diff truncated; run git diff for the rest)`
    : diff;

/** The default branch to compare with (not the upstream: a pushed branch would show nothing). */
async function defaultBranch(head: string | null): Promise<string> {
  const names = new Set((await gitIpc.branches().catch(() => [])).map((b) => b.name));
  return (
    ["origin/main", "origin/master", "main", "master"].find((n) => names.has(n) && n !== head) ??
    "main"
  );
}

/** Untracked files as "new file" diffs (git diff leaves them out). */
async function untrackedDiffs(root: string, services: WorkbenchServices): Promise<string> {
  const files = ((await gitIpc.status().catch(() => null))?.files ?? [])
    .filter((f) => f.worktree === "?")
    .slice(0, 20);
  const out: string[] = [];
  for (const f of files) {
    const abs = joinPath(root, f.path);
    if (agentIgnored(services, abs)) continue;
    const text = await fsIpc
      .read(abs)
      .then((b) => new TextDecoder().decode(b.slice(0, 8000)))
      .catch(() => null);
    if (text === null || text.includes("\u0000")) continue;
    out.push(
      `diff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${text
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")}`,
    );
  }
  return out.join("\n");
}

/** A chat's transcript for @chat: its own summary (if it was compacted), then the conversation. */
async function chatTranscript(sessions: SessionManager, id: string): Promise<string | null> {
  const open = sessions.find(id);
  let title = open?.title.peek() ?? "";
  let items: Item[] | null = open?.items ?? null;
  if (!items) {
    const saved = await agentStoreIpc.load(id).catch(() => null);
    if (!saved) return null;
    try {
      const data = JSON.parse(saved) as { meta?: { title?: string }; items?: Item[] };
      title = data.meta?.title ?? "";
      items = Array.isArray(data.items) ? data.items : [];
    } catch {
      return null;
    }
  }
  return excerpt(conversationMarkdown(title || "Chat", items), CHAT_LIMIT);
}

/**
 * The context a D200 mention sends with the message (looked up when it's sent), or null when
 * `mention` isn't one of them.
 */
export async function contextMentionText(
  services: WorkbenchServices,
  sessions: SessionManager,
  mention: string,
): Promise<string | null> {
  const parsed = parseContextMention(mention);
  if (!parsed) return null;
  const root = services.workspace.root.peek();
  switch (parsed.kind) {
    case "git": {
      if (!root) return "Git changes: no folder is open.";
      const tracked = await gitIpc
        .diffRange("HEAD", DIFF_LIMIT)
        .catch(async () =>
          [await gitIpc.diff(true, DIFF_LIMIT), await gitIpc.diff(false, DIFF_LIMIT)].join("\n"),
        )
        .catch(() => "");
      const diff = `${tracked}\n${await untrackedDiffs(root, services)}`.trim();
      return diff
        ? `The uncommitted changes (git diff HEAD, and new files):\n\`\`\`diff\n${cutDiff(hideExcluded(services, root, diff))}\n\`\`\``
        : "Git changes: none (the working tree is clean).";
    }
    case "branch": {
      const head = (await gitIpc.status().catch(() => null))?.branch.head ?? null;
      const base = await defaultBranch(head);
      const diff = await gitIpc
        .diffRange(`${base}...${head ?? "HEAD"}`, DIFF_LIMIT)
        .catch(() => null);
      if (diff === null) return `Branch changes: couldn't compare ${head ?? "HEAD"} with ${base}.`;
      return diff.trim()
        ? `The changes on ${head ?? "HEAD"} since it left ${base} (git diff ${base}...${head ?? "HEAD"}):\n\`\`\`diff\n${cutDiff(hideExcluded(services, root, diff))}\n\`\`\``
        : `Branch changes: ${head ?? "HEAD"} has nothing that ${base} doesn't.`;
    }
    case "commit": {
      if (!parsed.arg) return "Commit: none was chosen.";
      const detail = await gitIpc.commitDetail(parsed.arg).catch(() => null);
      if (!detail) return `Commit ${parsed.arg}: not found.`;
      const diff = detail.parent
        ? await gitIpc.diffRange(`${detail.parent}..${detail.hash}`, DIFF_LIMIT).catch(() => "")
        : "";
      const files = detail.files.map((f) => `${f.status} ${f.path}`).join("\n");
      return `Commit ${detail.hash.slice(0, 10)} by ${detail.author} (${new Date(detail.time * 1000).toISOString().slice(0, 10)}):\n${detail.message.trim()}\n\nFiles:\n${files}${diff ? `\n\n\`\`\`diff\n${cutDiff(hideExcluded(services, root, diff))}\n\`\`\`` : ""}`;
    }
    case "chat": {
      const text = parsed.arg ? await chatTranscript(sessions, parsed.arg) : null;
      return text
        ? `An earlier chat, "${parsed.name || parsed.arg}" (its transcript; tool calls are one line each):\n${text}`
        : `Past chat ${parsed.name || parsed.arg}: not found.`;
    }
    case "rules":
      return rulesFor(services).mentionText();
    case "symbol": {
      const at = /^(.*):(\d+)$/.exec(parsed.arg);
      if (!root || !at?.[1]) return `Symbol ${parsed.name}: not found.`;
      const abs = services.workspace.resolve(at[1]);
      if (agentIgnored(services, abs))
        return `Symbol ${parsed.name} in ${at[1]}: excluded from the agent (its code wasn't sent).`;
      const text = await readText(services, abs);
      if (text === null) return `Symbol ${parsed.name}: ${at[1]} couldn't be read.`;
      return `${parsed.name} in ${services.workspace.relative(abs)}:\n\`\`\`\n${symbolCode(text, Number(at[2]))}\n\`\`\``;
    }
  }
}

/**
 * After choosing @commit, @chat or @symbol: the commit, chat or symbol (a quick pick), as the
 * mention's value; null when nothing was picked. Others come back as they are.
 */
export async function pickContextMention(
  services: WorkbenchServices,
  mention: string,
  current: string | undefined,
): Promise<string | null> {
  const { quickInput } = services;
  if (mention === "@commit") {
    const commits = await gitIpc.log(60).catch(() => []);
    if (!commits.length) throw new Error("No commits here (is this a git repository?).");
    const picked = await quickInput.pick(
      commits.map((c) => ({
        id: c.hash,
        label: c.subject,
        description: `${c.hash.slice(0, 7)} · ${c.author} · ${new Date(c.time * 1000).toISOString().slice(0, 10)}`,
      })),
      { placeholder: "Pick a commit: its message and diff go with the message" },
    );
    return picked ? formatContextMention("commit", picked.id, picked.label) : null;
  }
  if (mention === "@chat") {
    const chats = (await agentStoreIpc.list())
      .map((r) => ({
        id: r.id,
        meta: (r.meta ?? {}) as { title?: string; updated?: number; workspace?: string | null },
      }))
      .filter((r) => r.id !== current)
      .sort(
        (a, b) =>
          Number(isThisWorkspace(services, b.meta.workspace)) -
            Number(isThisWorkspace(services, a.meta.workspace)) ||
          (b.meta.updated ?? 0) - (a.meta.updated ?? 0),
      )
      .slice(0, 80);
    if (!chats.length) throw new Error("No other chats yet.");
    const picked = await quickInput.pick(
      chats.map((c) => ({
        id: c.id,
        label: c.meta.title || "Chat",
        description: `${c.meta.updated ? new Date(c.meta.updated).toLocaleDateString() : ""}${c.meta.workspace && !isThisWorkspace(services, c.meta.workspace) ? ` · ${c.meta.workspace}` : ""}`,
      })),
      { placeholder: "Pick a chat: its transcript goes with the message" },
    );
    return picked ? formatContextMention("chat", picked.id, picked.label) : null;
  }
  if (mention === "@symbol") {
    const map = repoMapFor(services);
    if (!map) throw new Error("Symbols aren't available yet.");
    const picked = await quickInput.pickDynamic({
      placeholder: "Search functions, classes and types by name",
      load: async (query) => ({
        items: (await map.symbols(query, 40)).map((sym) => ({
          id: `${sym.path}:${sym.line}`,
          label: sym.name,
          description: `${sym.path}:${sym.line}`,
          icon: "braces" as const,
        })),
      }),
    });
    return picked ? formatContextMention("symbol", picked.id, picked.label) : null;
  }
  return mention;
}

/** Symbols for the main mention picker's typed query (shown after the files). */
export async function symbolChoices(
  services: WorkbenchServices,
  query: string,
): Promise<{ id: string; label: string; description: string; icon: "braces" }[]> {
  const q = query.trim().replace(/^@/, "");
  if (q.length < 2 || /[\s/\\.]/.test(q)) return [];
  const syms = await repoMapFor(services)
    ?.symbols(q, 8)
    .catch(() => []);
  return (syms ?? []).map((sym) => ({
    id: formatContextMention("symbol", `${sym.path}:${sym.line}`, sym.name),
    label: sym.name,
    description: `Symbol · ${sym.path}:${sym.line}`,
    icon: "braces",
  }));
}

/** A diff without the files excluded from the agent (D200). */
function hideExcluded(services: WorkbenchServices, root: string | null, diff: string): string {
  if (!root) return diff;
  return withoutHiddenFiles(diff, (rel) => agentIgnored(services, joinPath(root, rel)));
}
