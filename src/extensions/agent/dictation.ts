// Dictation (D180, D384): where the composer's recordings go and how dictation gets set up.
// A recording goes to the speech model on this computer when one is downloaded (Whisper, free,
// offline: speech/ in Rust), else to a service with a key (Groq, OpenAI, or the provider
// agent.voice.provider names). With neither, the mic's first click offers to download a model
// (60 MB), to add a key, or (on Windows) Win+H. Commands: agent.voice.setup,
// agent.voice.downloadModel, agent.voice.cancelDownload, agent.voice.removeModel,
// agent.voice.transcribeFile. State: ide://agent/voice.
import {
  LOCAL_SPEECH_MODELS,
  ON_DEVICE,
  pickVoiceProvider,
  type VoiceRoute,
  voiceRoute,
} from "../../core/agent/voice";
import { aiIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { type SpeechModelStatus, speechIpc } from "../../core/ipc/speech";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { ProviderRegistry } from "./providers";
import { blobToBase64, type Recording } from "./view/voice";

const SAMPLE_RATE = 16_000;

/** How each model is offered. */
const MODEL_INFO: Record<string, { label: string; size: string }> = {
  base: { label: "Standard", size: "60 MB" },
  small: { label: "More accurate, slower", size: "190 MB" },
};

/** Providers with an API key set, as last looked up (the automatic choice, D190). */
let keyedProviders: { ids: Set<string>; at: number } | null = null;

async function providersWithKeys(providers: ProviderRegistry): Promise<Set<string>> {
  const all = providers.providers();
  const has = await Promise.all(all.map((p) => aiIpc.hasKey(p.id).catch(() => false)));
  const ids = new Set(all.filter((_, i) => has[i]).map((p) => p.id));
  keyedProviders = { ids, at: Date.now() };
  return ids;
}

/**
 * A recording (WebM / Ogg / MP4 from the web view) → 16 kHz mono samples, Whisper's input. The
 * web view decodes it; an offline audio graph resamples and mixes down.
 */
export async function toSamples(audio: Blob): Promise<Float32Array> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await audio.arrayBuffer());
  } catch {
    throw new Error("The recording couldn't be decoded.");
  } finally {
    void context.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  return known[ext] ?? "application/octet-stream";
}

export interface Dictation {
  /** Speech to text for a recording; rejects with a readable error. */
  transcribe(recording: Recording): Promise<string>;
  /** Whether a recording can start: false after showing the setup (or what's under way). */
  prepare(): Promise<boolean>;
}

export function registerDictation(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
): Dictation {
  const { dispatcher, settings, notifications, state } = services;
  let models: SpeechModelStatus[] = [];
  /** The latest download's progress, per model (0-100). */
  const percent = new Map<string, number>();

  const refresh = async (): Promise<SpeechModelStatus[]> => {
    models = await speechIpc.status().catch(() => models);
    return models;
  };
  void refresh();

  const localModel = () => settings.peek<string>("agent.voice.localModel") || "base";

  /** Where a recording would go now (keys looked up again when stale). */
  const route = async (
    fresh = false,
  ): Promise<VoiceRoute<ReturnType<ProviderRegistry["providers"]>[number]>> => {
    const named = settings.peek<string>("agent.voice.provider") ?? "";
    const keyed =
      fresh || !keyedProviders || Date.now() - keyedProviders.at > 10_000
        ? await providersWithKeys(providers)
        : keyedProviders.ids;
    const all = providers.providers();
    const pick =
      named === ON_DEVICE
        ? null
        : pickVoiceProvider(
            named ? all : all.filter((p) => keyed.has(p.id)),
            named,
            settings.peek<string>("agent.voice.model") ?? "",
          );
    const list = fresh ? await refresh() : models;
    return voiceRoute({
      chosen: named,
      pick,
      localModel: localModel(),
      installed: list.filter((m) => m.installed).map((m) => m.id),
    });
  };

  const language = () => settings.peek<string>("agent.voice.language") ?? "";

  /** Audio → text along the current route. */
  const speechToText = async (
    audio: Blob,
    mime: string,
  ): Promise<{ text: string; engine: string }> => {
    const r = await route(true);
    if (r.kind === "setup")
      throw new Error(
        "Dictation isn't set up: download a speech model (Set up dictation…) or add a Groq or OpenAI key.",
      );
    if (r.kind === "local") {
      const samples = await toSamples(audio);
      try {
        const text = await speechIpc.transcribe(r.model, samples, language());
        return { text, engine: `this computer (${r.model})` };
      } catch (err) {
        throw new Error(
          `Speech to text on this computer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const text = await aiIpc.transcribe(
        { id: r.provider.id, kind: r.provider.kind, baseUrl: r.provider.baseUrl },
        r.model,
        await blobToBase64(audio),
        mime,
        language() || undefined,
      );
      return { text, engine: `${r.provider.name} (${r.model})` };
    } catch (err) {
      throw new Error(
        `Speech to text (${r.provider.name}, ${r.model}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const download = async (
    model: string,
    test?: { url: string; sha256: string },
  ): Promise<string> => {
    const info = MODEL_INFO[model];
    const toast = notifications.progress(`Downloading the speech model (${info?.size ?? model})…`, {
      title: "Dictation",
      onCancel: () => void speechIpc.cancel(model),
    });
    percent.set(model, 0);
    try {
      const path = await speechIpc.install(
        model,
        (p) => {
          if (p.phase === "download" && p.total) {
            const pc = Math.round((p.received / p.total) * 100);
            percent.set(model, pc);
            toast.update(`Downloading the speech model (${info?.size ?? model})…`, pc);
          } else if (p.phase === "verify") toast.update("Checking the download…", 100);
        },
        test,
      );
      await refresh();
      notifications.show("success", "Dictation is ready: click the microphone and speak.", {
        title: "Dictation",
      });
      return path;
    } catch (err) {
      await refresh();
      const message = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(message))
        notifications.show("error", `The speech model didn't download: ${message}`, {
          title: "Dictation",
        });
      throw err;
    } finally {
      percent.delete(model);
      toast.close();
    }
  };

  let setupOpen = false;
  const setupDialog = async (): Promise<"download" | "key" | "cancel"> => {
    const model = localModel();
    const info = MODEL_INFO[model] ?? MODEL_INFO.base;
    const windows = services.platform === "windows";
    return showDialog<"download" | "key" | "cancel">({
      title: "Set up dictation",
      message: [
        `Dictation can run on this computer: free, offline, and private, after a one-time download of a speech model (${info?.size}). It understands 99 languages.`,
        "Or use a speech service with an API key (Groq has a free tier).",
        windows
          ? "Windows' own voice typing (Win + H) also works in any text box, with no setup."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      actions: [
        { label: "Use an API key", value: "key" },
        { label: `Download (${info?.size})`, value: "download", variant: "primary" },
      ],
      leftActions: [{ label: "Not now", value: "cancel" }],
      cancelValue: "cancel",
      defaultValue: "download",
    });
  };

  sub.add(
    dispatcher.register({
      id: "agent.voice.setup",
      title: "Set up dictation…",
      category: "Agent",
      description:
        "Asks how dictation should turn speech into text: download a speech model that runs on this computer (free, offline), or add a speech service's API key.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        // A second click while it's open doesn't stack another.
        if (setupOpen) return { choice: "cancel" };
        setupOpen = true;
        const choice = await setupDialog().finally(() => {
          setupOpen = false;
        });
        if (choice === "download")
          void dispatcher
            .execute("agent.voice.downloadModel", { model: localModel() })
            .catch(() => {});
        else if (choice === "key")
          void dispatcher.execute("agent.addProvider", { id: "groq" }).catch(() => {});
        return { choice };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.voice.downloadModel",
      title: "Download the speech model",
      category: "Agent",
      description:
        "Downloads a Whisper speech model for dictation on this computer (base: 60 MB, the default; small: 190 MB, more accurate and slower), checked against its pinned SHA-256. Shows progress; dictation uses it as soon as it's there.",
      input: s.object({
        model: s.enum(["base", "small"]).optional(),
        url: s.string().describe("Test builds only: a local stand-in").optional(),
        sha256: s.string().describe("Test builds only: its SHA-256").optional(),
      }),
      effects: ["network", "write"],
      run: async ({ model, url, sha256 }) => {
        const id = model ?? localModel();
        const test = url && sha256 ? { url, sha256 } : undefined;
        const path = await download(id, test);
        return { model: id, path };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.voice.cancelDownload",
      title: "Cancel the speech model's download",
      category: "Agent",
      description: "Stops a speech model download under way.",
      input: s.object({ model: s.enum(["base", "small"]).optional() }),
      effects: [],
      palette: false,
      run: async ({ model }) => ({ cancelled: await speechIpc.cancel(model ?? localModel()) }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.voice.removeModel",
      title: "Remove the speech model",
      category: "Agent",
      description:
        "Deletes a downloaded speech model (frees its disk space); dictation then uses a service with a key, or offers the download again.",
      input: s.object({ model: s.enum(["base", "small"]).optional() }),
      effects: ["write", "destructive"],
      run: async ({ model }) => {
        const ids = model ? [model] : [...LOCAL_SPEECH_MODELS];
        const removed: string[] = [];
        for (const id of ids) if (await speechIpc.remove(id)) removed.push(id);
        await refresh();
        return { removed };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.voice.transcribeFile",
      title: "Transcribe an audio file",
      category: "Agent",
      description:
        "Turns an audio file in the workspace (WAV, MP3, M4A, OGG, WebM, FLAC) into text with dictation's engine: the speech model on this computer if one is downloaded, else the speech service. Returns the text and which engine made it.",
      input: s.object({ path: s.string().describe("Audio file, relative to the workspace") }),
      effects: ["read", "network"],
      run: async ({ path }) => {
        const abs = services.workspace.resolve(path);
        const bytes = await fsIpc.read(abs);
        const mime = mimeOf(abs);
        return speechToText(new Blob([new Uint8Array(bytes)], { type: mime }), mime);
      },
    }),
  );
  sub.add(
    state.register("ide://agent/voice", {
      description:
        "Dictation: whether it's on, where speech goes now (this computer's model, a service, or setup needed), the language, and the speech models (size, downloaded, downloading with its percentage).",
      get: async () => {
        const r = await route();
        return {
          enabled: settings.peek<boolean>("agent.voice.enabled") !== false,
          route:
            r.kind === "provider"
              ? { kind: r.kind, provider: r.provider.id, model: r.model }
              : { kind: r.kind, model: r.model },
          language: language() || "auto",
          models: (await refresh()).map((m) => ({
            ...m,
            ...MODEL_INFO[m.id],
            ...(percent.has(m.id) && { percent: percent.get(m.id) }),
          })),
        };
      },
    }),
  );

  return {
    transcribe: async (recording) => (await speechToText(recording.audio, recording.mime)).text,
    prepare: async () => {
      const r = await route(true);
      if (r.kind !== "setup") return true;
      const going = models.find((m) => m.downloading);
      if (going) {
        notifications.show(
          "info",
          `The speech model is still downloading (${percent.get(going.id) ?? 0}%): dictation works once it's done.`,
          { title: "Dictation" },
        );
        return false;
      }
      void dispatcher.execute("agent.voice.setup", {}).catch(() => {});
      return false;
    },
  };
}
