// Inline values in the editor while paused (VS Code's `debug.inlineValues`, default "auto"):
// after a stop (or another frame selected, a value set, the file edited) the selected frame's
// scopes are read and `name = value` goes after the lines of its file up to the stopped line
// (inlineValues.ts picks them), in the theme's inline-value colors; they go away 100 ms after
// the program runs again (VS Code's delay, so stepping doesn't flicker). Drawn as an editor
// decoration set of the debugger's own (services.extensionFeatures, like extensions' decoration
// types), whose text has the class `ext-dt-<INLINE_VALUES_TYPE>-after`.
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { toDisposable } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect, type ReadonlySignal, type Signal, signal } from "../../core/reactive/index";
import type { DecorationTypeStyle } from "../../workbench/extensionDecorationTypes";
import { featureMatches } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import { languageForPath } from "../editor/languages";
import type { DebugController, RunningSession } from "./controller";
import {
  type InlineValueLine,
  inlineValueLines,
  inlineValuesOn,
  MAX_LINES_ABOVE,
  mostSpecificScopes,
  syntaxFor,
} from "./inlineValues";
import { providedValueLines } from "./providedInlineValues";
import type { StackFrame } from "./session";

/** The decoration type id of inline values (apart from extensions' and comment marks'). */
export const INLINE_VALUES_TYPE = 2_000_000;
const OWNER = "debug.inlineValues";
const KEY = "values";
/** Values per scope read at most (VS Code reads them all, then keeps 100 names). */
const MAX_VARIABLES = 500;

const STYLE: DecorationTypeStyle = {
  look: {},
  isWholeLine: true,
  after: {
    contentText: "",
    color: "var(--debug-inline-value-fg)",
    backgroundColor: "var(--debug-inline-value-bg)",
  },
};

export interface InlineValuesState {
  path: string;
  lines: readonly InlineValueLine[];
}

/** Draws inline values; the signal says what's shown (for `ide://debug`). */
export function registerInlineValues(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
): ReadonlySignal<InlineValuesState | null> {
  const { extensionFeatures, settings, documents } = services;
  const shown: Signal<InlineValuesState | null> = signal(null);
  /** Bumped when the shown file's text changes. */
  const edited = signal(0);
  let generation = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let clearing: ReturnType<typeof setTimeout> | null = null;
  const cancel = (t: ReturnType<typeof setTimeout> | null) => {
    if (t !== null) clearTimeout(t);
    return null;
  };

  const clear = () => {
    generation++;
    if (shown.peek()) shown.value = null;
    extensionFeatures.clearDecorations(OWNER);
  };

  const compute = async (gen: number, rs: RunningSession, frame: StackFrame, path: string) => {
    const session = rs.session;
    if (!session) return;
    const text =
      documents.text(path) ??
      (await fsIpc.read(path).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => null,
      ));
    if (text === null || gen !== generation) return;
    const scopes = mostSpecificScopes(await session.scopes(frame.id).catch(() => []), frame.line);
    const values = await Promise.all(
      scopes.map(async (s) => ({
        startLine: s.line ?? 1,
        variables: (await session.variables(s.ref).catch(() => []))
          .slice(0, MAX_VARIABLES)
          .map((v) => ({ name: v.name, value: v.value })),
      })),
    );
    if (gen !== generation || rs.state.peek() !== "stopped") return;
    const fileLines = text.split(/\r?\n/);
    // An extension's inline values provider for the file's language replaces the word matching
    // (VS Code's InlineValuesProvider), asked about the lines up to the stopped one.
    const languageId = languageForPath(path);
    const providers = extensionFeatures.languages
      .peek()
      .filter((f) => f.inlineValues && featureMatches(f, languageId));
    const lines = providers.length
      ? await providedValueLines(
          (
            await Promise.all(
              providers.map((f) =>
                (
                  f.inlineValues?.({
                    path,
                    languageId,
                    range: {
                      startLine: Math.max(1, frame.line - MAX_LINES_ABOVE + 1),
                      startColumn: 1,
                      endLine: frame.line,
                      endColumn: (fileLines[frame.line - 1]?.length ?? 0) + 1,
                    },
                    frameId: frame.id,
                    stoppedLine: frame.line,
                  }) ?? Promise.resolve([])
                ).catch(() => []),
              ),
            )
          ).flat(),
          {
            lines: fileLines,
            lookup: (name, caseSensitive) => {
              const same = (v: { name: string }) =>
                caseSensitive ? v.name === name : v.name.toLowerCase() === name.toLowerCase();
              for (const scope of values) {
                const found = scope.variables.find(same);
                if (found) return found.value;
              }
              return undefined;
            },
            evaluate: async (expression) =>
              (await session.evaluate(expression, frame.id, "watch")).value,
          },
        )
      : inlineValueLines({
          lines: fileLines,
          syntax: syntaxFor(path),
          stopLine: frame.line,
          scopes: values,
        });
    if (gen !== generation || rs.state.peek() !== "stopped") return;
    // Another file's values go (the same file's are replaced below).
    const before = shown.peek();
    if (before && pathKey(before.path) !== pathKey(path)) extensionFeatures.clearDecorations(OWNER);
    extensionFeatures.setDecorations({
      owner: OWNER,
      key: KEY,
      path,
      style: "custom",
      custom: { id: INLINE_VALUES_TYPE, style: STYLE },
      ranges: lines.map((l) => ({ startLine: l.line, after: l.text })),
    });
    shown.value = { path, lines };
  };

  sub.add(
    effect(() => {
      settings.version.value;
      edited.value;
      debug.frameVersion.value;
      const rs = debug.focused.value;
      const stopped = debug.state.value === "stopped";
      const frame = debug.frames.value[debug.frameIndex.value];
      const path = frame?.path;
      pending = cancel(pending);
      if (
        !rs ||
        !stopped ||
        !frame ||
        !path ||
        !inlineValuesOn(settings.peekAt("debug.inlineValues", path), path)
      ) {
        generation++;
        // Running again: cleared a little later, so a step doesn't flicker (VS Code's 100 ms).
        if (!clearing && shown.peek())
          clearing = setTimeout(() => {
            clearing = null;
            clear();
          }, 100);
        return undefined;
      }
      clearing = cancel(clearing);
      const gen = ++generation;
      // One read for the several changes of a stop (frames, the frame, its scopes).
      pending = setTimeout(() => {
        pending = null;
        void compute(gen, rs, frame, path);
      }, 50);
      return undefined;
    }),
  );
  // The shown file edited: its words moved (VS Code recomputes too).
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  sub.add(
    documents.onDidChange((path) => {
      const current = shown.peek();
      if (!current || pathKey(current.path) !== pathKey(path)) return;
      editTimer = cancel(editTimer);
      editTimer = setTimeout(() => {
        editTimer = null;
        edited.value = edited.peek() + 1;
      }, 200);
    }),
  );
  sub.add(
    toDisposable(() => {
      pending = cancel(pending);
      clearing = cancel(clearing);
      editTimer = cancel(editTimer);
      extensionFeatures.clearDecorations(OWNER);
    }),
  );
  return shown;
}
