// Debug hovers (D145): while the debugger is paused, hovering a variable or a member chain shows
// its value (the debug extension evaluates it without side effects), above the language's own
// hover, as in VS Code.
import type { Disposable } from "../../../core/lifecycle/index";
import type { DebugHoverSource } from "../engine";
import { hoverExpression } from "../hoverExpression";
import * as monaco from "./core";
import { evaluatableAt } from "./evaluatable";

/** Long values are cut; the debug console has the whole of them. */
const MAX_CHARS = 1500;

const fence = (text: string) => {
  const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
  // A fence longer than any backtick run inside.
  const ticks = "`".repeat(Math.max(3, ...[...cut.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${cut}\n${ticks}`;
};

export function registerDebugHover(source: DebugHoverSource): Disposable {
  return monaco.languages.registerHoverProvider("*", {
    async provideHover(model, position, token) {
      if (model.uri.scheme !== "file") return null;
      // An extension's evaluatable expression first (D255), else the identifier or member chain.
      const fromExtension = await evaluatableAt(model, position);
      const word = fromExtension
        ? null
        : hoverExpression(model.getLineContent(position.lineNumber), position.column);
      const found = fromExtension
        ? {
            expression: fromExtension.expression,
            range: fromExtension.range,
          }
        : word
          ? {
              expression: word.expression,
              range: new monaco.Range(
                position.lineNumber,
                word.start,
                position.lineNumber,
                word.end,
              ),
            }
          : null;
      if (!found || token.isCancellationRequested) return null;
      const result = await source({ path: model.uri.fsPath, expression: found.expression });
      if (!result || token.isCancellationRequested) return null;
      const lines = [`${found.expression}: ${result.value}`];
      for (const c of result.children ?? []) lines.push(`  ${c.name}: ${c.value}`);
      if (result.more) lines.push("  …");
      return {
        range: found.range,
        contents: [{ value: fence(lines.join("\n")) }],
      };
    },
  });
}
