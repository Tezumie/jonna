// suggest_extension (D314): the agent shows extensions from Open VSX as an install card in the
// chat (icon, name, publisher and its verified mark, what it does, Install), like Claude Code's
// SearchPlugins + SuggestPluginInstall. The card's data is kept in the call's `detail`, so it
// draws the same after a restart. Once per conversation, unless the user took it up (installed
// one, or asked about extensions since). DOM-free and tested.

import type { Item } from "./conversation";

export interface SuggestedExtension {
  /** namespace.name */
  id: string;
  displayName: string;
  publisher: string;
  description: string;
  verified?: boolean;
  iconUrl?: string;
  /** The installed version, when it is. */
  installed?: string;
}

export interface ExtensionSuggestion {
  /** One line on why it helps the task. */
  reason?: string;
  items: SuggestedExtension[];
  /** The user installed one from the card. */
  engaged?: boolean;
}

export const MAX_SUGGESTED = 3;

/** The card's data kept in a call's detail; null when there's none (or it isn't ours). */
export function parseSuggestion(detail: string | undefined): ExtensionSuggestion | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as Partial<ExtensionSuggestion>;
    if (!v || !Array.isArray(v.items)) return null;
    const items = v.items.filter(
      (i): i is SuggestedExtension =>
        !!i && typeof i.id === "string" && typeof i.displayName === "string",
    );
    return items.length ? { ...v, items } : null;
  } catch {
    return null;
  }
}

/** Words that say the user is asking about extensions (taking a suggestion up). */
const ENGAGED = /\b(extensions?|plugins?|install(?:ed|ing)?|add-?ons?|marketplace|open ?vsx)\b/i;

/**
 * The suggestion cards' once-per-conversation rule (D314; suggest_skill and suggest_mcp_server
 * too, D342 / D343): why another `tool` card isn't shown now, or null when it may be. Once,
 * unless the user took the last card up (its detail says `engaged`) or wrote about that kind of
 * thing since it (`engaged` words).
 */
export function oncePerConversation(
  items: readonly Item[],
  tool: string,
  engaged: RegExp,
  refusal: string,
): string | null {
  const last = items.findLastIndex(
    (i) => i.type === "tool" && i.name === tool && i.status === "done",
  );
  if (last < 0) return null;
  const card = items[last];
  if (card?.type === "tool" && engagedCard(card.detail)) return null;
  const since = items.slice(last + 1);
  if (since.some((i) => i.type === "user" && engaged.test(i.text))) return null;
  return refusal;
}

function engagedCard(detail: string | undefined): boolean {
  if (!detail) return false;
  try {
    return (JSON.parse(detail) as { engaged?: unknown } | null)?.engaged === true;
  } catch {
    return false;
  }
}

/**
 * Why another suggestion isn't shown now, or null when it may be: one per conversation, unless
 * the user installed from the last card or wrote about extensions since it.
 */
export function suggestionRefusal(items: readonly Item[]): string | null {
  return oncePerConversation(
    items,
    "suggest_extension",
    ENGAGED,
    "You already suggested extensions in this conversation and the user hasn't taken it up: don't suggest again unless they ask.",
  );
}

/** What the model gets back about the card. */
export function suggestionResult(s: ExtensionSuggestion): string {
  const list = s.items
    .map((i) => `${i.id}${i.installed ? ` (installed ${i.installed})` : ""}`)
    .join(", ");
  return `Shown to the user as an install card: ${list}. They install from the card; don't describe the extensions in your answer or install them yourself.`;
}
