// Notifications to the user's phone (D360): the agent's notify message also goes to a webhook the
// user set (`agent.notify.webhook`): an ntfy topic, a Discord or Slack incoming webhook, or any
// URL that takes JSON. The DOM-free part: the message made safe to send (one line, at most 200
// characters, no code, nothing that looks like a secret), each kind's request, which URLs are
// allowed, and which are secrets (kept in the secret store, not in settings).

export const WEBHOOK_KINDS = ["ntfy", "discord", "slack", "json"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/** What the setting holds: the URL, or (a secret one) where it is and that it's stored. */
export interface WebhookSetting {
  kind: WebhookKind;
  /** The URL itself, for one that isn't a secret (a local JSON endpoint). */
  url?: string;
  /** The URL is in the secret store; `host` says where it goes (for the settings page). */
  secret?: boolean;
  host?: string;
}

export interface WebhookRequest {
  body: string;
  contentType: string;
  /** Extra headers (ntfy's Title and Tags), ASCII only. */
  headers: Record<string, string>;
}

export const MAX_MESSAGE = 200;

/** The setting's value, checked; null when there's no webhook. */
export function parseWebhookSetting(value: unknown): WebhookSetting | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<WebhookSetting>;
  if (!WEBHOOK_KINDS.includes(v.kind as WebhookKind)) return null;
  const kind = v.kind as WebhookKind;
  if (v.secret === true)
    return { kind, secret: true, ...(typeof v.host === "string" && { host: v.host }) };
  if (typeof v.url === "string" && v.url.trim()) return { kind, url: v.url.trim() };
  return null;
}

/** Tokens and keys the message mustn't carry (provider keys, GitHub tokens, long random strings). */
const SECRET_LIKE = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|glpat|AKIA)[-_][\w-]{8,}/gi,
  /\b(?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}/g,
];

/** The message as it's sent: one line, no code, nothing secret-looking, at most 200 characters. */
export function safeNotifyMessage(text: string): string {
  let out = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`([^`]*)`/g, "$1");
  for (const re of SECRET_LIKE) out = out.replace(re, "[hidden]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

/** A header value: ASCII only (anything else is dropped), one line. */
function asciiHeader(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** What each kind's endpoint takes. `title`: who it's from (the chat's title, the IDE's name). */
export function webhookRequest(
  kind: WebhookKind,
  message: string,
  title: string,
  extra: { chat?: string; folder?: string; at?: number } = {},
): WebhookRequest {
  const text = safeNotifyMessage(message);
  switch (kind) {
    case "ntfy": {
      // ntfy takes the message as the body; Title and Tags as headers (ASCII).
      const head = asciiHeader(title);
      return {
        body: text,
        contentType: "text/plain; charset=utf-8",
        headers: { ...(head && { Title: head }), Tags: "robot" },
      };
    }
    case "discord":
      // No @everyone or role pings from a message the agent wrote.
      return {
        body: JSON.stringify({
          content: `**${title.replace(/[*_~`|]/g, "")}**: ${text}`,
          allowed_mentions: { parse: [] },
        }),
        contentType: "application/json",
        headers: {},
      };
    case "slack": {
      const esc = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return {
        body: JSON.stringify({ text: `*${esc(title)}*: ${esc(text)}` }),
        contentType: "application/json",
        headers: {},
      };
    }
    case "json":
      return {
        body: JSON.stringify({
          title,
          message: text,
          ...(extra.chat && { chat: extra.chat }),
          ...(extra.folder && { folder: extra.folder }),
          at: new Date(extra.at ?? Date.now()).toISOString(),
        }),
        contentType: "application/json",
        headers: {},
      };
  }
}

function hostOf(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")
  );
}

/** Why a webhook URL isn't allowed, or null: https, or http to this machine only. */
export function webhookUrlProblem(url: string): string | null {
  const u = hostOf(url.trim());
  if (!u) return "That isn't a URL.";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLocalHost(u.hostname)) return null;
  return u.protocol === "http:"
    ? "Use https (plain http only to this machine: localhost)."
    : "Use an https URL.";
}

/**
 * Whether the URL is a secret: an ntfy topic, a Discord or Slack webhook (anyone with it can post),
 * or any URL with a sign-in, a query string or a long random path part.
 */
export function webhookUrlIsSecret(kind: WebhookKind, url: string): boolean {
  if (kind !== "json") return true;
  const u = hostOf(url.trim());
  if (!u) return true;
  if (u.username || u.password || u.search) return true;
  return u.pathname.split("/").some((part) => /^[\w-]{20,}$/.test(part) && /\d/.test(part));
}

/** The host a URL goes to (what the settings page shows for a secret one). */
export function webhookHost(url: string): string {
  return hostOf(url.trim())?.host ?? "";
}

/** The kind a URL most likely is (Discord's and Slack's hosts, ntfy.sh), for the prompt. */
export function guessWebhookKind(url: string): WebhookKind {
  const host = webhookHost(url).toLowerCase();
  if (host.endsWith("discord.com") || host.endsWith("discordapp.com")) return "discord";
  if (host === "hooks.slack.com") return "slack";
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) return "ntfy";
  return "json";
}
