// The agent editor's face picker (D230): the face, big, with Shuffle beside it; a row of twelve
// candidate faces (shape and eyes, in the current color; a button shows others) and a row of the
// eight face colors (picking one keeps the shape). Each row is a radio group with one tab stop
// (arrows move and pick). Above them, Model icon or Character (D270): the model's logo instead of
// a face; Shuffle, the faces and the colors show only for Character (D286). Faces are drawn by
// ui/AgentFace.ts; what a pick writes is the caller's.

import { faceChoices } from "../../core/agent/agentTemplates";
import { characterFace, FACE_COLORS, type FaceSpec, randomFace } from "../../core/agent/faces";
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { agentFace } from "../../ui/AgentFace";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";

const CHOICES = 12;

/** A radio group with one tab stop: arrows, Home and End move and pick, as native radios do. */
export function rovingRadios(
  store: DisposableStore,
  group: HTMLElement,
  pick: (el: HTMLElement) => void,
): void {
  store.add(
    on(group, "click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[role=radio]");
      if (el && group.contains(el) && !el.hasAttribute("disabled")) pick(el);
    }),
  );
  store.add(
    on(group, "keydown", (e) => {
      const list = [...group.querySelectorAll<HTMLElement>("[role=radio]:not(:disabled)")];
      const i = list.indexOf(e.target as HTMLElement);
      if (i < 0) return;
      const step =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      let next: HTMLElement | undefined;
      if (step) next = list[(i + step + list.length) % list.length];
      else if (e.key === "Home") next = list[0];
      else if (e.key === "End") next = list[list.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      pick(next);
    }),
  );
}

/** Marks the checked radio and gives it the group's tab stop (the first enabled when none is). */
export function markRadios(
  group: HTMLElement | undefined,
  checked: (el: HTMLElement) => boolean,
): void {
  if (!group) return;
  const all = [...group.querySelectorAll<HTMLElement>("[role=radio]")];
  const picked = all.find((el) => checked(el));
  const stop = picked ?? all.find((el) => !el.hasAttribute("disabled"));
  for (const el of all) {
    el.setAttribute("aria-checked", String(el === picked));
    el.tabIndex = el === stop ? 0 : -1;
  }
}

export interface FacePickerDeps {
  face: FaceSpec;
  /** It shows its model's logo (D270). */
  model: boolean;
  /** The model whose logo it shows (null: the default model). */
  modelKey(): string | null;
  /** A face was picked (shuffled, chosen or recolored): Character. */
  onPick(face: FaceSpec): void;
  /** Model icon was picked. */
  onModel(): void;
}

export class FacePicker {
  private readonly store = new DisposableStore();
  private readonly big = h("div", { class: "ae-face-big" });
  private readonly faces = h("div", {
    class: "ae-faces",
    role: "radiogroup",
    "aria-label": "Face",
  });
  private readonly colors = h("div", {
    class: "ae-colors",
    role: "radiogroup",
    "aria-label": "Color",
  });
  private readonly kind = h("div", {
    class: "segmented ae-face-kind",
    role: "radiogroup",
    "aria-label": "Icon",
  });
  /** Shuffle, the faces and the colors: shown only for Character (D286). */
  private readonly characterParts: HTMLElement[] = [];
  private face: FaceSpec;
  private model: boolean;
  /** The model whose logo the big face shows (undefined: it shows a face). */
  private shownModel: string | null | undefined;
  private choices: FaceSpec[];

  constructor(
    host: HTMLElement,
    private readonly deps: FacePickerDeps,
  ) {
    this.face = characterFace(deps.face);
    this.model = deps.model;
    this.choices = faceChoices(CHOICES, this.face);
    for (const [kind, label, tip] of [
      ["model", "Model icon", "Show the logo of the model it uses"],
      ["face", "Character", "Show a character face"],
    ] as const) {
      const b = h(
        "button",
        { class: "segment", type: "button", role: "radio", "data-kind": kind },
        label,
      );
      setTooltip(b, tip);
      this.kind.append(b);
    }
    rovingRadios(this.store, this.kind, (el) => {
      if (el.dataset.kind === "model") {
        if (this.model) return;
        this.model = true;
        this.update();
        this.deps.onModel();
      } else if (this.model) this.pick(this.face);
    });
    const shuffle = h(
      "button",
      { class: "button button-secondary button-sm ae-shuffle", type: "button" },
      icon("sparkles"),
      "Shuffle",
    );
    setTooltip(shuffle, "Another face");
    this.store.add(on(shuffle, "click", () => this.pick(randomFace(this.face), true)));
    const others = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "Show other faces" },
      icon("refresh-cw"),
    );
    setTooltip(others, "Show other faces");
    this.store.add(
      on(others, "click", () => {
        this.choices = faceChoices(CHOICES);
        this.drawChoices();
      }),
    );
    for (let c = 1; c <= FACE_COLORS; c++)
      this.colors.append(
        h("button", {
          class: "ae-swatch",
          type: "button",
          role: "radio",
          "data-color": String(c),
          "aria-label": `Color ${c}`,
          style: { "--swatch": `var(--face-${c})` },
        }),
      );
    rovingRadios(this.store, this.faces, (el) => {
      const choice = this.choices[Number(el.dataset.index)];
      if (choice) this.pick({ ...choice, color: this.face.color });
    });
    rovingRadios(this.store, this.colors, (el) =>
      this.pick({ ...this.face, color: Number(el.dataset.color) || 1 }),
    );
    const row = h("div", { class: "ae-face-row" }, this.faces, others);
    this.characterParts.push(shuffle, row, this.colors);
    host.append(
      h(
        "section",
        { class: "ae-face", "aria-label": "Face" },
        this.kind,
        h("div", { class: "ae-face-top" }, this.big, shuffle),
        row,
        this.colors,
      ),
    );
    this.drawChoices();
  }

  /**
   * Shows `face` (from a template or the file) or, with `model`, the model's logo; fresh choices
   * when the face isn't among them.
   */
  set(face: FaceSpec, model = this.model): void {
    const listed = this.choices.some((c) => c.shape === face.shape && c.eyes === face.eyes);
    const recolor = face.color !== this.face.color;
    this.face = characterFace(face);
    this.model = model;
    if (!listed) this.choices = faceChoices(CHOICES, face);
    if (!listed || recolor) this.drawChoices();
    else this.update();
  }

  private pick(face: FaceSpec, reshuffled = false): void {
    if (reshuffled) this.choices = faceChoices(CHOICES, face);
    this.set(face, false);
    this.deps.onPick(face);
  }

  private drawChoices(): void {
    const focused = this.faces.contains(document.activeElement);
    replaceChildren(
      this.faces,
      ...this.choices.map((f, i) =>
        h(
          "button",
          {
            class: "ae-face-pick",
            type: "button",
            role: "radio",
            "data-index": String(i),
            "aria-label": `Face ${i + 1}`,
          },
          agentFace({ ...f, color: this.face.color }, { size: 28 }),
        ),
      ),
    );
    this.update();
    if (focused) this.faces.querySelector<HTMLElement>("[tabindex='0']")?.focus();
  }

  /** The model's logo again, when the agent's model changed. */
  refreshModel(): void {
    if (this.model && this.deps.modelKey() !== this.shownModel) this.update();
  }

  private update(): void {
    const face = this.face;
    const model = this.model;
    this.shownModel = model ? this.deps.modelKey() : undefined;
    replaceChildren(
      this.big,
      agentFace(model ? { ...face, model: this.deps.modelKey() ?? "" } : face, {
        size: 88,
        label: model ? "The agent's model's logo" : "The agent's face",
      }),
    );
    const kind = model ? "model" : "face";
    // The model's logo has nothing to pick: Shuffle, the faces and the colors are Character's.
    for (const el of this.characterParts) el.hidden = model;
    for (const b of this.kind.querySelectorAll<HTMLElement>(".segment"))
      b.classList.toggle("is-selected", b.dataset.kind === kind);
    markRadios(this.kind, (el) => el.dataset.kind === kind);
    // With the model's logo no face or color is picked: picking one goes back to Character.
    markRadios(this.faces, (el) => {
      const f = this.choices[Number(el.dataset.index)];
      return !model && !!f && f.shape === face.shape && f.eyes === face.eyes;
    });
    markRadios(this.colors, (el) => !model && Number(el.dataset.color) === face.color);
  }

  dispose(): void {
    this.store.dispose();
  }
}
