// The merge editor (D204, VS Code's): a conflicted file as three panes — Incoming (theirs, git's
// index stage 3), Current (ours, stage 2) and the Result below — with the common base (stage 1)
// as an optional fourth. Each conflict has Accept incoming / Accept current / Accept both /
// Ignore above it; the result is the file's own document (edit it freely, it's saved like the
// file), and Complete merge saves it and stages it. The three-way model is core/diff/merge.ts.
// The stage texts come from the git extension's `gitStage:<n>` content source. D209: a sash
// between the inputs and the result, the panes' sizes kept per tab (mergeLayout.ts), word
// highlights in the result too, and a file one side deleted and the other changed resolved here
// (keep it or delete it, mergeDeleted.ts). D219: word highlights in the base too, a file both
// sides added (no base) split into conflicts where they differ, and each file's last sizes kept
// for its next tab. Its dock view type, commands and state are in mergeCommands.ts.

import { type MergeChoice, MergeModel, type MergePane } from "../../core/diff/merge";
import { wordChanges } from "../../core/diff/words";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { type IconName, icon } from "../../ui/Icon";
import { Sash } from "../../ui/Sash";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { findConflicts } from "./conflicts";
import type { EditorZone, EngineDocument, EngineEditor, HighlightRange } from "./engine";
import { type DeletedSide, deletedPanel } from "./mergeDeleted";
import {
  hasSavedLayout,
  type MergeLayoutMemory,
  readMergeLayout,
  saveMergeLayout,
  splitAfterDrag,
} from "./mergeLayout";
import type { EditorDocument, EditorService } from "./service";

export const VIEW_TYPE = "mergeEditor";
export type InputPane = "incoming" | "base" | "current";
/** The narrowest an input pane gets when a sash is dragged. */
const MIN_PANE_WIDTH = 120;

interface Pane {
  kind: MergePane;
  element: HTMLElement;
  title: HTMLElement;
  host: HTMLElement;
  editor?: EngineEditor;
  doc?: EngineDocument;
  marks: Disposable[];
  /** Zones by a key of where and what they show (kept while unchanged: no flicker). */
  zones: Map<string, EditorZone>;
  /** Its word-level highlights were set (an input's text doesn't change). */
  wordsSet?: boolean;
}

/** Each file's last merge layout (D219), and a callback to save it with the folder's state. */
export interface LayoutStore {
  memory: MergeLayoutMemory;
  changed(): void;
}

export function readPath(state: Json): string {
  const p = (state as { path?: unknown } | null)?.path;
  return typeof p === "string" ? p : "";
}

/** "2 of 5 conflicts left", "All 3 conflicts handled", "No conflicts". */
export function conflictCountLabel(unhandled: number, total: number): string {
  if (total === 0) return "No conflicts";
  if (unhandled === 0)
    return total === 1 ? "The conflict is handled" : `All ${total} conflicts handled`;
  return `${unhandled} of ${total} conflict${total === 1 ? "" : "s"} left`;
}

const CHOICE_LABELS: Record<string, string> = {
  current: "Current accepted",
  incoming: "Incoming accepted",
  both: "Both accepted",
  bothIncomingFirst: "Both accepted (incoming first)",
  base: "Ignored (base kept)",
  edited: "Edited by hand",
};

export class MergeView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  readonly path: string;
  private model: MergeModel | null = null;
  private doc: EditorDocument | undefined;
  private readonly panes: Record<MergePane, Pane>;
  private readonly count: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly baseToggle: HTMLButtonElement;
  private showBase = false;
  private visible = false;
  /** The result's text as the model last set or saw it (our own edits aren't re-diffed). */
  private resultText = "";
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollLeader: { pane: MergePane; until: number } | null = null;
  private labels = { current: "", incoming: "" };
  /** The input panes' shares of the width (flex-grow), changed by the sashes between them. */
  private readonly weights: Record<InputPane, number>;
  /** The inputs' share of the height (the sash above the result, D209). */
  private split: number;
  private readonly inputsElement: HTMLElement;
  /** One side deleted the file, the other changed it (D209): which one deleted it. */
  deleted: DeletedSide | null = null;
  /** Both sides added the file: there's no base (D219). */
  private bothAdded = false;
  /** The sash before the base pane (hidden with it) and the one before the current pane. */
  private readonly sashes: Sash[] = [];
  /** Resolves once the panes are filled (commands wait for it). */
  readonly ready: Promise<void>;

  constructor(
    state: Json,
    private readonly ctx: DockViewContext,
    private readonly services: WorkbenchServices,
    private readonly editors: EditorService,
    registry: Map<string, MergeView>,
    private readonly layouts: LayoutStore,
  ) {
    this.path = readPath(state);
    this.showBase = (state as { base?: unknown } | null)?.base === true;
    // Each merge tab keeps its panes' sizes (D209); a new tab has the file's last ones (D219).
    const layout = hasSavedLayout(state)
      ? readMergeLayout(state)
      : layouts.memory.recall(this.path);
    this.weights = layout.weights;
    this.split = layout.split;
    const button = (name: IconName, title: string, run: () => void) => {
      const b = h(
        "button",
        { class: "icon-button", type: "button", "aria-label": title },
        icon(name),
      );
      setTooltip(b, title);
      this.store.add(on(b, "click", run));
      return b;
    };
    this.count = h("span", { class: "diff-count merge-count", role: "status" });
    this.baseToggle = h(
      "button",
      { class: "button button-ghost button-sm", type: "button", "aria-pressed": "false" },
      "Show base",
    );
    setTooltip(this.baseToggle, "Show the common ancestor both sides changed (git's stage 1)");
    this.store.add(on(this.baseToggle, "click", () => this.run("git.mergeEditor.toggleBase", {})));
    const complete = h(
      "button",
      { class: "button button-primary button-sm merge-complete", type: "button" },
      "Complete merge",
    );
    setTooltip(complete, "Save the result and stage it (git add)");
    this.store.add(on(complete, "click", () => this.run("git.completeMerge", { path: this.path })));
    const toolbar = h(
      "div",
      { class: "diff-toolbar merge-toolbar" },
      h("span", { class: "diff-label" }, `Merging ${basename(this.path)}`),
      this.count,
      h("span", { class: "diff-spacer" }),
      button("arrow-up", "Previous conflict", () =>
        this.run("git.mergeEditor.previousConflict", { path: this.path }),
      ),
      button("arrow-down", "Next conflict", () =>
        this.run("git.mergeEditor.nextConflict", { path: this.path }),
      ),
      button("rotate-ccw", "Reset the result", () =>
        this.run("git.mergeEditor.reset", { path: this.path }),
      ),
      this.baseToggle,
      complete,
    );
    /** "Accept all" in an input pane's header (VS Code's "Accept all changes from left / right"). */
    const acceptAll = (side: "incoming" | "current") => {
      const b = h(
        "button",
        { class: "merge-action merge-accept-all", type: "button", "data-accept-all": side },
        "Accept all",
      );
      setTooltip(b, `Accept all ${side}: put this side of every conflict in the result`);
      this.store.add(
        on(b, "click", () =>
          this.run("git.mergeEditor.acceptAll", { path: this.path, choice: side }),
        ),
      );
      return b;
    };
    const pane = (kind: MergePane, label: string): Pane => {
      const title = h("span", { class: "merge-pane-title" }, label);
      const host = h("div", { class: "merge-pane-engine" });
      const element = h(
        "div",
        { class: `merge-pane merge-pane-${kind}`, "data-pane": kind },
        h(
          "div",
          { class: "merge-pane-header" },
          title,
          ...(kind === "incoming" || kind === "current" ? [acceptAll(kind)] : []),
        ),
        host,
      );
      return { kind, element, title, host, marks: [], zones: new Map() };
    };
    this.panes = {
      incoming: pane("incoming", "Incoming"),
      current: pane("current", "Current"),
      base: pane("base", "Base"),
      result: pane("result", "Result"),
    };
    this.notice = h("div", { class: "merge-notice", hidden: true });
    const inputs = h(
      "div",
      { class: "merge-inputs" },
      this.panes.incoming.element,
      this.panes.base.element,
      this.panes.current.element,
    );
    this.inputsElement = inputs;
    this.sashes.push(this.inputSash(inputs, "base"), this.inputSash(inputs, "current"));
    this.element = h(
      "div",
      { class: "editor-view merge-view", tabindex: "-1" },
      toolbar,
      this.notice,
      inputs,
      this.panes.result.element,
    );
    this.resultSash();
    this.applyWeights();
    this.applyBase();
    registry.set(this.path, this);
    this.store.add({
      dispose: () => registry.get(this.path) === this && registry.delete(this.path),
    });
    this.store.add({ dispose: () => clearTimeout(this.renderTimer) });
    this.ready = this.init().catch((err) => {
      this.showNotice(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * A draggable sash before input pane `next`: it moves the border between `next` and the
   * nearest shown pane before it (incoming, or base when shown). Double-click: equal widths.
   */
  private inputSash(host: HTMLElement, next: "base" | "current"): Sash {
    let start: { before: InputPane; a: number; b: number; wa: number; wb: number } | null = null;
    const sash = this.store.add(
      new Sash(host, {
        orientation: "vertical",
        onStart: () => {
          const before: InputPane = next === "current" && this.showBase ? "base" : "incoming";
          start = {
            before,
            a: this.panes[before].element.getBoundingClientRect().width,
            b: this.panes[next].element.getBoundingClientRect().width,
            wa: this.weights[before],
            wb: this.weights[next],
          };
        },
        onDrag: (delta) => {
          if (!start) return;
          const total = start.a + start.b;
          if (total <= 0) return;
          const min = Math.min(MIN_PANE_WIDTH, total / 2);
          const width = Math.max(min, Math.min(total - min, start.a + delta));
          const sum = start.wa + start.wb;
          this.weights[start.before] = (sum * width) / total;
          this.weights[next] = sum - this.weights[start.before];
          this.applyWeights();
        },
        onEnd: () => {
          start = null;
          this.saveLayout();
        },
        onReset: () => {
          this.weights.incoming = this.weights.base = this.weights.current = 1;
          this.applyWeights();
          this.saveLayout();
        },
      }),
    );
    sash.element.classList.add("merge-sash");
    sash.element.setAttribute("aria-label", "Resize the panes");
    host.insertBefore(sash.element, this.panes[next].element);
    return sash;
  }

  /** The sash between the inputs and the result (D209, VS Code's): drag for more of either. */
  private resultSash(): void {
    let start: { inputs: number; result: number } | null = null;
    const sash = this.store.add(
      new Sash(this.element, {
        orientation: "horizontal",
        onStart: () => {
          start = {
            inputs: this.inputsElement.getBoundingClientRect().height,
            result: this.panes.result.element.getBoundingClientRect().height,
          };
        },
        onDrag: (delta) => {
          if (!start) return;
          this.split = splitAfterDrag(start.inputs, start.result, delta);
          this.applyWeights();
        },
        onEnd: () => {
          start = null;
          this.saveLayout();
        },
        onReset: () => {
          this.split = 0.5;
          this.applyWeights();
          this.saveLayout();
        },
      }),
    );
    sash.element.classList.add("merge-result-sash");
    sash.element.setAttribute("aria-label", "Resize the inputs and the result");
    this.element.insertBefore(sash.element, this.panes.result.element);
  }

  private applyWeights(): void {
    for (const kind of ["incoming", "base", "current"] as const)
      this.panes[kind].element.style.flexGrow = String(this.weights[kind]);
    this.inputsElement.style.flex = `${this.split} 1 0`;
    this.panes.result.element.style.flex = `${1 - this.split} 1 0`;
    if (this.visible) this.layout();
  }

  /** Keeps the sizes with the tab and as the file's last ones (D219). */
  private saveLayout(): void {
    this.ctx.updateState(this.serialize());
    this.layouts.memory.remember(this.path, { weights: { ...this.weights }, split: this.split });
    this.layouts.changed();
  }

  /** The inputs' share of the height, 0..1 (ide://git/mergeEditors). */
  get inputsShare(): number {
    return Math.round(this.split * 100) / 100;
  }

  /** Sets the panes' sizes as the sashes do (git.mergeEditor.setLayout), kept with the tab. */
  setLayout(layout: { split?: number; weights?: Partial<Record<InputPane, number>> }): void {
    const next = readMergeLayout({
      split: layout.split ?? this.split,
      weights: { ...this.weights, ...layout.weights },
    });
    this.split = next.split;
    Object.assign(this.weights, next.weights);
    this.applyWeights();
    this.saveLayout();
  }

  /** The input panes' shares of the width, 0..1 (the base's only when shown). */
  inputShares(): Record<string, number> {
    const shown = (["incoming", "base", "current"] as const).filter(
      (k) => k !== "base" || this.showBase,
    );
    const sum = shown.reduce((n, k) => n + this.weights[k], 0) || 1;
    return Object.fromEntries(
      shown.map((k) => [k, Math.round((this.weights[k] / sum) * 100) / 100]),
    );
  }

  private async init(): Promise<void> {
    const qd = this.services.quickDiff;
    const [base, current, incoming] = await Promise.all([
      qd.content("gitStage:1", this.path),
      qd.content("gitStage:2", this.path),
      qd.content("gitStage:3", this.path),
    ]);
    if (this.store.isDisposed) return;
    if (current === null && incoming === null)
      throw new Error(
        "This file isn't in conflict as two edited versions: resolve it in Source control.",
      );
    const engine = await this.editors.ensureEngine();
    if (this.store.isDisposed) return;
    // Deleted on one side, changed on the other (D209): keep it or delete it, here.
    if (current === null || incoming === null) {
      this.showDeleted(
        engine,
        current === null ? "current" : "incoming",
        current ?? incoming ?? "",
      );
      return;
    }
    if (this.store.isDisposed) return;
    const doc = this.editors.find(this.path) ?? (await this.editors.load(this.path));
    if (this.store.isDisposed) return;
    this.doc = doc;
    this.editors.retain(doc);
    this.store.add({ dispose: () => this.editors.release(doc) });
    const result = doc.model.peek();
    if (!result) throw new Error("The file can't be edited here (binary or not loaded).");
    const strip = (t: string) => t.replace(/^﻿/, "");
    const model = new MergeModel(strip(base ?? ""), strip(current), strip(incoming));
    this.model = model;
    // Both sides added the file (git's add / add, no stage 1): no base, the conflicts are where
    // the two differ (D219).
    this.bothAdded = base === null;
    if (this.bothAdded)
      this.panes.base.title.textContent = "Base · none (both sides added the file)";
    const fileText = result.getText();
    const markers = findConflicts(fileText);
    this.labels = {
      current: markers[0]?.currentLabel ?? "",
      incoming: markers[0]?.incomingLabel ?? "",
    };
    // Git's file with markers: start from the computed result (VS Code does too). A file
    // already resolved by hand is kept and read against the model.
    if (markers.length) {
      this.resultText = model.text();
      result.replaceText(this.resultText);
    } else {
      model.setResultText(fileText);
      this.resultText = fileText;
      if (model.conflictCount)
        this.showNotice(
          "The file has no conflict markers left: it's shown as it is. Reset the result to start over from both sides.",
        );
    }
    const make = (pane: Pane, text: string | null, scheme: string) => {
      const editor = this.store.add(engine.createEditor(pane.host));
      pane.editor = editor;
      if (text !== null) {
        const d = engine.createDocument(this.path, strip(text), { readOnly: true, scheme });
        this.store.add(d);
        pane.doc = d;
        editor.setDocument(d);
      }
      this.store.add(editor.onDidChangeCursor(() => this.syncScroll(pane.kind)));
    };
    make(this.panes.incoming, incoming, "merge-incoming");
    make(this.panes.current, current, "merge-current");
    make(this.panes.base, base ?? "", "merge-base");
    make(this.panes.result, null, "file");
    this.panes.result.editor?.setDocument(result);
    this.store.add(
      result.onDidChangeContent(() => {
        const text = result.getText();
        if (text === this.resultText) return;
        this.resultText = text;
        model.setResultText(text);
        this.scheduleRender();
      }),
    );
    this.render();
    if (this.visible) this.layout();
    // Start at the first conflict.
    const first = model.nextConflict(-1, "next", true);
    if (first !== null) this.reveal(first);
  }

  /** A delete / modify conflict: the side that changed it, and Keep / Delete (mergeDeleted.ts). */
  private showDeleted(
    engine: Awaited<ReturnType<EditorService["ensureEngine"]>>,
    by: "current" | "incoming",
    kept: string,
  ): void {
    this.deleted = { by, kept: kept.replace(/^﻿/, "") };
    const keptPane = this.panes[by === "current" ? "incoming" : "current"];
    const gonePane = this.panes[by];
    const editor = this.store.add(engine.createEditor(keptPane.host));
    const doc = this.store.add(
      engine.createDocument(this.path, this.deleted.kept, {
        readOnly: true,
        scheme: `merge-${keptPane.kind}`,
      }),
    );
    keptPane.editor = editor;
    keptPane.doc = doc;
    editor.setDocument(doc);
    gonePane.host.replaceChildren(
      h(
        "div",
        { class: "merge-deleted-pane" },
        `${by === "current" ? "Current (your side)" : "Incoming (their side)"} deleted this file.`,
      ),
    );
    // Nothing to accept, step through or complete: Keep / Delete below decide.
    for (const b of this.element.querySelectorAll<HTMLElement>(
      ".merge-accept-all, .merge-toolbar button",
    ))
      b.hidden = true;
    this.panes.result.element.replaceWith(
      deletedPanel(this.deleted, basename(this.path), (choice) =>
        this.run("git.mergeEditor.resolveDeleted", { path: this.path, choice }),
      ),
    );
    this.element.querySelector(".merge-result-sash")?.remove();
    this.count.textContent = "Deleted on one side, changed on the other";
    this.panes.incoming.title.textContent = "Incoming";
    this.panes.current.title.textContent = "Current";
    if (this.visible) this.layout();
    this.changed.fire();
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
  }

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 120);
  }

  /** Decorations, the action zones and the count, from the model. */
  private render(): void {
    const model = this.model;
    if (!model || this.store.isDisposed) return;
    const lh = this.panes.result.editor?.lineHeight() ?? 19;
    for (const kind of ["incoming", "current", "base"] as const) {
      const pane = this.panes[kind];
      const editor = pane.editor;
      if (!editor) continue;
      for (const m of pane.marks) m.dispose();
      pane.marks = [];
      const wanted = new Map<string, () => HTMLElement>();
      /** The words each side changed inside its changed lines (D207, VS Code's inner diff). */
      const words: HighlightRange[] = [];
      for (const c of model.changes) {
        const span = c[kind];
        const st = model.stateOf(c.id);
        const taken =
          kind !== "base" &&
          (st.choice === kind || st.choice === "both" || st.choice === "bothIncomingFirst");
        const cls = c.conflict
          ? `merge-${kind}${taken ? " is-taken" : ""} is-conflict`
          : `merge-${kind}${taken ? " is-taken" : ""}`;
        if (span.end > span.start)
          pane.marks.push(
            editor.decorateLines({ startLine: span.start + 1, endLine: span.end }, cls),
          );
        if (kind !== "base")
          for (const w of wordChanges(
            model.base.slice(c.base.start, c.base.end),
            model[kind].slice(span.start, span.end),
          ))
            words.push({
              startLine: span.start + w.line + 1,
              startColumn: w.start + 1,
              endLine: span.start + w.line + 1,
              endColumn: w.end + 1,
              className: `merge-word-${kind}`,
            });
        // The base (D219, VS Code's): the words each side changed there, in that side's color.
        else
          for (const side of ["incoming", "current"] as const)
            for (const w of wordChanges(
              model[side].slice(c[side].start, c[side].end),
              model.base.slice(span.start, span.end),
            ))
              words.push({
                startLine: span.start + w.line + 1,
                startColumn: w.start + 1,
                endLine: span.start + w.line + 1,
                endColumn: w.end + 1,
                className: `merge-word-${side} merge-word-in-base`,
              });
        if (kind === "base" || !c.conflict) continue;
        const actions = this.inputActions(kind, c.id, st.choice);
        wanted.set(`${span.start}|${c.id}|${st.choice}|${st.handled}`, () => actions);
      }
      // The input texts never change: their word highlights are set once.
      if (!pane.wordsSet) {
        pane.wordsSet = true;
        editor.highlightRanges?.("merge-words", words);
      }
      this.syncZones(pane, wanted, lh);
    }
    const resultPane = this.panes.result;
    if (resultPane.editor) {
      for (const m of resultPane.marks) m.dispose();
      resultPane.marks = [];
      const wanted = new Map<string, () => HTMLElement>();
      /** The words the result changed from the base (D209), colored by the side they came from. */
      const words: HighlightRange[] = [];
      for (const c of model.changes) {
        const span = model.resultSpan(c.id);
        const st = model.stateOf(c.id);
        const side =
          st.choice === "current" || st.choice === "incoming" ? st.choice : ("result" as const);
        for (const w of wordChanges(
          model.base.slice(c.base.start, c.base.end),
          model.resultLinesOf(c.id),
        ))
          words.push({
            startLine: span.start + w.line + 1,
            startColumn: w.start + 1,
            endLine: span.start + w.line + 1,
            endColumn: w.end + 1,
            className: `merge-word-${side}`,
          });
        const cls = c.conflict
          ? st.handled
            ? "merge-result is-conflict is-handled"
            : "merge-result is-conflict is-unhandled"
          : "merge-result";
        if (span.end > span.start)
          resultPane.marks.push(
            resultPane.editor.decorateLines({ startLine: span.start + 1, endLine: span.end }, cls),
          );
        if (!c.conflict) continue;
        wanted.set(`${span.start}|${c.id}|${st.choice}|${st.handled}`, () =>
          this.resultActions(c.id, st.choice, st.handled),
        );
      }
      resultPane.editor.highlightRanges?.("merge-words", words);
      this.syncZones(resultPane, wanted, lh);
    }
    const left = model.unhandledCount;
    this.count.textContent = conflictCountLabel(left, model.conflictCount);
    this.count.classList.toggle("is-done", left === 0);
    const side = (label: string, name: string) => (label ? `${name} · ${label}` : name);
    this.panes.incoming.title.textContent = side(this.labels.incoming, "Incoming");
    this.panes.current.title.textContent = side(this.labels.current, "Current");
    this.panes.result.title.textContent = `Result · ${basename(this.path)}`;
    this.changed.fire();
  }

  private syncZones(pane: Pane, wanted: Map<string, () => HTMLElement>, lineHeight: number): void {
    const editor = pane.editor;
    if (!editor) return;
    for (const [key, zone] of pane.zones)
      if (!wanted.has(key)) {
        zone.dispose();
        pane.zones.delete(key);
      }
    for (const [key, make] of wanted) {
      if (pane.zones.has(key)) continue;
      const afterLine = Number(key.split("|")[0]);
      pane.zones.set(key, editor.addZone(afterLine, make(), lineHeight + 2));
    }
  }

  private action(label: string, title: string, run: () => void): HTMLElement {
    const b = h("button", { class: "merge-action", type: "button" }, label);
    setTooltip(b, title);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    return b;
  }

  /** "Accept incoming | Accept both | Ignore" above a conflict in an input pane. */
  private inputActions(
    kind: "incoming" | "current",
    id: number,
    choice: string | null,
  ): HTMLElement {
    const conflict = id + 1;
    const accept = (c: MergeChoice) => () =>
      this.run("git.mergeEditor.accept", { path: this.path, conflict, choice: c });
    const name = kind === "incoming" ? "incoming" : "current";
    const taken = choice === kind || choice === "both" || choice === "bothIncomingFirst";
    return h(
      "div",
      { class: "merge-actions" },
      taken
        ? h("span", { class: "merge-action-state" }, "In the result")
        : // Short labels: the input panes are narrow (the tooltip says the rest).
          this.action(
            "Accept",
            `Accept ${name}: put this side of conflict ${conflict} in the result`,
            accept(kind),
          ),
      this.action(
        "Both",
        kind === "incoming" ? "Accept both, incoming first" : "Accept both, current first",
        accept(kind === "incoming" ? "bothIncomingFirst" : "both"),
      ),
      this.action("Ignore", "Keep the base text and mark the conflict handled", accept("base")),
    );
  }

  private resultActions(id: number, choice: string | null, handled: boolean): HTMLElement {
    const conflict = id + 1;
    const accept = (c: MergeChoice) => () =>
      this.run("git.mergeEditor.accept", { path: this.path, conflict, choice: c });
    if (handled)
      return h(
        "div",
        { class: "merge-actions" },
        h("span", { class: "merge-action-state" }, CHOICE_LABELS[choice ?? ""] ?? "Handled"),
        this.action("Reset", "Back to the unhandled conflict (base text)", () =>
          this.run("git.mergeEditor.accept", { path: this.path, conflict, choice: "reset" }),
        ),
      );
    return h(
      "div",
      { class: "merge-actions is-unhandled" },
      h("span", { class: "merge-action-state" }, `Conflict ${conflict}`),
      this.action("Accept incoming", "Their side", accept("incoming")),
      this.action("Accept current", "Your side", accept("current")),
      this.action("Accept both", "Current then incoming", accept("both")),
      this.action("Ignore", "Keep the base text and mark it handled", accept("base")),
    );
  }

  /** Keeps the panes' scroll positions in step (the pane the user scrolls leads). */
  private syncScroll(from: MergePane): void {
    const model = this.model;
    const source = this.panes[from].editor;
    if (!model || !source) return;
    const now = Date.now();
    if (this.scrollLeader && this.scrollLeader.pane !== from && now < this.scrollLeader.until)
      return;
    this.scrollLeader = { pane: from, until: now + 200 };
    const top = source.scrollLine();
    const line = Math.floor(top);
    const frac = top - line;
    for (const kind of ["incoming", "current", "base", "result"] as const) {
      if (kind === from || (kind === "base" && !this.showBase)) continue;
      const target = model.mapLine(from, kind, line);
      this.panes[kind].editor?.scrollToLine(target + frac);
    }
  }

  // ---- What the commands do ----

  private requireModel(): MergeModel {
    if (!this.model) throw new Error("The merge editor is still loading.");
    return this.model;
  }

  /** The conflict at (or after) the result's cursor. */
  conflictAtCursor(): number | null {
    const model = this.model;
    if (!model) return null;
    const line = (this.panes.result.editor?.activeState()?.cursor.line ?? 1) - 1;
    const here = model.changes.find((c) => {
      if (!c.conflict) return false;
      const span = model.resultSpan(c.id);
      return line >= span.start && line < Math.max(span.end, span.start + 1);
    });
    return here?.id ?? model.nextConflict(line, "next", true);
  }

  accept(id: number, choice: MergeChoice | "reset"): void {
    const model = this.requireModel();
    const change = model.changes[id];
    if (!change) throw new Error(`There is no conflict ${id + 1}.`);
    if (choice === "reset") model.resetChange(id);
    else model.accept(id, choice);
    this.applyResult();
  }

  acceptAll(choice: "current" | "incoming"): number {
    const model = this.requireModel();
    let n = 0;
    for (const c of model.changes)
      if (c.conflict) {
        model.accept(c.id, choice);
        n++;
      }
    this.applyResult();
    return n;
  }

  reset(): void {
    this.requireModel().reset();
    this.applyResult();
    this.notice.hidden = true;
  }

  /** Writes the model's result into the document (one undoable edit). */
  private applyResult(): void {
    const model = this.requireModel();
    const doc = this.doc?.model.peek();
    this.resultText = model.text();
    doc?.replaceText(this.resultText);
    this.render();
  }

  go(direction: "next" | "previous"): number | null {
    const model = this.requireModel();
    const line = (this.panes.result.editor?.activeState()?.cursor.line ?? 0) - 1;
    const id = model.nextConflict(line, direction);
    if (id !== null) this.reveal(id);
    return id;
  }

  private reveal(id: number): void {
    const model = this.model;
    if (!model) return;
    const change = model.changes[id];
    if (!change) return;
    const span = model.resultSpan(id);
    this.panes.result.editor?.revealPosition(span.start + 1, 1);
    this.panes.incoming.editor?.revealPosition(change.incoming.start + 1, 1);
    this.panes.current.editor?.revealPosition(change.current.start + 1, 1);
    this.panes.base.editor?.revealPosition(change.base.start + 1, 1);
  }

  toggleBase(value?: boolean): boolean {
    this.showBase = value ?? !this.showBase;
    this.applyBase();
    this.ctx.updateState(this.serialize());
    return this.showBase;
  }

  private applyBase(): void {
    this.panes.base.element.hidden = !this.showBase;
    const baseSash = this.sashes[0];
    if (baseSash) baseSash.element.hidden = !this.showBase;
    this.baseToggle.textContent = this.showBase ? "Hide base" : "Show base";
    this.baseToggle.setAttribute("aria-pressed", String(this.showBase));
    if (this.visible) queueMicrotask(() => this.layout());
  }

  /** Saves the result; the caller stages it. */
  async saveResult(): Promise<void> {
    const doc = this.doc;
    if (!doc) throw new Error("The merge editor is still loading.");
    await this.editors.save(doc);
  }

  summary(): {
    path: string;
    conflicts: number;
    unhandled: number;
    changes: {
      conflict: number;
      handled: boolean;
      choice: string | null;
      resultLines: [number, number];
    }[];
    showBase: boolean;
    inputShares: Record<string, number>;
    inputsShare: number;
    deleted: { by: "current" | "incoming" } | null;
    bothAdded: boolean;
  } {
    const model = this.model;
    const conflicts = model?.changes.filter((c) => c.conflict) ?? [];
    return {
      path: this.path,
      conflicts: conflicts.length,
      unhandled: model?.unhandledCount ?? 0,
      changes: conflicts.map((c) => {
        const st = model?.stateOf(c.id);
        const span = model?.resultSpan(c.id) ?? { start: 0, end: 0 };
        return {
          conflict: c.id + 1,
          handled: st?.handled ?? false,
          choice: st?.choice ?? null,
          resultLines: [span.start + 1, span.end],
        };
      }),
      showBase: this.showBase,
      inputShares: this.inputShares(),
      inputsShare: this.inputsShare,
      deleted: this.deleted ? { by: this.deleted.by } : null,
      bothAdded: this.bothAdded,
    };
  }

  close(): void {
    this.ctx.close();
  }

  private layout(): void {
    for (const pane of Object.values(this.panes)) if (!pane.element.hidden) pane.editor?.layout();
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch((err) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  }

  title(): string {
    return `${basename(this.path)} (merge)`;
  }
  isDirty(): boolean {
    return this.doc?.dirty.peek() ?? false;
  }
  async confirmClose(): Promise<boolean> {
    const doc = this.doc;
    if (!doc || doc.refs > 1) return true;
    return this.editors.confirmDiscard(doc);
  }
  onShow(): void {
    this.visible = true;
    this.layout();
  }
  onHide(): void {
    this.visible = false;
  }
  onResize(): void {
    if (this.visible) this.layout();
  }
  focus(): void {
    if (this.panes.result.editor) this.panes.result.editor.focus();
    else this.element.focus();
  }
  serialize(): Json {
    return {
      path: this.path,
      ...(this.showBase && { base: true }),
      ...saveMergeLayout({ weights: this.weights, split: this.split }),
    };
  }
  dispose(): void {
    for (const pane of Object.values(this.panes)) {
      for (const m of pane.marks) m.dispose();
      for (const z of pane.zones.values()) z.dispose();
      pane.zones.clear();
    }
    this.store.dispose();
  }
}
