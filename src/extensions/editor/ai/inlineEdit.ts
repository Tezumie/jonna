// Inline edit (D106, D172): Ctrl+K in an editor (like Cursor) opens a one-line prompt above the
// selected lines (or the cursor's line). The model rewrites those lines, and the change is shown
// hunk by hunk (hunks.ts): new lines highlighted, old ones struck through above them, each with
// its own Accept / Reject; Ctrl+Enter accepts the rest, Esc rejects everything. Follow-up
// instructions refine the result; rejecting always restores the original text.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import type { LanguageModelService } from "../../../workbench/services";
import type { EditorZone, EngineEditor, LineRange } from "../engine";
import { compose, hunkPositions, hunkStat, hunks, type Segment, segmentsOf } from "./hunks";
import { cleanEdit, EDIT_SYSTEM, editPrompt } from "./prompts";

export type InlineEditPhase = "prompt" | "working" | "review";

export interface InlineEditHost {
  model: LanguageModelService;
  path: string;
  languageId: string;
  /** The file's text (LF). */
  text(): string;
  /** The document's version id (to tell whether anything else changed it since our edits). */
  versionId(): number;
  /** Sets the `inlineEditVisible` / `inlineEditReview` context keys (Esc, Ctrl+Enter). */
  setPhase(phase: InlineEditPhase | null): void;
  /** Keybinding label of a command ("Ctrl+Enter"). */
  keyLabel(command: string): string | undefined;
  notifyError(message: string): void;
  /** Runs a command (the hunks' buttons go through the dispatcher like every action). */
  run(command: string, input: unknown): void;
  /** Any change to the document's text (ours included: `applying` tells them apart). */
  onDidChange(listener: () => void): { dispose(): void };
}

/** A hunk's buttons row, in pixels (its old lines add a line height each). */
const HUNK_BAR = 26;

const MAX_TOKENS = 4096;

export class InlineEdit {
  private readonly store = new DisposableStore();
  private readonly review = new DisposableStore();
  private readonly node: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  /** Holds the first hunk's block when it starts at the first line (it shares the bar's zone). */
  private readonly firstHunk: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly zone: EditorZone;
  /** The text before the first edit (what reject restores) and the lines it covered. */
  private readonly original: string;
  private range: LineRange;
  private phase: InlineEditPhase = "prompt";
  private abort: AbortController | null = null;
  private done = false;
  /** Our replacements so far, and the version right after the last one (reject undoes them). */
  private edits = 0;
  private versionAfterEdits = -1;
  /** The latest rewrite against the original, hunk by hunk (null before the first). */
  private segments: Segment[] | null = null;
  /** While this edit writes to the document (its own changes aren't "someone else's"). */
  private applying = false;
  /** The lines were changed by someone else while the prompt was open (D174 audit). */
  private moved = false;
  private readonly closedListeners: (() => void)[] = [];

  constructor(
    private readonly editor: EngineEditor,
    selection: LineRange,
    private readonly host: InlineEditHost,
    private readonly onClose: () => void,
  ) {
    this.range = selection;
    this.original = editor.linesText(selection);
    this.input = h("input", {
      class: "inline-edit-input",
      type: "text",
      placeholder: "Edit selection… (Enter)",
      spellcheck: "false",
      "aria-label": "Instruction for the selected lines",
    }) as HTMLInputElement;
    this.status = h("span", { class: "inline-edit-status" });
    const button = (label: string, cls: string, run: () => void, hint?: string) => {
      const b = h(
        "button",
        { class: `button ${cls} button-sm`, type: "button" },
        label,
        hint ? h("span", { class: "inline-edit-key" }, hint) : null,
      );
      this.store.add(on(b, "mousedown", (e) => e.preventDefault()));
      this.store.add(on(b, "click", run));
      return b;
    };
    this.actions = h(
      "span",
      { class: "inline-edit-actions", hidden: true },
      button("Reject", "button-ghost", () => this.reject(), "Esc"),
      button(
        "Accept",
        "button-accent",
        () => this.accept(),
        host.keyLabel("editor.inlineEdit.accept") ?? "Ctrl+Enter",
      ),
    );
    const model = host.model.model("edit");
    this.firstHunk = h("div", { class: "inline-edit-first" });
    this.node = h(
      "div",
      { class: "inline-edit" },
      h(
        "div",
        { class: "inline-edit-bar" },
        icon("pencil"),
        this.input,
        this.status,
        this.actions,
        h(
          "span",
          { class: "inline-edit-model" },
          model ? model.slice(model.indexOf("/") + 1) : "no model",
        ),
      ),
      this.firstHunk,
    );
    this.store.add(
      on(this.input, "keydown", (e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          const text = this.input.value.trim();
          if (text) void this.run(text);
        }
      }),
    );
    this.zone = editor.addZone(selection.startLine - 1, this.node, this.barHeight());
    // Typing elsewhere in the file moves these lines: the edit would then write to the wrong
    // ones. A change that isn't ours ends it — the result kept as it stands in review, the
    // request dropped while it runs — or, with only the prompt open, it asks again (D174 audit).
    this.store.add(
      host.onDidChange(() => {
        if (this.applying || this.done) return;
        if (this.phase === "working") {
          this.abort?.abort();
          this.close();
          host.notifyError("the file changed while the model was answering; ask again.");
        } else if (this.phase === "review") this.close();
        else this.moved = true;
      }),
    );
    this.setPhase("prompt");
    // At once (the keys right after Ctrl+K are typing), and again once the zone is laid out.
    this.input.focus();
    requestAnimationFrame(() => this.input.focus());
  }

  private barHeight(): number {
    return 38;
  }

  get state(): {
    phase: InlineEditPhase;
    range: LineRange;
    hunks: { state: string; added: number; removed: number }[];
  } {
    return {
      phase: this.phase,
      range: this.range,
      hunks: hunks(this.segments ?? []).map((h) => ({
        state: h.state,
        added: h.added.length,
        removed: h.removed.length,
      })),
    };
  }

  private setPhase(phase: InlineEditPhase): void {
    this.phase = phase;
    this.node.dataset.phase = phase;
    this.actions.hidden = phase !== "review";
    this.input.disabled = phase === "working";
    this.input.placeholder =
      phase === "review" ? "Ask for changes… (Enter)" : "Edit selection… (Enter)";
    this.host.setPhase(phase);
  }

  /** Rewrites the lines (the current result, after the first edit) with `instruction`. */
  async run(instruction: string): Promise<void> {
    if (this.phase === "working" || this.done) return;
    if (this.moved) {
      this.close();
      throw new Error("The file changed since the prompt opened; select the lines and ask again.");
    }
    this.input.value = instruction;
    this.setPhase("working");
    this.status.textContent = "Editing…";
    this.status.classList.add("is-shimmer");
    const abort = new AbortController();
    this.abort = abort;
    const current = this.editor.linesText(this.range);
    try {
      const reply = await this.host.model.generate({
        purpose: "edit",
        system: EDIT_SYSTEM,
        prompt: editPrompt({
          path: this.host.path,
          languageId: this.host.languageId,
          text: this.host.text(),
          startLine: this.range.startLine,
          endLine: this.range.endLine,
          instruction,
        }),
        maxTokens: MAX_TOKENS,
        signal: abort.signal,
        onText: (t) => {
          const lines = t.split("\n").length;
          this.status.textContent = `Editing… ${lines} line${lines === 1 ? "" : "s"}`;
        },
      });
      if (this.done || abort.signal.aborted) return;
      // Exact line text, a trailing blank line included (it's a line of the range).
      const next = cleanEdit(reply, current);
      if (!next.trim() && current.trim()) throw new Error("The model returned nothing.");
      const segments = segmentsOf(this.original, next);
      if (!hunks(segments).length) throw new Error("The model made no changes.");
      this.segments = segments;
      this.apply();
      this.showReview();
      this.input.value = "";
    } catch (err) {
      if (!this.done) {
        this.host.notifyError(err instanceof Error ? err.message : String(err));
        this.setPhase(this.original === this.editor.linesText(this.range) ? "prompt" : "review");
      }
    } finally {
      this.abort = null;
      this.status.classList.remove("is-shimmer");
      this.status.textContent = this.phase === "review" ? this.diffSummary() : "";
      if (!this.done) requestAnimationFrame(() => this.input.focus());
    }
  }

  private diffSummary(): string {
    if (!this.segments) return "";
    const { added, removed } = hunkStat(this.segments);
    return `+${added} −${removed}`;
  }

  /** Puts the lines as they stand (accepted / pending: new; rejected: old) into the editor. */
  private apply(): void {
    if (!this.segments) return;
    const text = compose(this.segments);
    if (text === this.editor.linesText(this.range)) return;
    this.applying = true;
    try {
      this.range = this.editor.replaceLines(this.range, text);
    } finally {
      this.applying = false;
    }
    this.edits++;
    this.versionAfterEdits = this.host.versionId();
  }

  /** Each pending hunk: its new lines highlighted, its old ones and its buttons above them. */
  private showReview(): void {
    this.review.clear();
    this.firstHunk.replaceChildren();
    const segments = this.segments ?? [];
    const lineHeight = this.editor.lineHeight();
    const positions = hunkPositions(segments);
    let firstHeight = 0;
    hunks(segments).forEach((hunk, index) => {
      const at = positions[index];
      if (hunk.state !== "pending" || !at) return;
      const start = this.range.startLine + at.start;
      if (at.count)
        this.review.add(
          this.editor.decorateLines(
            { startLine: start, endLine: start + at.count - 1 },
            "inline-edit-added",
          ),
        );
      const block = this.hunkBlock(hunk.removed, index, lineHeight);
      const height = HUNK_BAR + (hunk.removed.length ? hunk.removed.length * lineHeight + 8 : 0);
      if (at.start === 0) {
        this.firstHunk.append(block);
        firstHeight = height;
      } else this.review.add(this.editor.addZone(start - 1, block, height));
    });
    this.zone.setHeight(this.barHeight() + firstHeight);
    this.status.textContent = this.diffSummary();
    this.setPhase("review");
  }

  private hunkBlock(removed: string[], index: number, lineHeight: number): HTMLElement {
    const button = (label: string, command: string, cls: string) => {
      const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label);
      this.review.add(on(b, "mousedown", (e) => e.preventDefault()));
      this.review.add(on(b, "click", () => this.host.run(command, { index })));
      return b;
    };
    return h(
      "div",
      { class: "inline-edit-hunk", "data-index": String(index) },
      h(
        "div",
        { class: "inline-edit-hunk-bar" },
        button("Reject", "editor.inlineEdit.rejectHunk", "button-ghost"),
        button("Accept", "editor.inlineEdit.acceptHunk", "button-secondary"),
      ),
      removed.length
        ? h(
            "pre",
            { class: "inline-edit-removed", style: { lineHeight: `${lineHeight}px` } },
            removed.join("\n"),
          )
        : null,
    );
  }

  /** The index of hunk `index`, or the first pending one; -1 when none is left. */
  private pendingHunk(index?: number): number {
    const list = hunks(this.segments ?? []);
    if (index !== undefined) return list[index]?.state === "pending" ? index : -1;
    return list.findIndex((h) => h.state === "pending");
  }

  /** Keeps (`accept`) or undoes one hunk; when none is left, the edit closes. */
  resolveHunk(accept: boolean, index?: number): void {
    if (this.phase !== "review" || !this.segments) return;
    const at = this.pendingHunk(index);
    const hunk = hunks(this.segments)[at];
    if (!hunk) throw new Error("No change left to review there.");
    hunk.state = accept ? "accepted" : "rejected";
    const list = hunks(this.segments);
    if (list.every((h) => h.state === "rejected")) {
      this.reject();
      return;
    }
    if (!accept) this.apply();
    if (list.every((h) => h.state !== "pending")) {
      this.close();
      return;
    }
    this.showReview();
  }

  /** Closes the prompt if nothing was asked yet (Ctrl+K turned out to start a chord). */
  closeIfUntouched(): void {
    if (this.phase === "prompt" && !this.edits && !this.input.value.trim()) this.close();
  }

  /** Keeps the new text (every hunk not rejected). */
  accept(): void {
    if (this.phase === "working") return;
    this.close();
  }

  /** Restores the original text (or just closes the prompt). */
  reject(): void {
    if (this.phase === "working") {
      this.abort?.abort();
      // A follow-up was running: the earlier rewrite is still in the file and goes too.
      if (!this.edits) {
        this.close();
        return;
      }
    }
    const edits = this.edits;
    if (edits && this.host.versionId() === this.versionAfterEdits) {
      // Nothing else changed the file: undo our edits, so it is exactly as before (not dirty).
      this.close();
      void (async () => {
        for (let i = 0; i < edits; i++) await this.editor.runAction("undo");
      })();
      return;
    }
    if (this.editor.linesText(this.range) !== this.original) {
      this.applying = true;
      try {
        this.editor.replaceLines(this.range, this.original);
      } finally {
        this.applying = false;
      }
    }
    this.close();
  }

  private close(): void {
    if (this.done) return;
    this.done = true;
    this.abort?.abort();
    this.review.dispose();
    this.zone.dispose();
    this.store.dispose();
    this.host.setPhase(null);
    this.onClose();
    for (const listener of this.closedListeners.splice(0)) listener();
    this.editor.focus();
  }

  /** Runs `listener` once the edit has closed (accepted, rejected or dropped). */
  onClosed(listener: () => void): void {
    if (this.done) listener();
    else this.closedListeners.push(listener);
  }

  dispose(): void {
    this.close();
  }
}
