// Suggestions as you type (D106, D204): ghost text from the completion model, off unless
// editor.inlineCompletions.enabled. Toward Copilot / Cursor Tab: fill-in-the-middle where the
// provider has it (fim.ts, the agent's language model service picks the endpoint) and the chat
// prompt otherwise; a few snippets of context from other open files and recent edits
// (context.ts), all inside editor.inlineCompletions.contextTokens; one line in the middle of a
// line, several at its end; debounce, cancellation on the next key, an output cap. Tab accepts,
// Ctrl+Right accepts a word, "Accept line" a line; Alt+\ asks now. No telemetry: the request
// goes to the user's model and the usage log stays local (D201).

import { RECOMMENDED_COMPLETION_MODEL } from "../../../core/agent/completionModels";
import { fsIpc } from "../../../core/ipc/fs";
import type { DisposableStore } from "../../../core/lifecycle/index";
import { cancelSource } from "../../../core/lsp/jsonrpc";
import { pathToUri } from "../../../core/lsp/uri";
import { effect } from "../../../core/reactive/index";
import { s } from "../../../core/schema/index";
import type { WorkbenchServices } from "../../../workbench/services";
import { agentIgnored } from "../../agent/ignore";
import type { InlineCompletionSource } from "../engine";
import type { EditorService } from "../service";
import type { EditorView } from "../view";
import { GhostTextCache, LruMap } from "./cache";
import { RecentEdits, rankSnippets } from "./context";
import {
  buildChatPrompt,
  buildFimPrompt,
  cleanFim,
  expectsSingleLine,
  head,
  shapeCompletion,
  tail,
} from "./fim";
import {
  type DeclarationLocation,
  type DefinitionLookup,
  declarationFromDefinition,
  ImportGraph,
} from "./imports";
import { COMPLETE_SYSTEM, cleanCompletion } from "./prompts";
import { charsPerToken, estimateTokens, tokenizerProfile } from "./tokens";

/** Files bigger than this aren't kept for the recent-edits diff. */
const MAX_TRACKED_CHARS = 200_000;
/** Imported files bigger than this aren't read for context (a generated bundle). */
const MAX_IMPORTED_BYTES = 400_000;
/** Open files looked at for context (the most recently opened). */
const MAX_CONTEXT_DOCS = 20;
/** How long the language server gets to place the imported names (the request waits). */
const DEFINITION_TIMEOUT_MS = 700;

interface LastRequest {
  path: string;
  mode: "fim" | "chat";
  model: string | null;
  ms: number;
  chars: number;
  snippets: { path: string; kind: string }[];
  /** The prompt's size, estimated for the model's tokenizer family (D224). */
  promptTokens?: number;
  charsPerToken?: number;
  /** How imported names were placed (m7.12): by the file's language server, or the regex. */
  importsVia?: "server" | "regex";
  at: number;
  error?: string;
}

export function registerInlineCompletions(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  activeView: () => EditorView | undefined,
): void {
  const { settings, languageModel, context, dispatcher, workspace } = services;
  const enabled = () => settings.peek<boolean>("editor.inlineCompletions.enabled") === true;
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = settings.peek<number>(key);
    return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  // Compared as the OS does (a `c:\` from Monaco is in `C:\`); with several folders, the
  // folder's name first (D251).
  const rel = (path: string) => (workspace.root.peek() ? workspace.relative(path) : path);
  let last: LastRequest | null = null;

  // ---- Recent edits (only while on: nothing is kept otherwise) ----
  const edits = new RecentEdits();
  const snapshots = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const textOf = (path: string) =>
    editors.find(path)?.model.peek()?.getText().replace(/\r\n/g, "\n");
  sub.add(
    editors.onDidChangeText((path) => {
      if (!enabled() || path.startsWith("virtual:")) return;
      clearTimeout(timers.get(path));
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path);
          const now = textOf(path);
          if (now === undefined) {
            // Closed: forget it.
            snapshots.delete(path);
            edits.moved(path, null);
            return;
          }
          if (now.length > MAX_TRACKED_CHARS) return;
          const before = snapshots.get(path);
          if (before !== undefined) edits.record(path, before, now);
          snapshots.set(path, now);
        }, 1000),
      );
    }),
  );
  // A file's first text is its "before" (its first change is then an edit).
  sub.add(
    effect(() => {
      const docs = editors.documents.value;
      settings.version.value;
      if (!enabled()) return undefined;
      // Closed files' texts go (up to 200 KB each, kept for the whole session otherwise).
      const open = new Set(docs.map((d) => d.path.peek()));
      for (const path of snapshots.keys()) if (!open.has(path)) snapshots.delete(path);
      for (const d of docs) {
        const path = d.path.peek();
        if (snapshots.has(path)) continue;
        const text = d.model.peek()?.getText().replace(/\r\n/g, "\n");
        if (text !== undefined && text.length <= MAX_TRACKED_CHARS) snapshots.set(path, text);
      }
      return undefined;
    }),
  );
  sub.add(services.events.on("files.didRename", ({ from, to }) => edits.moved(from, to)));
  sub.add(services.events.on("files.didDelete", ({ path }) => edits.moved(path, null)));
  sub.add({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
    },
  });

  // Files kept from AI (.aiignore, .cursorignore, agent.ignoreFiles, secrets such as .env, D199)
  // are neither completed in nor sent along as context, as Cursor's Tab skips them.
  const hidden = (path: string) => agentIgnored(services, path);
  const otherDocuments = (path: string) =>
    editors.documents
      .peek()
      .filter((d) => d.kind === "text" && d.path.peek() !== path && !hidden(d.path.peek()))
      .slice(-MAX_CONTEXT_DOCS)
      .flatMap((d) => {
        const text = d.model.peek()?.getText();
        return text === undefined ? [] : [{ path: d.path.peek(), text }];
      });

  // ---- Imported files (D224): read through the backend, cached until they change ----
  const decoder = new TextDecoder("utf-8");
  const imports = new ImportGraph(
    async (path) => {
      const stat = await fsIpc.stat(path).catch(() => null);
      if (stat?.kind !== "file" || stat.size > MAX_IMPORTED_BYTES) return null;
      const text = decoder.decode(await fsIpc.read(path));
      // Binary (a NUL in the first part): not context.
      return text.slice(0, 8000).includes("\u0000") ? null : text;
    },
    (path) => textOf(path),
  );
  // Where the server placed a name, by file, position and name: asked again after any file
  // changes (a declaration may have moved), or after half a minute.
  const placed = new LruMap<string, DeclarationLocation>(256, 30_000);
  sub.add(
    services.events.on("files.didSave", ({ path }) => {
      imports.invalidate(path);
      placed.clear();
    }),
  );
  sub.add(
    services.events.on("files.didChange", ({ path }) => {
      imports.invalidate(path);
      placed.clear();
    }),
  );
  sub.add(
    services.events.on("files.didDelete", ({ path }) => {
      imports.invalidate(path);
      placed.clear();
    }),
  );
  sub.add(
    services.events.on("files.didRename", ({ from }) => {
      imports.invalidate(from);
      imports.forgetMissing();
      placed.clear();
    }),
  );
  sub.add(services.events.on("files.didCreate", () => imports.forgetMissing()));

  // ---- The file's language server places imported names (m7.12; the regex is the fallback) ----
  const serverLookup = (
    path: string,
    languageId: string,
    signal: AbortSignal,
  ): DefinitionLookup | undefined => {
    // The editor's binding keys documents by Monaco's path (a lower-case drive on Windows).
    const forms = [path, path.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`)];
    for (const client of services.languageClients.clients.peek()) {
      if (client.state !== "running" || !client.handles(languageId)) continue;
      if (!client.capabilities.definitionProvider) continue;
      const open = forms.find((f) => client.isOpen(f));
      if (!open) continue;
      return async (sites) => {
        const keyOf = (site: (typeof sites)[number]) =>
          `${client.options.id}|${open}|${site.line}:${site.character}|${site.name}`;
        if (sites.every((site) => placed.has(keyOf(site))))
          return sites.map((site) => placed.get(keyOf(site)) ?? null);
        // The edit just typed reaches the server first.
        client.flushDocument?.(open);
        const uri = pathToUri(open);
        const token = cancelSource();
        const cancel = () => token.cancel();
        const timer = setTimeout(cancel, DEFINITION_TIMEOUT_MS);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          return await Promise.all(
            sites.map((site) => {
              const known = placed.get(keyOf(site));
              if (known) return known;
              return client
                .request<unknown>(
                  "textDocument/definition",
                  {
                    textDocument: { uri },
                    position: { line: site.line, character: site.character },
                  },
                  token,
                )
                .then(declarationFromDefinition, (): DeclarationLocation | null => null)
                .then((found) => {
                  if (found) placed.set(keyOf(site), found);
                  return found;
                });
            }),
          );
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
        }
      };
    }
    return undefined;
  };

  // ---- Suggestion cache (D224): typing through a suggestion doesn't ask again ----
  const cache = new GhostTextCache();
  let requests = 0;

  const source: InlineCompletionSource = {
    delayMs: () => num("editor.inlineCompletions.debounceMs", 350, 0, 5000),
    cached: ({ path, prefix, suffix }) => {
      const model = languageModel.model("completion");
      if (!model || hidden(path)) return undefined;
      return cache.get({ path, model, prefix, suffix })?.text;
    },
    hasCached: ({ path, prefix, suffix }) => {
      const model = languageModel.model("completion");
      if (!model || hidden(path)) return false;
      return !!cache.peek({ path, model, prefix, suffix })?.text;
    },
    complete: async ({ path, languageId, prefix, suffix, line, signal }) => {
      const model = languageModel.model("completion");
      if (!model || hidden(path)) return null;
      const started = performance.now();
      const useContext = settings.peek<boolean>("editor.inlineCompletions.context") !== false;
      const definitions = useContext ? serverLookup(path, languageId, signal) : undefined;
      const imported = useContext
        ? await imports
            .snippets({
              path,
              languageId,
              text: textOf(path) ?? prefix,
              prefix,
              // The file's own folder (its tsconfig paths, node_modules; D251).
              root: workspace.folderOf(path)?.path ?? workspace.root.peek(),
              skip: hidden,
              definitions,
            })
            .catch(() => [])
        : [];
      if (signal.aborted) return null;
      const snippets = useContext
        ? rankSnippets({
            current: { path, prefix, suffix },
            documents: otherDocuments(path),
            edits: edits.all().filter((e) => !hidden(e.path)),
            imports: imported,
            ...(line !== undefined && { cursorLine: line }),
          }).map((s) => ({ ...s, path: rel(s.path) }))
        : [];
      const ctx = { path: rel(path), languageId, prefix, suffix, snippets };
      const budget = num("editor.inlineCompletions.contextTokens", 1536, 256, 32_000);
      // The budget in characters for this model's tokenizer and this code (tokens.ts).
      const profile = tokenizerProfile(model);
      const ratio = charsPerToken(`${tail(prefix, 6000)}${head(suffix, 1500)}`, profile);
      const maxTokens = num("editor.inlineCompletions.maxTokens", 128, 8, 2048);
      const maxLines = num("editor.inlineCompletions.maxLines", 8, 1, 100);
      const single = expectsSingleLine(suffix);
      let mode: "fim" | "chat" = "fim";
      let text: string | null = null;
      let promptText = "";
      try {
        if (languageModel.fill) {
          const fim = buildFimPrompt(ctx, budget, ratio);
          promptText = fim.prompt + fim.suffix;
          requests++;
          const middle = await languageModel.fill({
            prompt: fim.prompt,
            suffix: fim.suffix,
            maxTokens,
            ...(single && { stop: ["\n"] }),
            signal,
          });
          if (middle !== null) text = cleanFim(middle);
        }
        if (text === null && !signal.aborted) {
          mode = "chat";
          promptText = buildChatPrompt(ctx, budget, ratio);
          requests++;
          const reply = await languageModel.generate({
            purpose: "completion",
            system: COMPLETE_SYSTEM,
            prompt: promptText,
            maxTokens,
            signal,
          });
          text = signal.aborted ? null : cleanCompletion(reply, prefix, suffix);
        }
      } catch (err) {
        last = {
          path: rel(path),
          mode,
          model,
          ms: Math.round(performance.now() - started),
          chars: 0,
          snippets: [],
          at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
        return null;
      }
      if (signal.aborted || text === null) return null;
      const shaped = shapeCompletion(text, suffix, maxLines);
      // Remembered where it was asked: typing it, or coming back here, shows it without a request.
      cache.put({ path, model, prefix, suffix }, shaped);
      last = {
        path: rel(path),
        mode,
        model,
        ms: Math.round(performance.now() - started),
        chars: shaped?.length ?? 0,
        snippets: snippets.map((s) => ({ path: s.path, kind: s.kind })),
        promptTokens: estimateTokens(promptText, profile),
        charsPerToken: Math.round(ratio * 100) / 100,
        ...(useContext && { importsVia: definitions ? ("server" as const) : ("regex" as const) }),
        at: Date.now(),
      };
      return shaped;
    },
  };

  // Off unless the user turns it on (each pause in typing is a model request).
  sub.add(
    effect(() => {
      settings.version.value;
      const on = enabled();
      context.set("aiInlineCompletions", on);
      if (!on) {
        snapshots.clear();
        edits.clear();
        cache.clear();
        imports.invalidate();
        placed.clear();
      }
      editors.whenEngine((engine) => engine.setInlineCompletions(on ? source : null));
      return undefined;
    }),
  );

  // ---- Commands (the keys run them; agents and scripts too) ----
  const action = (id: string, title: string, description: string, engineAction: string) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Edit",
        description,
        input: s.empty(),
        effects: id.endsWith("trigger") || id.endsWith("hide") ? [] : ["write"],
        when: "aiInlineCompletions",
        agent: "hidden",
        run: async () => {
          const editor = activeView()?.engineEditor;
          if (!editor) throw new Error("No editor is active.");
          if (!enabled())
            throw new Error("Suggestions as you type are off (editor.inlineCompletions.enabled).");
          return { ran: await editor.runAction(engineAction) };
        },
      }),
    );
  action(
    "editor.inlineSuggest.trigger",
    "Suggest code here",
    "Asks the completion model for a suggestion (ghost text) at the cursor now, without waiting for a pause in typing.",
    "editor.action.inlineSuggest.trigger",
  );
  action(
    "editor.inlineSuggest.accept",
    "Accept suggestion",
    "Inserts the whole ghost-text suggestion shown at the cursor (Tab).",
    "editor.action.inlineSuggest.commit",
  );
  action(
    "editor.inlineSuggest.acceptWord",
    "Accept next word of suggestion",
    "Inserts the next word of the ghost-text suggestion (Ctrl+Right), keeping the rest shown.",
    "editor.action.inlineSuggest.acceptNextWord",
  );
  action(
    "editor.inlineSuggest.acceptLine",
    "Accept next line of suggestion",
    "Inserts the next line of the ghost-text suggestion, keeping the rest shown.",
    "editor.action.inlineSuggest.acceptNextLine",
  );
  action(
    "editor.inlineSuggest.hide",
    "Hide suggestion",
    "Dismisses the ghost-text suggestion (Esc).",
    "editor.action.inlineSuggest.hide",
  );

  sub.add(
    services.state.register("ide://editor/inlineCompletions", {
      description:
        "Suggestions as you type (ghost text): whether they're on, the model (and whether it came from the setting, was picked as a small local code model, or is the agent's), the FIM endpoint it gets (null: the chat prompt), the limits, the tokenizer family the budget is estimated for, how many model requests were made and how often the suggestion cache answered instead (typing through a suggestion doesn't ask again), and the last request (fim or chat, time, length, estimated prompt tokens, the context snippets it carried: open, edit or import, and importsVia: whether the file's language server placed the imported names or the regex did).",
      get: () => {
        const info = languageModel.completionInfo?.() ?? {
          model: languageModel.model("completion"),
          fim: null,
          picked: null,
        };
        return {
          enabled: enabled(),
          ...info,
          fimMode: settings.peek<string>("editor.inlineCompletions.fim") ?? "auto",
          maxTokens: num("editor.inlineCompletions.maxTokens", 128, 8, 2048),
          contextTokens: num("editor.inlineCompletions.contextTokens", 1536, 256, 32_000),
          debounceMs: num("editor.inlineCompletions.debounceMs", 350, 0, 5000),
          recentEdits: edits.all().length,
          tokenizer: tokenizerProfile(info.model).name,
          requests,
          cache: { size: cache.size, hits: cache.hits, misses: cache.misses },
          ...(info.picked === "default" && {
            recommendation: `For fast suggestions, install a small code model: ollama pull ${RECOMMENDED_COMPLETION_MODEL}`,
          }),
          last,
        };
      },
    }),
  );
}
