// Ctrl+click on a file path in any text (D117): `src/app.ts:12:5`, `"./logo.png"`, a compiler's
// `C:\\w\\a.ts(3,7)`. Candidates come from pathLinks.ts; only files that exist are underlined
// (checked through the IDE, cached briefly). Opening goes through registerEditorOpener (the
// `file:` link with an `L<line>,<col>` fragment selects the position).
import type { EngineHost } from "../engine";
import { findPathCandidates, resolveCandidate } from "../pathLinks";
import * as monaco from "./core";

/** Lines scanned per document (huge files: only the top) and existence checks per pass. */
const MAX_LINES = 5000;
const MAX_CHECKS = 300;
const CACHE_MS = 10_000;
const MAX_CHARS = 1024 * 1024;

export function registerPathLinks(host: EngineHost): void {
  const cache = new Map<string, { at: number; exists: Promise<boolean> }>();
  const exists = (path: string): Promise<boolean> => {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.exists;
    const entry = { at: Date.now(), exists: host.fileExists(path) };
    cache.set(path, entry);
    if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
    return entry.exists;
  };
  monaco.languages.registerLinkProvider("*", {
    provideLinks: async (model, token) => {
      // Big files (logs, bundles) aren't scanned at all; Monaco cancels when the text changes.
      if (model.uri.scheme !== "file" || model.getValueLength() > MAX_CHARS) return { links: [] };
      const file = model.uri.fsPath;
      const dir = file.replace(/[\\/][^\\/]*$/, "");
      const root = host.root(file);
      const lines = Math.min(model.getLineCount(), MAX_LINES);
      const found: { range: monaco.IRange; targets: string[]; line?: number; column?: number }[] =
        [];
      let checks = 0;
      for (let n = 1; n <= lines && checks < MAX_CHECKS; n++) {
        if (n % 500 === 0 && token.isCancellationRequested) return { links: [] };
        const text = model.getLineContent(n);
        if (text.length > 2000) continue;
        for (const c of findPathCandidates(text, 20)) {
          if (c.path.startsWith("~")) continue;
          const targets = resolveCandidate(c.path, dir, root).filter((t) => t !== file);
          if (!targets.length) continue;
          checks += targets.length;
          found.push({
            range: {
              startLineNumber: n,
              startColumn: c.start + 1,
              endLineNumber: n,
              endColumn: c.end + 1,
            },
            targets,
            ...(c.line && { line: c.line }),
            ...(c.column && { column: c.column }),
          });
        }
      }
      if (token.isCancellationRequested) return { links: [] };
      const links = await Promise.all(
        found.map(async (f) => {
          for (const target of f.targets) {
            if (!(await exists(target))) continue;
            const fragment = f.line ? `L${f.line}${f.column ? `,${f.column}` : ""}` : "";
            return {
              range: f.range,
              url: monaco.Uri.file(target).with({ fragment }),
              tooltip: "Open file",
            };
          }
          return null;
        }),
      );
      return { links: links.filter((l) => l !== null) };
    },
  });
}
