// What the debugger's hover evaluates (D255): extensions' evaluatable expression providers (VS
// Code's EvaluatableExpressionProvider) are asked first, in the order they registered; without
// one, the hover takes the identifier or member chain under the pointer (hoverExpression.ts).
import { type Disposable, toDisposable } from "../../../core/lifecycle/index";
import type * as monaco from "./core";

export type EvaluatableSource = (
  model: monaco.editor.ITextModel,
  position: monaco.Position,
) => Promise<{ range: monaco.Range; expression: string } | null>;

const sources: EvaluatableSource[] = [];

export function addEvaluatableSource(source: EvaluatableSource): Disposable {
  sources.push(source);
  return toDisposable(() => {
    const at = sources.indexOf(source);
    if (at >= 0) sources.splice(at, 1);
  });
}

/** The first expression an extension gives for the position, or null. */
export async function evaluatableAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<{ range: monaco.Range; expression: string } | null> {
  for (const source of [...sources]) {
    const found = await source(model, position).catch(() => null);
    if (found?.expression.trim()) return found;
  }
  return null;
}
