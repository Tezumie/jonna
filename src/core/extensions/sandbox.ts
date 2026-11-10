// What the extension worker checks in an extension's source before running it (D102, D203).

/**
 * Whatever may stand between `import` and its `(` in an import call: white space and comments,
 * including the HTML-like ones scripts still accept (`<!--` to the end of the line, and `-->`
 * starting a line).
 */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r  ]*|<!--[^\n\r  ]*|-->[^\n\r  ]*)*`;
// Not after an identifier character (`$import(` is a call of a function named so). After a dot
// it still counts: `...import(` spreads an import call.
const IMPORT_CALL = new RegExp(String.raw`(?<![\w$])import${GAP}\(`);

/**
 * Code that loads modules from a URL (`import(…)`, which is syntax and can't be taken away):
 * refused, it would reach the network without the "network" permission. A comment between the
 * keyword and the parenthesis is the same call, so it counts too.
 */
export function loadsModules(code: string): boolean {
  return IMPORT_CALL.test(code);
}
