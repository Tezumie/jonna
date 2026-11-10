// An agent's face (D230, core/agent/faces.ts) as an element: the generated SVG in a box with its
// state — working (it looks around and breathes, a ring turns), needs you (a dot), failed (it
// droops) — and, for a group of agents, two or three faces overlapping. Purely visual: what it
// opens or runs is up to the caller's button. A face whose spec has a `model` shows that model's
// logo instead (D270), found by the resolver the agent extension sets; it's redrawn in place when
// the models change (refreshModelFaces).
import type { FaceSpec } from "../core/agent/faces";
import { encodeFace, faceSvg, parseFace } from "../core/agent/faces";
import { h } from "../core/dom/index";

export type FaceState = "idle" | "working" | "waiting" | "failed";

export interface FaceOptions {
  /** Pixels (the box; the face fills it). Default 24. */
  size?: number;
  state?: FaceState;
  /** Read by screen readers (the face itself is decoration). */
  label?: string;
}

/** A model's logo for a face (`model`: its key, "" for the default model); null: none known. */
export type ModelFaceResolver = (model: string) => HTMLElement | null;

let resolveModelFace: ModelFaceResolver = () => null;

/** How a model's logo is found (set by the agent extension, which knows the providers). */
export function setModelFaceResolver(resolver: ModelFaceResolver): void {
  resolveModelFace = resolver;
}

/** A face element: `<span class="agent-face" data-state=…>` holding the SVG (or a model's logo). */
export function agentFace(face: FaceSpec, options: FaceOptions = {}): HTMLElement {
  const size = options.size ?? 24;
  const el = h("span", {
    class: "agent-face",
    style: { "--face-size": `${size}px` },
    ...(options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" }),
  });
  drawFace(el, face, size);
  setFaceState(el, options.state ?? "idle");
  return el;
}

function drawFace(el: HTMLElement, face: FaceSpec, size: number): void {
  const mark = face.model === undefined ? null : resolveModelFace(face.model);
  // What a redraw needs is on the element itself: a list that morphs its rows keeps the element.
  if (face.model !== undefined) {
    el.dataset.model = face.model;
    el.dataset.face = encodeFace(face);
  }
  el.classList.toggle("is-model", !!mark);
  if (mark) el.replaceChildren(mark);
  else el.innerHTML = faceSvg(face, size);
}

/** Redraws every model face in the window: the default model or a provider's logo changed. */
export function refreshModelFaces(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".agent-face[data-model]")) {
    const face = parseFace(el.dataset.face);
    const size = Number.parseFloat(el.style.getPropertyValue("--face-size")) || 24;
    if (face) drawFace(el, { ...face, model: el.dataset.model ?? "" }, size);
  }
}

/** Changes a face element's state in place (no new element, so its animation runs on). */
export function setFaceState(el: HTMLElement, state: FaceState): void {
  if (el.dataset.state !== state) el.dataset.state = state;
}

/** Two or three faces overlapping (a group chat, a team), the first in front. */
export function faceGroup(faces: readonly FaceSpec[], size = 24): HTMLElement {
  const shown = faces.slice(0, 3);
  const small = Math.round(size * (shown.length > 2 ? 0.62 : 0.7));
  return h(
    "span",
    { class: "agent-face-group", style: { "--face-size": `${size}px` }, "aria-hidden": "true" },
    ...shown.map((f) => agentFace(f, { size: small })),
  );
}
