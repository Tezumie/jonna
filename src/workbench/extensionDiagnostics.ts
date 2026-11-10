// An extension's problems (`ide.languages.setDiagnostics`, the `vscode` shim's diagnostic
// collections) checked into the Problems service's shape, keeping what VS Code keeps: the Hint
// severity (a faint mark, not a listed problem), tags (unused code faded, deprecated struck
// through), the reporting source (Pyright, Ruff) rather than the extension's name, a code's web
// page and related places. DOM-free and unit-tested.
import type { ExternalProblem } from "./services";

const MAX_MESSAGE = 2000;
const MAX_RELATED = 20;

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const SEVERITIES = ["error", "warning", "info", "hint"] as const;

/** A web address the editor may open from a hover (no `command:` or script links). */
function webTarget(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 2000) return undefined;
  return /^https?:\/\//i.test(v) ? v : undefined;
}

function span(d: Record<string, unknown>): {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
} | null {
  const line = int(d.line);
  if (!line || line < 1) return null;
  const column = Math.max(1, int(d.column) ?? 1);
  return {
    line,
    column,
    endLine: Math.max(line, int(d.endLine) ?? line),
    endColumn: Math.max(1, int(d.endColumn) ?? column + 1),
  };
}

/**
 * `items` for `path` as problems; `source` when an item names none (the extension's name);
 * `resolve` turns a related place's path into one the editor opens (throws: left out).
 */
export function normalizeDiagnostics(
  items: readonly unknown[],
  path: string,
  source: string,
  resolve: (path: unknown) => string,
): ExternalProblem[] {
  return items.flatMap((raw): ExternalProblem[] => {
    const d = record(raw);
    const message = typeof d.message === "string" ? d.message.slice(0, MAX_MESSAGE) : "";
    const at = span(d);
    if (!at || !message) return [];
    const severity = SEVERITIES.find((s) => s === d.severity) ?? "info";
    const tags = (Array.isArray(d.tags) ? d.tags : []).filter(
      (t): t is "unnecessary" | "deprecated" => t === "unnecessary" || t === "deprecated",
    );
    const code = typeof d.code === "string" ? d.code.slice(0, 200) : undefined;
    const codeTarget = code ? webTarget(d.codeTarget) : undefined;
    const related = (Array.isArray(d.relatedInformation) ? d.relatedInformation : [])
      .slice(0, MAX_RELATED)
      .flatMap((r) => {
        const o = record(r);
        const where = span({
          line: o.startLine ?? o.line,
          column: o.startColumn ?? o.column,
          endLine: o.endLine,
          endColumn: o.endColumn,
        });
        const text = typeof o.message === "string" ? o.message.slice(0, MAX_MESSAGE) : "";
        if (!where) return [];
        try {
          return [{ path: resolve(o.path), message: text, ...where }];
        } catch {
          return [];
        }
      });
    const own = typeof d.source === "string" && d.source.trim() ? d.source.slice(0, 100) : source;
    return [
      {
        path,
        severity,
        message,
        source: own,
        code,
        ...at,
        ...(tags.length && { tags: [...new Set(tags)] }),
        ...(codeTarget && { codeTarget }),
        ...(related.length && { related }),
      },
    ];
  });
}
