// Favorite and recent models for the model picker (D227). A pick is a provider model
// ("openai/gpt-5") or an external agent, alone ("acp/Codex") or with one of its own models
// ("acp/Codex#gpt-5.1"). Kept in agent.favoriteModels and agent.recentModels. DOM-free.

export const MAX_RECENT = 6;

export interface ParsedPick {
  /** The key agent.selectModel takes: "openai/gpt-5" or "acp/Codex". */
  model: string;
  /** An external agent's own model. */
  agentModel?: string;
}

/** An external agent's model as one pick key. */
export const agentPickKey = (agent: string, agentModel?: string): string =>
  agentModel ? `acp/${agent}#${agentModel}` : `acp/${agent}`;

export function parsePick(key: string): ParsedPick {
  if (!key.startsWith("acp/")) return { model: key };
  const hash = key.indexOf("#");
  return hash < 0 ? { model: key } : { model: key.slice(0, hash), agentModel: key.slice(hash + 1) };
}

/** A model's price for its row: "free", or dollars per million tokens in and out ("$3 / $15"). */
export function priceLabel(price: { input: number; output: number } | undefined | null): string {
  if (!price) return "";
  if (price.input === 0 && price.output === 0) return "free";
  const d = (n: number) => `$${n < 1 ? Number(n.toFixed(2)) : Number(n.toFixed(1))}`;
  return `${d(price.input)} / ${d(price.output)} per M`;
}

/** A string list from a setting's value (anything else: empty). */
export function pickList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

/** `key` first, without repeats, at most MAX_RECENT. */
export function withRecent(list: unknown, key: string): string[] {
  return [key, ...pickList(list).filter((k) => k !== key)].slice(0, MAX_RECENT);
}

/** `key` added to the favorites, or taken out when it's there. */
export function toggledFavorite(list: unknown, key: string): string[] {
  const now = pickList(list);
  return now.includes(key) ? now.filter((k) => k !== key) : [...now, key];
}
