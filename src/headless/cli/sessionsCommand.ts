// Node only. `sessions list` and `sessions show <id>`: the saved chats, read from the same store
// the app's Chats list reads.
import type { Item } from "../../core/agent/conversation";
import type { HostedBrain, SavedChat } from "../run";
import type { CliArgs } from "./args";
import type { Io } from "./io";
import { ConfigError, start } from "./launch";
import { renderMarkdown } from "./markdown";
import { EXIT } from "./output";
import { toolBrief } from "./render";
import { clip, type Style, sanitize } from "./style";

/** "3 min ago", "2 days ago", or the date for anything older than a month. */
export function ago(then: number, now: number): string {
  if (!then) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** The chats as lines: number, id, when, title (and the folder with `all`). */
export function chatLines(
  chats: readonly SavedChat[],
  style: Style,
  now: number,
  all: boolean,
  columns: number,
): string {
  if (!chats.length) return "";
  const idWidth = Math.max(...chats.map((c) => c.id.length));
  return chats
    .map((c, n) => {
      const when = ago(c.updated, now).padEnd(11);
      const where = all && c.workspace ? style.dim(`  ${c.workspace}`) : "";
      const room = Math.max(16, columns - idWidth - 22 - (all && c.workspace ? 30 : 0));
      return `${style.dim(String(n + 1).padStart(3))}  ${c.id.padEnd(idWidth)}  ${style.dim(when)}  ${clip(sanitize(c.title), room, style.unicode)}${where}`;
    })
    .join("\n");
}

/** A conversation as text for a terminal: who said what, tool calls on one line each. */
export function conversationText(items: readonly Item[], style: Style, columns: number): string {
  const out: string[] = [];
  for (const item of items) {
    if (item.type === "user") {
      if (item.auto)
        out.push(style.dim(`[${item.auto}] ${clip(item.text, columns - 12, style.unicode)}`), "");
      else
        out.push(
          `${style.bold(style.cyan(">"))} ${sanitize(item.text).split("\n").join("\n  ")}`,
          "",
        );
    } else if (item.type === "assistant") {
      if (item.text.trim()) out.push(renderMarkdown(item.text.trim(), style), "");
    } else if (item.type === "tool") {
      const brief = toolBrief(item.name, item.args);
      out.push(
        style.dim(
          `${style.glyph("●", "*")} ${item.name}${brief ? ` ${clip(sanitize(brief), Math.max(20, columns - item.name.length - 30), style.unicode)}` : ""} ${style.glyph("→", "->")} ${item.status}${item.summary ? ` (${clip(sanitize(item.summary), 40, style.unicode)})` : ""}`,
        ),
      );
    } else if (item.type === "summary") {
      out.push(style.dim(`[summary of ${item.count} earlier items]`), sanitize(item.text), "");
    } else if (item.type === "notice") {
      out.push(style.dim(`${style.glyph("▸", ">")} ${sanitize(item.text)}`));
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** An item as plain data for `--json` (what is saved for the person only, images, is left out). */
function itemRecord(item: Item): Record<string, unknown> {
  switch (item.type) {
    case "user":
      return { type: "user", id: item.id, text: item.text, ...(item.auto && { auto: item.auto }) };
    case "assistant":
      return {
        type: "assistant",
        id: item.id,
        text: item.text,
        ...(item.thinking && { thinking: item.thinking }),
        ...(item.modelKey && { model: item.modelKey }),
      };
    case "tool":
      return {
        type: "tool",
        id: item.id,
        name: item.name,
        args: item.args,
        status: item.status,
        ...(item.summary && { summary: item.summary }),
        ...(item.result !== undefined && { result: item.result }),
      };
    case "summary":
      return { type: "summary", id: item.id, text: item.text, count: item.count };
    case "notice":
      return { type: "notice", id: item.id, text: item.text, tone: item.tone };
  }
}

export async function runSessions(args: CliArgs, io: Io): Promise<number> {
  const style = io.style("stdout", args.color);
  let brain: HostedBrain | null = null;
  try {
    // Nothing runs here: no question can come up, and the folder's trust doesn't matter.
    const started = await start(
      { ...args, addDirs: [], trust: false },
      {
        frontend: "cli",
        policy: { otherwise: "deny" },
        ...(args.verbose && { log: (text: string) => io.err(text) }),
      },
    );
    brain = started.brain;
    const chats = await brain.chats();
    if (args.sessionsAction === "show") {
      const wanted = args.sessionsId ?? "";
      // An id, or a unique start of one.
      const matches = chats.filter((c) => c.id === wanted);
      const starts = matches.length ? matches : chats.filter((c) => c.id.startsWith(wanted));
      if (starts.length !== 1)
        throw new ConfigError(
          starts.length
            ? `${wanted} is the start of ${starts.length} chats' ids: give more of it.`
            : `No saved chat with the id ${wanted}. See: sessions list --all.`,
        );
      const saved = starts[0] as SavedChat;
      const chat = await brain.open({ session: saved.id });
      const items = chat.session.items;
      if (args.json) {
        io.out(
          `${JSON.stringify({
            id: saved.id,
            title: saved.title,
            updated: saved.updated,
            workspace: saved.workspace,
            model: chat.session.model.peek(),
            items: items.map(itemRecord),
          })}\n`,
        );
      } else {
        io.out(
          `${style.bold(sanitize(saved.title))}\n${style.dim(`${saved.id} · ${ago(saved.updated, Date.now())}${saved.workspace ? ` · ${saved.workspace}` : ""}`)}\n\n`,
        );
        const text = conversationText(items, style, io.stdout.columns ?? 100);
        io.out(text ? `${text}\n` : `${style.dim("(empty)")}\n`);
      }
      return EXIT.ok;
    }
    const listed = args.all ? chats : chats.filter((c) => c.here);
    if (args.json) {
      io.out(`${JSON.stringify(listed)}\n`);
      return EXIT.ok;
    }
    if (!listed.length) {
      io.err(
        args.all || !chats.length
          ? "No saved chats.\n"
          : `No saved chats for this folder (${chats.length} for other folders: --all).\n`,
      );
      return EXIT.ok;
    }
    io.out(`${chatLines(listed, style, Date.now(), args.all, io.stdout.columns ?? 100)}\n`);
    return EXIT.ok;
  } finally {
    if (brain) {
      const closing = brain.dispose().catch(() => {});
      await Promise.race([closing, new Promise((done) => setTimeout(done, 8000).unref())]);
    }
  }
}
