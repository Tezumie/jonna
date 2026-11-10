// MCP resource templates (D204): `resources/templates/list` gives URI templates (RFC 6570, e.g.
// `file:///{path}`, `github://repos/{owner}/{repo}/issues{?state}`); the user fills the
// variables and the resulting URI is read like any resource. Levels 1–3 of RFC 6570: `{var}`,
// `{+var}`, `{#var}`, `{.var}`, `{/var}`, `{;var}`, `{?a,b}`, `{&a}`. DOM-free and tested.

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface Expression {
  operator: string;
  names: string[];
}

function expressions(template: string): Expression[] {
  const out: Expression[] = [];
  for (const m of template.matchAll(/\{([+#./;?&]?)([^}]*)\}/g)) {
    const names = (m[2] ?? "")
      .split(",")
      .map((n) => n.trim().replace(/\*$|:\d+$/, ""))
      .filter(Boolean);
    out.push({ operator: m[1] ?? "", names });
  }
  return out;
}

/** The template's variables, in order, each once. */
export function templateVariables(template: string): string[] {
  const out: string[] = [];
  for (const e of expressions(template)) for (const n of e.names) if (!out.includes(n)) out.push(n);
  return out;
}

/** Variables in a query (`{?a}`, `{&a}`) may be left out; the others are needed. */
export function requiredVariables(template: string): string[] {
  const out: string[] = [];
  for (const e of expressions(template))
    if (e.operator !== "?" && e.operator !== "&")
      for (const n of e.names) if (!out.includes(n)) out.push(n);
  return out;
}

const unreserved = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
// `+` and `#` keep reserved characters (a path's slashes).
const reserved = (s: string) => encodeURI(s).replace(/%25([0-9A-F]{2})/gi, "%$1");

/** The URI with `values` filled in (missing values left out, as RFC 6570 says). */
export function expandTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([+#./;?&]?)([^}]*)\}/g, (_m, op: string, list: string) => {
    const names = list
      .split(",")
      .map((n) => n.trim().replace(/\*$|:\d+$/, ""))
      .filter(Boolean);
    const defined = names.filter((n) => values[n] !== undefined && values[n] !== null);
    if (!defined.length) return "";
    const enc = op === "+" || op === "#" ? reserved : unreserved;
    const vals = defined.map((n) => enc(String(values[n])));
    switch (op) {
      case "+":
        return vals.join(",");
      case "#":
        return `#${vals.join(",")}`;
      case ".":
        return `.${vals.join(".")}`;
      case "/":
        return `/${vals.join("/")}`;
      case ";":
        return defined.map((n, i) => `;${n}${vals[i] ? `=${vals[i]}` : ""}`).join("");
      case "?":
        return `?${defined.map((n, i) => `${n}=${vals[i]}`).join("&")}`;
      case "&":
        return defined.map((n, i) => `&${n}=${vals[i]}`).join("");
      default:
        return vals.join(",");
    }
  });
}

/**
 * Values for a template from what a person typed: `name=value` pairs, then the remaining words
 * in order for the variables still empty (one variable takes the whole text).
 */
export function parseTemplateArgs(template: string, text: string): Record<string, string> {
  const vars = templateVariables(template);
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (const m of text.trim().matchAll(/(\w+)=("([^"]*)"|'([^']*)'|\S+)|("([^"]*)"|\S+)/g)) {
    if (m[1] && vars.includes(m[1])) out[m[1]] = m[3] ?? m[4] ?? m[2] ?? "";
    else rest.push(m[6] ?? m[5] ?? m[0]);
  }
  const empty = vars.filter((v) => out[v] === undefined);
  if (empty.length === 1 && rest.length) out[empty[0] as string] = rest.join(" ");
  else
    empty.forEach((v, i) => {
      if (rest[i] !== undefined) out[v] = rest[i] as string;
    });
  return out;
}
