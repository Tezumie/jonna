// The composer's voice input (D180): records from the microphone (MediaRecorder), shows a live
// waveform while you talk (an AnalyserNode's loudness, one bar every ~60 ms scrolling left, like
// the dictation bars in other chat apps), and hands the audio to the host to transcribe.
import { h } from "../../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../../core/lifecycle/index";

const BAR_MS = 60;
/** Recordings stop by themselves after this long (and stay well under 25 MB). */
const MAX_SECONDS = 300;

export interface Recording {
  audio: Blob;
  mime: string;
  seconds: number;
}

/** The first audio format this engine records (WebView2/Chromium: WebM Opus; WebKit: MP4). */
function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"])
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

export class VoiceRecorder implements Disposable {
  /** The waveform: draws the levels, newest on the right. */
  readonly canvas: HTMLCanvasElement = h("canvas", { class: "agent-voice-wave" });
  private readonly store = new DisposableStore();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private readonly chunks: Blob[] = [];
  private readonly levels: number[] = [];
  private started = 0;
  private mime = "";
  private stopped: ((r: Recording | null) => void) | null = null;

  constructor(
    /** Called every bar with the seconds so far (the timer). */
    private readonly onTick: (seconds: number) => void,
    /** The recording hit its time limit and stopped by itself. */
    private readonly onLimit: () => void,
  ) {}

  /** Asks for the microphone and starts recording; rejects with a readable error. */
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("This system's web view can't use a microphone.");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      throw new Error(
        name === "NotAllowedError"
          ? "The microphone isn't allowed: allow it for this app in your system's privacy settings."
          : name === "NotFoundError"
            ? "No microphone was found."
            : `The microphone didn't start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (this.store.isDisposed) {
      this.release();
      return;
    }
    this.mime = pickMime();
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : {});
    this.mime = this.recorder.mimeType || this.mime || "audio/webm";
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) this.chunks.push(e.data);
    });
    this.recorder.addEventListener("stop", () => {
      const audio = new Blob(this.chunks, { type: this.mime });
      const seconds = (performance.now() - this.started) / 1000;
      this.release();
      this.stopped?.(audio.size ? { audio, mime: this.mime, seconds } : null);
      this.stopped = null;
    });
    // The level meter for the waveform.
    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    this.started = performance.now();
    this.recorder.start(250);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      // RMS, scaled so speech fills most of the height and silence is a dotted line.
      this.levels.push(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      if (this.levels.length > 400) this.levels.shift();
      this.draw();
      const seconds = (performance.now() - this.started) / 1000;
      this.onTick(seconds);
      if (seconds >= MAX_SECONDS) this.onLimit();
    }, BAR_MS);
    this.store.add(toDisposable(() => window.clearInterval(timer)));
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = c.clientWidth;
    const height = c.clientHeight;
    if (!width || !height) return;
    if (c.width !== Math.round(width * dpr)) c.width = Math.round(width * dpr);
    if (c.height !== Math.round(height * dpr)) c.height = Math.round(height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    // The canvas's CSS color (a theme token) is the bars' color.
    g.fillStyle = getComputedStyle(c).color;
    const step = 4;
    const bars = Math.floor(width / step);
    const shown = this.levels.slice(-bars);
    const offset = width - shown.length * step;
    for (const [i, level] of shown.entries()) {
      const bar = Math.max(2, level * (height - 2));
      g.fillRect(offset + i * step, (height - bar) / 2, 2, bar);
    }
    // Before the first bars: a dotted line where silence will be.
    for (let x = 0; x < offset; x += step) g.fillRect(x, height / 2 - 0.5, 1, 1);
  }

  /** Stops and resolves with the recording (null: nothing was recorded). */
  stop(): Promise<Recording | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      this.stopped = resolve;
      recorder.stop();
    });
  }

  /** Stops and throws the audio away. */
  cancel(): void {
    this.stopped = null;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }

  /** The microphone and the audio graph go (the system's "in use" indicator turns off). */
  private release(): void {
    this.store.clear();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }

  dispose(): void {
    this.cancel();
    this.store.dispose();
  }
}

/** A recording as base64 (the transcription IPC carries text). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
