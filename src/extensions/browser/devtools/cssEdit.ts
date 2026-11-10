// What the Styles pane computes itself (D146): stepping numbers with the arrow keys, finding
// colors in a value (for swatches), and which declarations the cascade overrides (struck
// through, as in Chrome). DOM-free and tested.

/**
 * `value` with the number at (or before) `caret` changed by `delta`, keeping its unit and the
 * precision the step needs ("10px" ↑ → "11px", "0.5" + 0.1 → "0.6"); null when there's none.
 */
export function bumpNumber(
  value: string,
  caret: number,
  delta: number,
): { value: string; start: number; end: number } | null {
  const re = /-?\d*\.?\d+/g;
  let pick: RegExpExecArray | null = null;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    // Not inside a word ("h1", "#a1b2"…): a number of its own.
    const before = value[m.index - 1] ?? "";
    if (/[a-zA-Z_#]/.test(before) && !/[-\s(,]/.test(before)) continue;
    if (m.index <= caret) pick = m;
    else {
      pick ??= m;
      break;
    }
  }
  if (!pick) return null;
  const text = pick[0];
  const decimals = Math.max(
    text.includes(".") ? (text.split(".")[1]?.length ?? 0) : 0,
    Math.abs(delta) < 1 ? 1 : 0,
  );
  const next = (Number.parseFloat(text) + delta).toFixed(decimals);
  const clean = decimals ? next.replace(/\.?0+$/, "") || "0" : next;
  const start = pick.index;
  return {
    value: value.slice(0, start) + clean + value.slice(start + text.length),
    start,
    end: start + clean.length,
  };
}

const NAMED = new Set(
  "black white red green blue yellow orange purple pink gray grey silver maroon olive lime aqua teal navy fuchsia transparent currentcolor rebeccapurple".split(
    " ",
  ),
);

/** The colors written in a value, with their positions. */
export function colorTokens(value: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re =
    /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)|\b[a-zA-Z]+\b/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const t = m[0];
    if (/^[a-zA-Z]+$/.test(t) && !NAMED.has(t.toLowerCase())) continue;
    if (/^#/.test(t) && ![4, 5, 7, 9].includes(t.length)) continue;
    out.push({ text: t, start: m.index, end: m.index + t.length });
  }
  return out;
}

export interface CascadeRule {
  /** "inline" for element.style. */
  id: string;
  specificity: number[];
  order: number;
  props: [string, string, boolean, boolean][];
}

/** Rules by precedence: inline first, then higher specificity, then later in the document. */
export function byPrecedence<T extends CascadeRule>(rules: T[]): T[] {
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  return [...rules].sort((a, b) =>
    a.id === "inline"
      ? -1
      : b.id === "inline"
        ? 1
        : cmp(a.specificity, b.specificity) || b.order - a.order,
  );
}

/**
 * The declarations (`ruleId:index`) that lose to another one for the same property: an
 * `!important` one wins over normal ones, then the first in precedence order. Switched-off
 * ones don't count.
 */
export function overridden(rules: readonly CascadeRule[]): Set<string> {
  const winner = new Map<string, { key: string; important: boolean }>();
  const out = new Set<string>();
  for (const rule of rules)
    rule.props.forEach(([name, , important, enabled], i) => {
      if (!enabled) return;
      const key = `${rule.id}:${i}`;
      const prev = winner.get(name);
      if (!prev) winner.set(name, { key, important });
      else if (important && !prev.important) {
        out.add(prev.key);
        winner.set(name, { key, important });
      } else out.add(key);
    });
  return out;
}
