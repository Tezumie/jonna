// Inline values from extensions' providers (VS Code's InlineValuesProvider): when one serves the
// stopped file's language, its answer replaces the debugger's own word matching, as in VS Code.
// Text shows as given; a variable is looked up in the stopped frame's scopes (its name, or the
// range's text); an expression is evaluated in the frame. Values of a line are joined with ", ",
// in the order of their ranges. DOM-free and unit-tested.
import type { InlineValueEntry } from "../../workbench/extensionProviders";
import { formatInlineValue, type InlineValueLine, MAX_NUM_INLINE_VALUES } from "./inlineValues";

export interface ProvidedValueDeps {
  /** The file's lines (for a range's text). */
  lines: readonly string[];
  /** A variable's value in the frame's scopes (narrowest first), or undefined. */
  lookup(name: string, caseSensitive: boolean): string | undefined;
  /** An expression's value in the frame, or undefined when it fails. */
  evaluate(expression: string): Promise<string | undefined>;
}

/** The text in `range` of `lines` (1-based; end column exclusive; on its first line only). */
function textIn(lines: readonly string[], range: InlineValueEntry["range"]): string {
  const line = lines[range.startLine - 1] ?? "";
  const start = (range.startColumn ?? 1) - 1;
  const sameLine = (range.endLine ?? range.startLine) === range.startLine;
  const end = sameLine && range.endColumn !== undefined ? range.endColumn - 1 : line.length;
  return line.slice(start, Math.max(start, end));
}

/** `values` as the lines' texts the debugger draws (at most MAX_NUM_INLINE_VALUES values). */
export async function providedValueLines(
  values: readonly InlineValueEntry[],
  deps: ProvidedValueDeps,
): Promise<InlineValueLine[]> {
  const sorted = [...values]
    .sort(
      (a, b) =>
        a.range.startLine - b.range.startLine ||
        (a.range.startColumn ?? 1) - (b.range.startColumn ?? 1),
    )
    .slice(0, MAX_NUM_INLINE_VALUES);
  const texts = await Promise.all(
    sorted.map(async (v): Promise<string | undefined> => {
      if (v.kind === "text") return v.text;
      if (v.kind === "variable") {
        const name = v.name ?? textIn(deps.lines, v.range);
        const value = name ? deps.lookup(name, v.caseSensitive) : undefined;
        return value === undefined ? undefined : `${name} = ${value}`;
      }
      const expression = v.expression ?? textIn(deps.lines, v.range);
      if (!expression.trim()) return undefined;
      const value = await deps.evaluate(expression).catch(() => undefined);
      return value === undefined ? undefined : `${expression} = ${value}`;
    }),
  );
  const perLine = new Map<number, string[]>();
  sorted.forEach((v, i) => {
    const text = texts[i];
    if (text === undefined) return;
    const line = v.range.startLine;
    perLine.set(line, [...(perLine.get(line) ?? []), text]);
  });
  return [...perLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, parts]) => ({ line, text: formatInlineValue(parts.join(", ")) }));
}
