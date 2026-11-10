// A turn's work group (D104, D151): one quiet line that says what the agent is doing (shimmering
// text while it works) or did ("Read 3 files, ran a command · 12s"), closed by default; opening
// it shows the steps as rows in a card (`steps.ts`).
//
// The status line is calm on purpose: each phrase stays at least MIN_SHOWN_MS and the next one
// fades in. When the agent moves fast (three tool calls in a second), the phrases in between are
// skipped and the line goes straight to the current one. "Nothing specific" (`WORKING`) shows
// as one of a few plain phrases, changing every few seconds, never "Thinking".
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { type Shot, shotStrip } from "./shots";
import { WORKING, WORKING_PHRASES } from "./turns";

export interface WorkGroupState {
  /** What it's doing while working (without "…"), else the summary. */
  label: string;
  working: boolean;
  open: boolean;
  /** "12s" once finished (when known). */
  duration: string | null;
  steps: readonly HTMLElement[];
  /** Screenshots the turn took (oldest first): thumbnails at the line's end (D155). */
  shots?: readonly Shot[];
}

/** How long a status phrase stays before the next may replace it. */
export const MIN_SHOWN_MS = 1100;
/** How long a generic phrase stays before the next generic one. */
const PHRASE_MS = 4200;
/** The fade between two phrases (matches the CSS transition). */
const FADE_MS = 160;

let phraseSeed = Math.floor(Math.random() * WORKING_PHRASES.length);

export class WorkGroup implements Disposable {
  readonly el: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly header: HTMLButtonElement;
  private readonly labelEl: HTMLElement;
  private readonly durationEl: HTMLElement;
  private readonly chevron: HTMLElement;
  private readonly body: HTMLElement;
  private chevronOpen: boolean | null = null;
  private readonly shotsEl: HTMLElement;
  /** Which shots the strip shows (rebuilt only when one is added). */
  private shotsKey = "";
  /** The text on screen, when it appeared, and what should replace it next. */
  private shown = "";
  private shownAt = 0;
  private wanted = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The generic phrase in use and when it was picked. */
  private phrase: string = WORKING_PHRASES[phraseSeed % WORKING_PHRASES.length] ?? WORKING;
  private phraseAt = 0;

  constructor(toggle: () => void) {
    this.labelEl = h("span", { class: "agent-work-label" });
    this.durationEl = h("span", { class: "agent-work-duration" });
    this.chevron = h("span", { class: "agent-work-chevron" });
    this.header = h(
      "button",
      { class: "agent-work-header", type: "button", "aria-expanded": "false" },
      this.labelEl,
      this.durationEl,
      this.chevron,
    );
    this.body = h("div", { class: "agent-work-body", hidden: true });
    this.shotsEl = h("div", { class: "agent-work-shots" });
    this.el = h(
      "div",
      { class: "agent-work" },
      h("div", { class: "agent-work-top" }, this.header, this.shotsEl),
      this.body,
    );
    this.store.add(on(this.header, "click", toggle));
    this.store.add(
      toDisposable(() => {
        clearTimeout(this.timer);
        clearTimeout(this.fadeTimer);
      }),
    );
  }

  update(state: WorkGroupState): void {
    this.el.classList.toggle("is-working", state.working);
    this.el.classList.toggle("is-open", state.open);
    this.setLabel(state.working ? `${this.phraseFor(state.label)}…` : state.label, state.working);
    this.durationEl.textContent = state.duration ?? "";
    this.durationEl.hidden = !state.duration;
    this.header.setAttribute("aria-expanded", String(state.open));
    if (this.chevronOpen !== state.open) {
      this.chevronOpen = state.open;
      this.chevron.replaceChildren(icon(state.open ? "chevron-down" : "chevron-right"));
    }
    const shots = state.shots ?? [];
    const key = `${shots.length}|${shots[shots.length - 1]?.image.length ?? 0}`;
    if (key !== this.shotsKey) {
      this.shotsKey = key;
      const strip = shotStrip(shots);
      this.shotsEl.replaceChildren(...(strip ? [strip] : []));
    }
    this.body.hidden = !state.open;
    const current = Array.from(this.body.children);
    if (current.length !== state.steps.length || state.steps.some((s, i) => current[i] !== s))
      this.body.replaceChildren(...state.steps);
  }

  /** `WORKING` becomes the current generic phrase (a new one every few seconds). */
  private phraseFor(label: string): string {
    if (label !== WORKING) return label;
    const now = Date.now();
    if (!this.phraseAt) this.phraseAt = now;
    else if (now - this.phraseAt >= PHRASE_MS) {
      phraseSeed++;
      this.phrase = WORKING_PHRASES[phraseSeed % WORKING_PHRASES.length] ?? WORKING;
      this.phraseAt = now;
    }
    return this.phrase;
  }

  /**
   * Shows `text` now if the current one has been up long enough (or work just ended), else once
   * it has; a newer text arriving meanwhile replaces the waiting one.
   */
  private setLabel(text: string, working: boolean): void {
    this.wanted = text;
    if (text === this.shown) {
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    const now = Date.now();
    // The first label, and the summary when work ends, show at once.
    if (!this.shown || !working) {
      this.swap(text, false);
      return;
    }
    const wait = this.shownAt + MIN_SHOWN_MS - now;
    if (wait <= 0) {
      this.swap(text, true);
      return;
    }
    if (this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.wanted !== this.shown) this.swap(this.wanted, true);
      }, wait);
  }

  private swap(text: string, fade: boolean): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.shown = text;
    this.shownAt = Date.now();
    clearTimeout(this.fadeTimer);
    if (!fade || !this.labelEl.textContent) {
      this.labelEl.classList.remove("is-fading");
      this.labelEl.textContent = text;
      return;
    }
    // Out, swap, in.
    this.labelEl.classList.add("is-fading");
    this.fadeTimer = setTimeout(() => {
      this.labelEl.textContent = this.shown;
      this.labelEl.classList.remove("is-fading");
    }, FADE_MS);
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** "8s", "2m 5s". */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
