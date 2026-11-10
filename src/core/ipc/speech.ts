// Dictation on this computer (D384): Whisper models downloaded on first use, and speech to text
// with one. Rust side: src-tauri/src/speech, src-tauri/src/ipc/speech.rs.
import { Channel, call } from "./invoke";

export interface SpeechModelStatus {
  /** "base" or "small". */
  id: string;
  /** The download's size. */
  bytes: number;
  installed: boolean;
  downloading: boolean;
}

export interface SpeechProgress {
  /** download, verify or done. */
  phase: string;
  received: number;
  total: number | null;
}

export const speechIpc = {
  status: (): Promise<SpeechModelStatus[]> => call<SpeechModelStatus[]>("speech_status"),
  /** Downloads a model (checked against its pinned SHA-256); its path. `test`: test builds only. */
  install: (
    model: string,
    onProgress: (p: SpeechProgress) => void,
    test?: { url: string; sha256: string },
  ): Promise<string> =>
    call<string>("speech_install", {
      model,
      ...(test && { url: test.url, sha256: test.sha256 }),
      onProgress: new Channel<SpeechProgress>(onProgress),
    }),
  cancel: (model: string): Promise<boolean> => call<boolean>("speech_cancel", { model }),
  remove: (model: string): Promise<boolean> => call<boolean>("speech_remove", { model }),
  /** 16 kHz mono samples → text. `language`: "en", "de"…; empty, the one it hears. */
  transcribe: (model: string, samples: Float32Array, language = ""): Promise<string> =>
    call<string>(
      "speech_transcribe",
      new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      { headers: { "x-model": model, ...(language && { "x-language": language }) } },
    ),
};
