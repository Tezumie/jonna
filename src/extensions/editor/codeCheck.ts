// Checking proposed file contents for the agent (D107): after an edit, the language services
// (TS/JS, JSON, CSS) look at the new text in a scratch copy next to the file; errors the file
// didn't already have go back to the model in the tool result, so it fixes them in the next step.
import type { CodeCheckService, CodeProblem } from "../../workbench/services";
import type { Diagnostic } from "./engine";
import type { EditorService } from "./service";

const TIMEOUT_MS = 2000;
const MAX = 8;

const key = (d: Diagnostic) => `${d.code ?? ""}\0${d.message}`;

export function createCodeCheck(editors: EditorService): CodeCheckService {
  return {
    async newErrors(path, text, before) {
      const engine = editors.loadedEngine;
      if (!engine) return null;
      const after = await engine.checkText(path, text, TIMEOUT_MS);
      if (!after) return null;
      const errors = after.filter((d) => d.severity === "error");
      if (!errors.length) return [];
      // What the file already had: the open editor's markers, else a check of the old text.
      const open = engine.diagnostics().filter((d) => d.path === path);
      const old =
        open.length || before === null
          ? open
          : ((await engine.checkText(path, before, TIMEOUT_MS)) ?? []);
      const counts = new Map<string, number>();
      for (const d of old) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
      const fresh: CodeProblem[] = [];
      for (const d of errors) {
        const n = counts.get(key(d)) ?? 0;
        if (n > 0) counts.set(key(d), n - 1);
        else fresh.push({ line: d.line, column: d.column, message: d.message, severity: "error" });
      }
      return fresh.slice(0, MAX);
    },
  };
}
