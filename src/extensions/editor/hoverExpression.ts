// What a debug hover evaluates (D145): the identifier under the pointer with the member chain
// before it (`user.profile.name` when hovering `name`, `this.items`), as VS Code does. Calls,
// indexing and keywords aren't evaluated (a hover must not run code). DOM-free and tested.

const IDENT = /[A-Za-z0-9_$]/;
const KEYWORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else export extends " +
    "false finally for function if import in instanceof let new null return super switch throw " +
    "true try typeof var void while with yield async await of from as undefined " +
    "def elif except lambda pass raise not and or is None True False nonlocal global"
  ).split(" "),
);

/** The expression at 1-based `column` of `line`, with its 1-based column span; null if none. */
export function hoverExpression(
  line: string,
  column: number,
): { expression: string; start: number; end: number } | null {
  let at = column - 1;
  if (!IDENT.test(line[at] ?? "")) {
    // Just after a word (the pointer at its right edge).
    if (IDENT.test(line[at - 1] ?? "")) at -= 1;
    else return null;
  }
  let start = at;
  let end = at + 1;
  while (start > 0 && IDENT.test(line[start - 1] ?? "")) start--;
  while (end < line.length && IDENT.test(line[end] ?? "")) end++;
  const word = line.slice(start, end);
  if (/^\d/.test(word) || KEYWORDS.has(word)) return null;
  // The member chain to the left: `a.b.` / `a?.b.`.
  for (;;) {
    let i = start;
    if (line[i - 1] === "." && line[i - 2] === "?") i -= 2;
    else if (line[i - 1] === ".") i -= 1;
    else break;
    let j = i;
    while (j > 0 && IDENT.test(line[j - 1] ?? "")) j--;
    if (j === i || /^\d/.test(line.slice(j, i))) break;
    start = j;
  }
  return { expression: line.slice(start, end), start: start + 1, end: end + 1 };
}
