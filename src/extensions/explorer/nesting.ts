// biome-ignore-all lint/suspicious/noTemplateCurlyInString: VS Code's nesting placeholders
// Explorer file nesting (VS Code's explorer.fileNesting.*, D201): files that belong to another file
// of the same folder (`a.js` and `a.js.map` under `a.ts`, the lock files under package.json) are
// listed under it. Patterns map a parent name (at most one `*`, its capture) to child patterns
// (comma-separated, with `*` and `${capture}`, `${basename}`, `${extname}`, `${dirname}`). Nesting
// is one level deep: a child's own children go under the same parent. DOM-free, tested.

/** VS Code's default patterns. */
export const DEFAULT_NESTING_PATTERNS: Readonly<Record<string, string>> = {
  "*.ts": "${capture}.js",
  "*.js": "${capture}.js.map, ${capture}.min.js, ${capture}.d.ts",
  "*.jsx": "${capture}.js",
  "*.tsx": "${capture}.ts",
  "tsconfig.json": "tsconfig.*.json",
  "package.json": "package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock",
};

interface ParentRule {
  /** Matches a parent's name (lowercase); group 1 is the capture. */
  parent: RegExp;
  children: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Parses the patterns setting (a bad entry is left out). */
export function nestingRules(patterns: unknown): ParentRule[] {
  if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) return [];
  const rules: ParentRule[] = [];
  for (const [key, value] of Object.entries(patterns as Record<string, unknown>)) {
    const name = key.trim().toLowerCase();
    if (!name || typeof value !== "string" || name.includes("/") || name.includes("\\")) continue;
    const stars = name.split("*").length - 1;
    if (stars > 1) continue;
    const children = value
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!children.length) continue;
    const parent =
      stars === 0
        ? new RegExp(`^${escapeRegExp(name)}()$`)
        : new RegExp(`^${name.split("*").map(escapeRegExp).join("(.+)")}$`);
    rules.push({ parent, children });
  }
  return rules;
}

/**
 * A child pattern with a parent's values filled in, over lowercase names: the name itself when it
 * has no `*` (looked up, not scanned for), else a RegExp.
 */
function childPattern(
  pattern: string,
  values: { capture: string; basename: string; extname: string; dirname: string },
): string | RegExp {
  const lower = pattern.toLowerCase();
  if (!lower.replace(/\$\{(capture|basename|extname|dirname)\}/g, "").includes("*"))
    return lower.replace(/\$\{(capture|basename|extname|dirname)\}/g, (_, v: string) =>
      values[v as keyof typeof values].toLowerCase(),
    );
  let out = "";
  for (let i = 0; i < lower.length; ) {
    const variable = /^\$\{(capture|basename|extname|dirname)\}/.exec(lower.slice(i));
    if (variable) {
      out += escapeRegExp(values[variable[1] as keyof typeof values].toLowerCase());
      i += variable[0].length;
    } else if (lower[i] === "*") {
      out += ".*";
      i++;
    } else {
      out += escapeRegExp(lower[i] ?? "");
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Which files go under which: parent name → its nested names (sorted), for the file `names` of one
 * folder named `dirName`. A file named by several parents goes under the shortest one's name; a
 * file in a cycle of nests stays at the top.
 */
export function nestFiles(
  names: readonly string[],
  rules: readonly ParentRule[],
  dirName: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!rules.length || names.length < 2) return out;
  const lower = names.map((n) => n.toLowerCase());
  const byName = new Map<string, number[]>();
  lower.forEach((n, i) => {
    const list = byName.get(n);
    if (list) list.push(i);
    else byName.set(n, [i]);
  });
  /** Index of a child → the parents (indexes) whose patterns name it. */
  const parentsOf = new Map<number, number[]>();
  names.forEach((name, p) => {
    const lowerName = lower[p] as string;
    const dot = name.lastIndexOf(".");
    const values = {
      capture: "",
      basename: dot > 0 ? name.slice(0, dot) : name,
      extname: dot > 0 ? name.slice(dot + 1) : "",
      dirname: dirName,
    };
    for (const rule of rules) {
      const match = rule.parent.exec(lowerName);
      if (!match) continue;
      values.capture = match[1] ?? "";
      const add = (c: number) => {
        if (c === p) return;
        const list = parentsOf.get(c) ?? [];
        if (!list.includes(p)) list.push(p);
        parentsOf.set(c, list);
      };
      const wild: RegExp[] = [];
      for (const child of rule.children) {
        const pattern = childPattern(child, values);
        if (typeof pattern === "string") for (const c of byName.get(pattern) ?? []) add(c);
        else wild.push(pattern);
      }
      // Only patterns with `*` look at every name (a folder of thousands stays quick, D201).
      if (wild.length)
        lower.forEach((other, c) => {
          if (wild.some((re) => re.test(other))) add(c);
        });
    }
  });
  if (!parentsOf.size) return out;
  // One parent each: the shortest name, then the first by name.
  const parent = new Map<number, number>();
  for (const [c, list] of parentsOf) {
    const best = [...list].sort(
      (a, b) =>
        (names[a] as string).length - (names[b] as string).length ||
        (names[a] as string).localeCompare(names[b] as string),
    )[0];
    if (best !== undefined) parent.set(c, best);
  }
  // Up to the top of each chain; a chain that loops leaves its files at the top.
  const top = (c: number): number | undefined => {
    const seen = new Set<number>([c]);
    let at = parent.get(c);
    while (at !== undefined) {
      if (seen.has(at)) return undefined;
      seen.add(at);
      const up = parent.get(at);
      if (up === undefined) return at;
      at = up;
    }
    return undefined;
  };
  for (const c of parent.keys()) {
    const root = top(c);
    if (root === undefined) continue;
    const key = names[root] as string;
    const list = out.get(key) ?? [];
    list.push(names[c] as string);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * What a file operation on `paths` acts on (VS Code's explorer context, D203): a nest parent that
 * is collapsed stands for itself and its nested files, so delete, move, cut and copy take them
 * along; an expanded one shows its nested files as rows of their own, which are acted on only when
 * selected. Order is kept (each parent's nested files right after it) and nothing is listed twice.
 */
export function withNestedFiles(
  paths: readonly string[],
  nestedOf: (path: string) => readonly string[] | undefined,
  isCollapsed: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const path of paths) {
    add(path);
    const nested = nestedOf(path);
    if (nested?.length && isCollapsed(path)) for (const child of nested) add(child);
  }
  return out;
}
