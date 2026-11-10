// What the AI setup page and the first-run card offer (D164): model providers people use most
// (hosted ones need a key; local servers don't) and the agent CLIs a person may already pay for.
// DOM-free: the page (setupView.ts) and the commands read it.

import { presetForName, presetForUrl } from "./providerMatch";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providerPresets";

export { PROVIDER_PRESETS, type ProviderPreset };

/** The model `ollama pull` fetches from the setup card: small enough for most machines, uses tools. */
export const STARTER_OLLAMA_MODEL = "qwen3:8b";

/** How to get each agent CLI (the ACP presets, acp.ts), and the program that says it's there. */
export const AGENT_SETUP: Record<
  string,
  {
    program: string;
    install: string;
    signIn: string;
    /** Its own sign-out, where it has one (D401); Gemini CLI changes account with /auth instead. */
    signOut?: string;
    blurb: string;
    mark: string;
    brand: string;
  }
> = {
  "Claude Code": {
    mark: "CC",
    brand: "claudecode",
    program: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: "claude /login",
    signOut: "claude /logout",
    blurb: "Your Claude subscription or API key",
  },
  Codex: {
    mark: "Cx",
    brand: "codex",
    program: "codex",
    install: "npm install -g @openai/codex",
    signIn: "codex login",
    signOut: "codex logout",
    blurb: "Your ChatGPT plan or OpenAI key",
  },
  "Gemini CLI": {
    mark: "G",
    brand: "geminicli",
    program: "gemini",
    install: "npm install -g @google/gemini-cli",
    signIn: "gemini",
    blurb: "Your Google account",
  },
  "GitHub Copilot": {
    mark: "GH",
    brand: "github",
    program: "copilot",
    install: "npm install -g @github/copilot",
    signIn: "copilot /login",
    signOut: "copilot /logout",
    blurb: "Your GitHub Copilot plan",
  },
};

/**
 * Registry agents the agents list offers beside the presets, installed or not (D401): OpenCode
 * V2, a download from opencode.ai (no npm), whose free models need no account (D239).
 */
export const SUGGESTED_REGISTRY_AGENTS: readonly { id: string; name: string; blurb: string }[] = [
  {
    id: "opencode-v2",
    name: "OpenCode V2",
    blurb: "Free models, no account needed · or your OpenCode key",
  },
];

export interface ConfiguredProvider {
  id: string;
  name?: string;
  kind?: string;
  baseUrl: string;
}

/** agent.providers with `entry` added (replacing one with the same id). */
export function withProvider(list: unknown, entry: ConfiguredProvider): ConfiguredProvider[] {
  const current = Array.isArray(list) ? (list as ConfiguredProvider[]) : [];
  return [...current.filter((p) => p?.id !== entry.id), entry];
}

/** agent.providers without `id`. */
export function withoutProvider(list: unknown, id: string): ConfiguredProvider[] {
  const current = Array.isArray(list) ? (list as ConfiguredProvider[]) : [];
  return current.filter((p) => p?.id !== id);
}

/** A provider id from a name ("My Server" → "my-server"). */
export function providerId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "provider"
  );
}

/** A short, human reason a provider failed ("The key was rejected", "Can't reach it"). */
export function connectError(message: string): string {
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}key|incorrect api key|authentication/i.test(message))
    return "The key was rejected. Check it and try again.";
  if (/\b403\b|forbidden|permission/i.test(message))
    return "The key doesn't have access to this API.";
  if (/\b429\b|rate.?limit|quota/i.test(message)) return "Rate limited or out of quota right now.";
  if (/connect|dns|resolve|timed? ?out|unreachable|refused/i.test(message))
    return "Can't reach it. Check the address and your connection.";
  return message.split("\n")[0]?.slice(0, 160) ?? "It didn't answer.";
}

/** An address compared loosely: scheme and host lowercased, no trailing slashes. */
function addressKey(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The preset a configured provider is (D169): by id, else by address — one added by hand under
 * another id ("openrouter-ai", "https://openrouter.ai/api/v1/") still gets its logo and name, and
 * its tile isn't offered again — else by host (D212: "https://api.groq.com/openai/v1" under any
 * id or path is Groq).
 */
export function presetFor(provider: { id: string; baseUrl: string }): ProviderPreset | undefined {
  const key = addressKey(provider.baseUrl);
  return (
    PROVIDER_PRESETS.find((p) => p.id === provider.id) ??
    PROVIDER_PRESETS.find((p) => p.baseUrl && addressKey(p.baseUrl) === key) ??
    presetForUrl(provider.baseUrl)
  );
}

/**
 * The preset whose logo a provider's badge shows (D212): `presetFor`, else one its name clearly
 * is ("Groq proxy" at a local address isn't, "groq" is).
 */
export function brandPresetFor(provider: {
  id: string;
  name?: string;
  baseUrl: string;
}): ProviderPreset | undefined {
  return presetFor(provider) ?? presetForName(provider.name ?? provider.id);
}
