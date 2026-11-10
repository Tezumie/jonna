// Auto-close tags (D192): typing the `>` of `<div class="x">` in HTML-like files inserts the
// matching `</div>` after the cursor, as VS Code's HTML support does (`editor.autoClosingTags`).
// The rule is pure so it is testable; the Monaco wiring is in monaco/widgets.ts.

/** Languages whose files hold markup tags. */
export const TAG_LANGUAGES: ReadonlySet<string> = new Set([
  "html",
  "xml",
  "vue",
  "svelte",
  "astro",
  "php",
  "javascriptreact",
  "typescriptreact",
]);

/** HTML elements that never have a closing tag. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * The closing tag to insert after a `>` was just typed: `before` is the line up to and including
 * that `>`, `after` the rest of the line. Null when the `>` doesn't end an opening tag (`/>`, a
 * void element, `a > b`, a TypeScript generic like `useState<T>`, the tag already closed).
 */
export function closingTagFor(before: string, after: string, languageId: string): string | null {
  if (!before.endsWith(">") || before.endsWith("/>")) return null;
  // The last `<` on the line opens the tag; quotes inside attributes may hold `>` but rarely `<`.
  const open = before.lastIndexOf("<");
  if (open < 0) return null;
  const tag = /^<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>$/.exec(before.slice(open));
  if (!tag?.[1]) return null;
  const name = tag[1];
  const jsx = languageId === "javascriptreact" || languageId === "typescriptreact";
  // `foo<Bar>` (a generic) has a word character or `.` right before the `<`.
  if (jsx && open > 0 && /[\w$.)\]]/.test(before[open - 1] ?? "")) return null;
  if (!jsx && VOID.has(name.toLowerCase())) return null;
  // Attribute quotes must be balanced, or the `>` is inside a value (`<a title="x>`); so must
  // braces, or it is inside an expression (`onClick={() =>`, `hidden={a >`).
  const attrs = before.slice(open);
  const count = (re: RegExp) => attrs.match(re)?.length ?? 0;
  if (count(/"/g) % 2 || count(/'/g) % 2 || count(/\{/g) !== count(/\}/g)) return null;
  if (/[=-]>$/.test(attrs)) return null;
  if (new RegExp(`^</${name.replace(/[.]/g, "\\.")}\\s*>`).test(after.trimStart())) return null;
  return `</${name}>`;
}
