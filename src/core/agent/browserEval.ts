// browser_eval's REPL semantics (D317), DOM-free: the result of the last expression, and top-level
// `await`. Without `await`, the page's own indirect eval already gives the last expression's value
// (its completion value), so the code goes as is. With it, the code runs as an async function's
// body; which statement is the last expression is decided by the page's parser: the bridge tries
// these bodies in order and runs the first that compiles (`return (<last statement>)`, else the
// code as is, which returns undefined).

const KEYWORD_STATEMENT =
  /^(?:const|let|var|if|for|while|do|switch|try|function|class|return|throw|import|export|break|continue|debugger|async\s+function)\b/;
/** A tail that only continues the line before it (no automatic semicolon there). */
const CONTINUES_AFTER_NEWLINE = /^[.,?:+\-*/%=&|^<>([`]/;
/** A head whose last token wants more (an operator, an open bracket, a comma). */
const HEAD_WANTS_MORE = /[-+*/%=&|^<>!?:,([{.]$/;
const ONLY_COMMENTS = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/;

interface Scan {
  /** Offsets just after a `;` or newline outside brackets, strings, templates and comments. */
  boundaries: { at: number; newline: boolean }[];
  /** `await` appears as a word outside strings and comments. */
  awaits: boolean;
}

/** Characters after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/;

function scan(code: string): Scan {
  const boundaries: Scan["boundaries"] = [];
  let awaits = false;
  let depth = 0;
  /** Open template literals' brace depth when their `${` began. */
  const templates: number[] = [];
  let lastSignificant = "";
  let i = 0;
  const n = code.length;
  const inTemplateText = () => templates.length > 0 && templates[templates.length - 1] === -1;
  while (i < n) {
    const c = code[i] as string;
    const next = code[i + 1];
    if (inTemplateText()) {
      if (c === "\\") i += 2;
      else if (c === "`") {
        templates.pop();
        lastSignificant = "`";
        i++;
      } else if (c === "$" && next === "{") {
        templates[templates.length - 1] = depth;
        depth++;
        i += 2;
        lastSignificant = "{";
      } else i++;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
      i++;
      lastSignificant = c;
      continue;
    }
    if (c === "`") {
      templates.push(-1);
      i++;
      continue;
    }
    if (c === "/" && (lastSignificant === "" || REGEX_AFTER.test(lastSignificant))) {
      // A regular expression literal: to its closing slash (classes may hold one).
      i++;
      let inClass = false;
      while (i < n && code[i] !== "\n") {
        const d = code[i];
        if (d === "\\") i++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i] as string)) i++;
      lastSignificant = "x";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j] as string)) j++;
      const word = code.slice(i, j);
      if (word === "await") awaits = true;
      // After `return`, `typeof`… a slash is a regex again.
      lastSignificant =
        /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(word)
          ? "("
          : "x";
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
      // The `}` that ends a template's `${…}`: back in its text.
      if (c === "}" && templates.length && templates[templates.length - 1] === depth) {
        templates[templates.length - 1] = -1;
        i++;
        continue;
      }
    } else if (depth === 0 && !templates.length && (c === ";" || c === "\n"))
      boundaries.push({ at: i + 1, newline: c === "\n" });
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { boundaries, awaits };
}

/** How browser_eval runs `code`: as is (indirect eval), or as the first of `bodies` that compiles. */
export type EvalPlan = { mode: "eval" } | { mode: "async"; bodies: string[] };

const MAX_CANDIDATES = 8;

export function evalPlan(code: string): EvalPlan {
  const { boundaries, awaits } = scan(code);
  if (!awaits) return { mode: "eval" };
  const bodies: string[] = [];
  const starts = [...boundaries].reverse().concat([{ at: 0, newline: false }]);
  const end = code.replace(/[;\s]+$/, "").length;
  /** Where the code's top-level semicolons are (a tail holding one is two statements). */
  const semicolons = boundaries.filter((b) => !b.newline).map((b) => b.at - 1);
  for (const { at, newline } of starts) {
    if (bodies.length >= MAX_CANDIDATES) break;
    if (semicolons.some((s) => s >= at && s < end)) break;
    const head = code.slice(0, at);
    const tail = code
      .slice(at)
      .trim()
      .replace(/[;\s]+$/, "");
    if (!tail || ONLY_COMMENTS.test(tail)) continue;
    if (KEYWORD_STATEMENT.test(tail) || tail.startsWith("{")) continue;
    if (newline && CONTINUES_AFTER_NEWLINE.test(tail)) continue;
    if (HEAD_WANTS_MORE.test(head.replace(/\/\/[^\n]*$/, "").trim())) continue;
    bodies.push(`${head}\nreturn (${tail}\n);`);
  }
  bodies.push(code);
  return { mode: "async", bodies };
}
