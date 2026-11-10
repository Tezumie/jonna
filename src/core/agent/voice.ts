// Voice input's choices (D180), DOM-free: which connected provider turns speech into text, with
// which model, or the model on this computer (D384), and the spoken "submit" words that send the
// message.

export interface VoiceProvider {
  id: string;
  kind: string;
  baseUrl: string;
}

/** Speech-to-text models of the services that offer one (OpenAI-compatible endpoint). */
const KNOWN: { host: RegExp; model: string; name: string }[] = [
  { host: /(^|\.)groq\.com$/, model: "whisper-large-v3-turbo", name: "Groq" },
  { host: /(^|\.)openai\.com$/, model: "gpt-4o-mini-transcribe", name: "OpenAI" },
];

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The provider and model voice input uses. `chosen` is agent.voice.provider ("" = automatic:
 * Groq first — fast, with a free tier — then OpenAI); `model` is agent.voice.model ("" = that
 * service's default). Another OpenAI-compatible server (a local Whisper) works when chosen by
 * id with a model named. Null: nothing connected can transcribe.
 */
export function pickVoiceProvider<P extends VoiceProvider>(
  providers: readonly P[],
  chosen: string,
  model: string,
): { provider: P; model: string } | null {
  const compatible = providers.filter((p) => p.kind !== "anthropic" && p.kind !== "ollama");
  if (chosen) {
    const p = compatible.find((x) => x.id === chosen);
    if (!p) return null;
    const known = KNOWN.find((k) => k.host.test(hostOf(p.baseUrl)));
    const m = model || known?.model;
    return m ? { provider: p, model: m } : null;
  }
  for (const k of KNOWN) {
    const p = compatible.find((x) => k.host.test(hostOf(x.baseUrl)));
    if (p) return { provider: p, model: model || k.model };
  }
  return null;
}

/** agent.voice.provider's value for the model on this computer (D384). */
export const ON_DEVICE = "device";

/** The speech models that run on this computer (D384), smallest first. */
export const LOCAL_SPEECH_MODELS = ["base", "small"] as const;

/** Where a recording goes (D384). `setup`: nowhere yet; the first-use dialog offers a choice. */
export type VoiceRoute<P> =
  | { kind: "provider"; provider: P; model: string }
  | { kind: "local"; model: string }
  | { kind: "setup"; model: string };

/**
 * Which engine turns speech into text. `chosen` is agent.voice.provider: "device" always means
 * the model on this computer (a provider may be called "local"); a provider id means that provider (its `pick`); "" is automatic: a
 * downloaded model first (the user chose it: private, no key), then a service with a key.
 * `localModel` is agent.voice.localModel; `installed` the downloaded models.
 */
export function voiceRoute<P>(opts: {
  chosen: string;
  pick: { provider: P; model: string } | null;
  localModel: string;
  installed: readonly string[];
}): VoiceRoute<P> {
  const wanted = (LOCAL_SPEECH_MODELS as readonly string[]).includes(opts.localModel)
    ? opts.localModel
    : "base";
  const local = opts.installed.includes(wanted)
    ? wanted
    : LOCAL_SPEECH_MODELS.find((m) => opts.installed.includes(m));
  if (opts.chosen === ON_DEVICE)
    return opts.installed.includes(wanted)
      ? { kind: "local", model: wanted }
      : { kind: "setup", model: wanted };
  if (opts.chosen)
    return opts.pick ? { kind: "provider", ...opts.pick } : { kind: "setup", model: wanted };
  if (local) return { kind: "local", model: local };
  if (opts.pick) return { kind: "provider", ...opts.pick };
  return { kind: "setup", model: wanted };
}

/**
 * A transcript ending with one of the submit words ("… and that's it, submit") sends the
 * message: the word (and the punctuation around it) comes off. Case and punctuation are ignored.
 */
export function splitSubmitWord(
  text: string,
  words: readonly string[],
): { text: string; submit: boolean } {
  const trimmed = text.trim();
  for (const w of words) {
    const word = w.trim();
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // Not \b: it only knows ASCII letters ("…, отправить" has to match too).
    const m = new RegExp(`[\\s,.;:!?¿¡-]*(?<![\\p{L}\\p{N}])${escaped}[\\s.!?]*$`, "iu").exec(
      trimmed,
    );
    if (m) return { text: trimmed.slice(0, m.index).trim(), submit: true };
  }
  return { text: trimmed, submit: false };
}
