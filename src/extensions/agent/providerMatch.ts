// Which preset a name or an address is (D212). The "Other server" form's name box suggests
// presets as the user types ("groqai" → Groq, "together" → Together AI), and a provider added by
// hand gets its preset's logo when its address is the preset's host (a custom entry pointed at
// api.groq.com shows the Groq logo) or its name clearly is the preset's. DOM-free, unit-tested.

import { PROVIDER_PRESETS, type ProviderPreset } from "./providerPresets";

/** Lowercase letters and digits only ("Together AI" → "togetherai"). */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Words that say nothing about which provider it is. */
const FILLER = ["ai", "api", "cloud", "inc", "llm", "server", "platform", "inference", "hq"];

/** Without trailing filler ("groqai" → "groq", "togetheraiapi" → "together"); keeps ≥ 3 letters. */
export function stripFiller(key: string): string {
  let out = key;
  for (let changed = true; changed; ) {
    changed = false;
    for (const word of FILLER) {
      if (out.endsWith(word) && out.length - word.length >= 3) {
        out = out.slice(0, -word.length);
        changed = true;
      }
    }
  }
  return out;
}

/** Edit distance, stopping early once it's past `max` (returns max + 1 then). */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/** A preset's names: [key, weight]. Its id and full name count most; words and aliases a bit less. */
function keysOf(p: ProviderPreset): [string, number][] {
  const full = normalizeName(p.name);
  const out = new Map<string, number>([
    [p.id, 1],
    [full, 1],
    [stripFiller(full), 1],
  ]);
  const words = p.name.split(/[\s()]+/).map(normalizeName);
  const aliases = (p.aliases ?? []).map(normalizeName);
  // A two-letter alias ("hf") counts; a two-letter word of the name doesn't.
  for (const k of [...words, ...aliases])
    if ((k.length >= 3 || aliases.includes(k)) && !FILLER.includes(k) && !out.has(k))
      out.set(k, 0.9);
  return [...out];
}

/** How well `query` (normalized) names `key`, 0–100. */
function scoreKey(q: string, key: string): number {
  if (!key) return 0;
  if (q === key) return 100;
  const qs = stripFiller(q);
  if (qs === key || q === stripFiller(key)) return 95;
  if (q.length >= 2 && key.startsWith(q)) return 70 + 20 * (q.length / key.length);
  if (key.length >= 3 && q.startsWith(key)) return 60 + 20 * (key.length / q.length);
  if (q.length >= 3 && key.includes(q)) return 50;
  const shorter = Math.min(qs.length, key.length);
  const max = shorter >= 7 ? 2 : shorter >= 4 ? 1 : 0;
  if (max) {
    const d = distance(qs, key, max);
    if (d <= max) return 45 - 5 * d;
  }
  return 0;
}

export interface PresetMatch {
  preset: ProviderPreset;
  score: number;
}

/**
 * Presets a typed name could mean, best first (at most `limit`). Under two letters: none. Ties keep
 * the catalog's order (the common ones first).
 */
export function matchPresets(
  query: string,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
  limit = 5,
): PresetMatch[] {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const scored: PresetMatch[] = [];
  for (const preset of presets) {
    let best = 0;
    for (const [key, weight] of keysOf(preset)) best = Math.max(best, scoreKey(q, key) * weight);
    if (best > 0) scored.push({ preset, score: Math.round(best) });
  }
  scored.sort((a, b) => b.score - a.score);
  // Far behind the best: noise ("lm studio" isn't Gemini because of "AI Studio").
  const best = scored[0]?.score ?? 0;
  return scored.filter((m) => m.score >= best - 40).slice(0, limit);
}

/** The preset a name clearly is (an exact name, id or alias, give or take "AI"/"API"). */
export function presetForName(
  name: string,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): ProviderPreset | undefined {
  const top = matchPresets(name, presets, 1)[0];
  return top && top.score >= 90 ? top.preset : undefined;
}

const LOCAL_HOST = /^(127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|\[::1\])$/;

/** The hosts that are a preset: its own list, else its base URL's host (none for local ones). */
function hostsOf(p: ProviderPreset): string[] {
  if (p.hosts) return p.hosts;
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host && !LOCAL_HOST.test(host) ? [host] : [];
  } catch {
    return [];
  }
}

/** The preset whose service `url` points at (its host or a subdomain of it); not local servers. */
export function presetForUrl(
  url: string,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): ProviderPreset | undefined {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host || LOCAL_HOST.test(host)) return undefined;
  return presets.find((p) => hostsOf(p).some((h) => host === h || host.endsWith(`.${h}`)));
}
