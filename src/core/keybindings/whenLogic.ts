// What two `when` clauses say about each other, for the keybinding table (D209, D219): whether
// they can both hold (two commands on one key are a conflict only then) and whether they're the
// same clause written differently (a "-command" removal with a `when` removes only the binding
// with that clause, as VS Code's does). DOM-free and tested.
//
// A clause is put in disjunctive normal form ("any of these all-of lists of tests"); two lists
// can't both hold when a pair of their tests contradict: `x` / `!x`, `x == a` / `x == b`,
// `x == a` / `x != a`, `x == a` / `x =~ /re/` that doesn't match a, `x in list` / `x not in list`,
// numeric ranges that don't meet (`x < 2` / `x >= 5`, and `!(x < 2)` / `x < 1`), regexes that
// can't match the same string (anchored literals: `/\.ts$/` / `/\.md$/`), or two focus areas (the
// explorer and an editor). Anything not understood is assumed to be able to hold.
//
// Constants (VS Code's substitution): `isMac`, `isWindows`, `isLinux`, `isWeb`… are known at
// load, so with `constants` given they're replaced by true / false before comparing: a binding
// whose clause says `isMac` never conflicts with anything on Windows.

import { parseWhen, type WhenExpr } from "../context/when";

/** Focus areas: at most one has the keyboard. */
const FOCUS_AREAS: readonly (readonly string[])[] = [
  ["editorFocus", "editorTextFocus"],
  ["explorerFocus"],
  ["terminalFocus"],
  ["inQuickInput"],
];

/** One test of one context key. */
type Test =
  | { key: string; t: "truthy" | "falsy" }
  | { key: string; t: "eq" | "neq"; value: string }
  | { key: string; t: "re"; re: RegExp; negated: boolean }
  | { key: string; t: "in"; container: string; negated: boolean }
  /**
   * A numeric comparison: the value is a finite number in this range; `negated`: it isn't (a
   * number outside it, or not a number at all: `!(x < 2)` holds for an unset key).
   */
  | {
      key: string;
      t: "num";
      lo: number;
      loIn: boolean;
      hi: number;
      hiIn: boolean;
      negated?: boolean;
    };

/** Context keys whose value is known when the clause is read (VS Code's constant substitution). */
export type WhenConstants = Readonly<Record<string, boolean>>;

/** The constants for this platform (the IDE is a desktop app: never the web build). */
export function platformConstants(platform: "mac" | "windows" | "linux"): WhenConstants {
  return {
    isMac: platform === "mac",
    isMacNative: platform === "mac",
    isWindows: platform === "windows",
    isLinux: platform === "linux",
    isWeb: false,
    isIOS: false,
    isMobile: false,
  };
}

/** The clause with its constants replaced by true / false (VS Code's substitution). */
function substitute(expr: WhenExpr, constants: WhenConstants | undefined): WhenExpr {
  if (!constants) return expr;
  const known = (key: string) => (Object.hasOwn(constants, key) ? constants[key] : undefined);
  switch (expr.kind) {
    case "key": {
      const v = known(expr.key);
      return v === undefined ? expr : { kind: "const", value: v };
    }
    case "cmp": {
      const v = known(expr.key);
      if (v === undefined || (expr.op !== "==" && expr.op !== "!=")) return expr;
      const same = String(expr.value) === String(v);
      return { kind: "const", value: expr.op === "==" ? same : !same };
    }
    case "not": {
      const inner = substitute(expr.expr, constants);
      return inner.kind === "const"
        ? { kind: "const", value: !inner.value }
        : { ...expr, expr: inner };
    }
    case "and":
    case "or": {
      const all = expr.kind === "and";
      const parts: WhenExpr[] = [];
      for (const e of expr.exprs) {
        const sub = substitute(e, constants);
        if (sub.kind === "const") {
          // `false && …` is false, `true || …` is true; the other constant drops out.
          if (sub.value !== all) return sub;
          continue;
        }
        parts.push(sub);
      }
      if (parts.length === 0) return { kind: "const", value: all };
      return parts.length === 1 ? (parts[0] as WhenExpr) : { kind: expr.kind, exprs: parts };
    }
    default:
      return expr;
  }
}

type Dnf = Test[][];

/** Past this many all-of lists the clause is "too complex": assumed to overlap anything. */
const BUDGET = 64;

function product(a: Dnf, b: Dnf, budget: { left: number }): Dnf | null {
  const out: Dnf = [];
  for (const x of a)
    for (const y of b) {
      out.push([...x, ...y]);
      if (--budget.left < 0) return null;
    }
  return out;
}

/** The clause (negated when `neg`) in normal form; null when it's too complex to say. */
function dnf(expr: WhenExpr, neg: boolean, budget: { left: number }): Dnf | null {
  switch (expr.kind) {
    case "const":
      return expr.value !== neg ? [[]] : [];
    case "key":
      return [[{ key: expr.key, t: neg ? "falsy" : "truthy" }]];
    case "not":
      return dnf(expr.expr, !neg, budget);
    case "and":
    case "or": {
      // De Morgan: a negated "and" is an "or" of the negations, and the other way round.
      const all = (expr.kind === "and") !== neg;
      let out: Dnf = all ? [[]] : [];
      for (const e of expr.exprs) {
        const d = dnf(e, neg, budget);
        if (!d) return null;
        if (all) {
          const next = product(out, d, budget);
          if (!next) return null;
          out = next;
        } else {
          out.push(...d);
          budget.left -= d.length;
          if (budget.left < 0) return null;
        }
      }
      return out;
    }
    case "cmp": {
      const value = String(expr.value);
      if (expr.op === "==" || expr.op === "!=")
        return [[{ key: expr.key, t: (expr.op === "==") !== neg ? "eq" : "neq", value }]];
      const n = Number(expr.value);
      if (!Number.isFinite(n)) return [[]];
      const range = { lo: -Infinity, loIn: false, hi: Infinity, hiIn: false };
      if (expr.op === "<" || expr.op === "<=")
        Object.assign(range, { hi: n, hiIn: expr.op === "<=" });
      else Object.assign(range, { lo: n, loIn: expr.op === ">=" });
      // `!(x < 2)` isn't `x >= 2`: it also holds for a value that isn't a number.
      return [[{ key: expr.key, t: "num", ...range, ...(neg && { negated: true }) }]];
    }
    case "regex":
      return [[{ key: expr.key, t: "re", re: expr.regex, negated: neg }]];
    case "in":
      return [
        [{ key: expr.key, t: "in", container: expr.container, negated: expr.negated !== neg }],
      ];
  }
}

const reTest = (re: RegExp, s: string) => {
  re.lastIndex = 0;
  return re.test(s);
};

/** What `String(value)` of a falsy value can be (undefined, null, false, 0, "", NaN). */
const FALSY_STRINGS = new Set(["undefined", "null", "false", "0", "", "NaN"]);

/** `x == value` can only hold for a string `x` (not a number or boolean that prints so). */
const onlyAString = (value: string) =>
  !FALSY_STRINGS.has(value) && value !== "true" && !Number.isFinite(Number(value));

type Range = { lo: number; loIn: boolean; hi: number; hiIn: boolean };

function inRange(n: number, r: Range) {
  return (n > r.lo || (r.loIn && n === r.lo)) && (n < r.hi || (r.hiIn && n === r.hi));
}

/** Whether every number in `inner` is in `outer`. */
function rangeWithin(inner: Range, outer: Range): boolean {
  const lo = outer.lo < inner.lo || (outer.lo === inner.lo && (outer.loIn || !inner.loIn));
  const hi = inner.hi < outer.hi || (outer.hi === inner.hi && (outer.hiIn || !inner.hiIn));
  return lo && hi;
}

/** A context value written in a clause, as the number a comparison reads, if it is one. */
function asNumber(value: string): number | null {
  if (!value.trim() || value === "true" || value === "false") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---- What a regex can match, when it's simple enough to say ----------------------------------

type RegexToken = { lit: string } | { other: string };

/** A regex's pieces: fixed characters, or anything else (`.`, a class, a quantifier…). */
function regexTokens(source: string): RegexToken[] {
  const out: RegexToken[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      const next = source.charAt(i + 1);
      i++;
      // `\.`, `\/`, `\-`: the character itself; `\d`, `\w`, `\b`…: a class or an assertion.
      out.push(!next || /[A-Za-z0-9]/.test(next) ? { other: `\\${next}` } : { lit: next });
    } else if ("?*+{".includes(ch)) {
      // A quantifier makes the piece before it optional or repeated: no longer fixed.
      const prev = out.pop();
      out.push({ other: `${prev && "lit" in prev ? prev.lit : ""}${ch}` });
    } else if ("^$.|()[]}".includes(ch)) out.push({ other: ch });
    else out.push({ lit: ch });
  }
  return out;
}

/**
 * The few strings an anchored literal regex matches (`/^(ts|js)$/`, `/^\.md$/`), or null. One
 * group of literal alternatives at most.
 */
function regexLiterals(re: RegExp): string[] | null {
  if (re.flags.includes("m") || re.flags.includes("i")) return null;
  const m = /^\^([^()|]*)(?:\((?:\?:)?([^()]*)\))?([^()|]*)\$$/.exec(re.source);
  if (!m) return null;
  const literal = (part: string): string | null => {
    const tokens = regexTokens(part);
    let out = "";
    for (const t of tokens) {
      if (!("lit" in t)) return null;
      out += t.lit;
    }
    return out;
  };
  const head = literal(m[1] ?? "");
  const tail = literal(m[3] ?? "");
  if (head === null || tail === null) return null;
  const alternatives = m[2] === undefined ? [""] : m[2].split("|").map(literal);
  const out: string[] = [];
  for (const a of alternatives) {
    if (a === null) return null;
    out.push(`${head}${a}${tail}`);
  }
  return out;
}

/** A regex's fixed start (after `^`) and end (before `$`); "" when it has none. */
function regexEnds(re: RegExp): { prefix: string; suffix: string } | null {
  if (re.flags.includes("m")) return null;
  const tokens = regexTokens(re.source);
  // A top-level `|` would make each end belong to one alternative only.
  let depth = 0;
  for (const t of tokens) {
    if (!("other" in t)) continue;
    if (t.other === "(") depth++;
    else if (t.other === ")") depth--;
    else if (t.other === "|" && depth === 0) return null;
  }
  const fixed = (list: readonly RegexToken[]) => {
    let out = "";
    for (const t of list) {
      if (!("lit" in t)) break;
      out += t.lit;
    }
    return out;
  };
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const prefix = first && "other" in first && first.other === "^" ? fixed(tokens.slice(1)) : "";
  const suffix =
    last && "other" in last && last.other === "$"
      ? [...fixed(tokens.slice(0, -1).reverse())].reverse().join("")
      : "";
  return { prefix, suffix };
}

/** Whether two regexes (neither negated) can't match the same string. */
function regexesDisjoint(a: RegExp, b: RegExp): boolean {
  const la = regexLiterals(a);
  if (la) return la.every((s) => !reTest(b, s));
  const lb = regexLiterals(b);
  if (lb) return lb.every((s) => !reTest(a, s));
  const ea = regexEnds(a);
  const eb = regexEnds(b);
  if (!ea || !eb) return false;
  // Compared without case: a regex with `i` may match either spelling.
  const low = (s: string) => s.toLowerCase();
  const startsClash = (x: string, y: string) =>
    !low(x).startsWith(low(y)) && !low(y).startsWith(low(x));
  const endsClash = (x: string, y: string) => !low(x).endsWith(low(y)) && !low(y).endsWith(low(x));
  return startsClash(ea.prefix, eb.prefix) || endsClash(ea.suffix, eb.suffix);
}

/** Whether tests `x` and `y` (on the same key) can't both hold; checked one way round. */
function excludes(x: Test, y: Test): boolean {
  switch (x.t) {
    case "truthy":
      return y.t === "falsy";
    case "falsy":
      if (y.t === "eq") return !FALSY_STRINGS.has(y.value);
      // A falsy string is "", the only one a regex is tried on.
      if (y.t === "re") return !y.negated && !reTest(y.re, "");
      // A falsy value is 0 as a number (null, false, "", 0) or not a number at all.
      if (y.t === "num") return !y.negated && !inRange(0, y);
      return false;
    case "eq":
      if (y.t === "eq") return x.value !== y.value;
      if (y.t === "neq") return x.value === y.value;
      // A regex is only tried on strings: a non-string `x` that prints as the value fails it.
      if (y.t === "re")
        return y.negated ? onlyAString(x.value) && reTest(y.re, x.value) : !reTest(y.re, x.value);
      if (y.t === "num") {
        if (x.value === "true" || x.value === "false") return false;
        if (y.negated) {
          const n = asNumber(x.value);
          return n !== null && inRange(n, y);
        }
        const n = Number(x.value);
        return !Number.isFinite(n) || !inRange(n, y);
      }
      return false;
    case "re": {
      if (y.t !== "re") return false;
      if (x.re.source === y.re.source && x.re.flags === y.re.flags) return x.negated !== y.negated;
      if (!x.negated && !y.negated) return regexesDisjoint(x.re, y.re);
      // `x =~ /^(a|b)$/` and `!(x =~ /a|b/)`: every string the first matches, the second refuses.
      if (!x.negated && y.negated) {
        const literals = regexLiterals(x.re);
        return !!literals && literals.every((s) => reTest(y.re, s));
      }
      return false;
    }
    case "in":
      return y.t === "in" && x.container === y.container && x.negated !== y.negated;
    case "num":
      if (y.t !== "num") return false;
      // Both hold for a value that isn't a number.
      if (x.negated && y.negated) return false;
      // `x < 1` and `!(x < 2)`: every number the first allows, the second refuses.
      if (x.negated || y.negated) return x.negated ? rangeWithin(y, x) : rangeWithin(x, y);
      // Two ranges that don't meet.
      return (
        x.hi < y.lo ||
        y.hi < x.lo ||
        (x.hi === y.lo && !(x.hiIn && y.loIn)) ||
        (y.hi === x.lo && !(y.hiIn && x.loIn))
      );
    default:
      return false;
  }
}

function contradicts(a: readonly Test[], b: readonly Test[]): boolean {
  const all = [...a, ...b];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const x = all[i] as Test;
      const y = all[j] as Test;
      if (x.key === y.key && (excludes(x, y) || excludes(y, x))) return true;
    }
  const areas = (list: readonly Test[]) =>
    new Set(
      list
        .filter((l) => l.t === "truthy")
        .flatMap((l) => {
          const i = FOCUS_AREAS.findIndex((keys) => keys.includes(l.key));
          return i < 0 ? [] : [i];
        }),
    );
  const areasA = areas(a);
  for (const i of areas(b)) if (areasA.size && !areasA.has(i)) return true;
  return false;
}

function normalForm(clause: string, constants?: WhenConstants): Dnf | null {
  try {
    const d = dnf(substitute(parseWhen(clause), constants), false, { left: BUDGET });
    // A list that contradicts itself can never hold.
    return d?.filter((list) => !contradicts(list, [])) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether two `when` clauses can both hold (unparsable or complex clauses: assumed so). With
 * `constants`, keys known at load (`isMac`…) are replaced by their value first.
 */
export function whensCanOverlap(
  a: string | undefined,
  b: string | undefined,
  constants?: WhenConstants,
): boolean {
  const always: Dnf = [[]];
  const da = a?.trim() ? normalForm(a, constants) : always;
  const db = b?.trim() ? normalForm(b, constants) : always;
  if (!da || !db) return true;
  return da.some((x) => db.some((y) => !contradicts(x, y)));
}

/** Whether the clause always holds once its constants are known (none, `true`, `isWindows` here). */
export function whenAlwaysHolds(when: string | undefined, constants?: WhenConstants): boolean {
  if (!when?.trim()) return true;
  try {
    const e = substitute(parseWhen(when), constants);
    return e.kind === "const" && e.value;
  } catch {
    return false;
  }
}

// ---- The same clause written differently ---------------------------------------------------

/** A canonical spelling: spaces, quotes, operand order and nesting of `&&` / `||` don't matter. */
function canonical(expr: WhenExpr): string {
  switch (expr.kind) {
    case "const":
      return String(expr.value);
    case "key":
      return expr.key;
    case "not":
      return `!${canonical(expr.expr)}`;
    case "and":
    case "or": {
      const parts = new Set<string>();
      for (const e of expr.exprs) {
        // (a && b) && c is a && b && c.
        if (e.kind === expr.kind) for (const inner of e.exprs) parts.add(canonical(inner));
        else parts.add(canonical(e));
      }
      const list = [...parts].sort();
      return list.length === 1 ? (list[0] as string) : `${expr.kind}(${list.join(",")})`;
    }
    case "cmp":
      return `${expr.key}${expr.op}${JSON.stringify(String(expr.value))}`;
    case "regex":
      return `${expr.key}=~${String(expr.regex)}`;
    case "in":
      return `${expr.key}${expr.negated ? " not in " : " in "}${expr.container}`;
  }
}

/**
 * Whether two clauses are the same (an empty or missing clause is "always"). With `constants`,
 * `isWindows && editorFocus` on Windows is `editorFocus`.
 */
export function whensEqual(
  a: string | undefined,
  b: string | undefined,
  constants?: WhenConstants,
): boolean {
  const norm = (w: string | undefined) => {
    if (!w?.trim()) return "true";
    try {
      return canonical(substitute(parseWhen(w), constants));
    } catch {
      return w.trim();
    }
  };
  return norm(a) === norm(b);
}

/**
 * Whether a "-command" removal takes away a binding (VS Code's rule): same command, the same
 * keys when the removal names keys, and the same `when` when the removal has one.
 */
export function removalMatches(
  removal: { command: string; chords: string | null; when: string | undefined },
  binding: { command: string; chords: string; when: string | undefined },
): boolean {
  if (removal.command !== binding.command) return false;
  if (removal.chords !== null && removal.chords !== binding.chords) return false;
  if (removal.when?.trim() && removal.when.trim() !== "true")
    return !!binding.when?.trim() && whensEqual(removal.when, binding.when);
  return true;
}
