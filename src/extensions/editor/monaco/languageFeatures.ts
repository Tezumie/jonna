// Language services from monaco-editor (D56): TypeScript/JavaScript, JSON, CSS/SCSS/Less and HTML
// run in their own workers, loaded the first time a file of that language opens. Syntax colors stay
// Shiki's (the JSON service's own tokenizer is turned off). `.tsx`/`.jsx` keep their own language
// ids for Shiki's JSX grammars and get the TS/JS providers here, sharing the TS/JS worker.

import { ILanguageService } from "monaco-editor/editor/common/languages/language.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { type JSONSchema, jsonDefaults } from "monaco-editor/languages/features/json/register.js";
import {
  JsxEmit,
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from "monaco-editor/languages/features/typescript/register.js";
import type { JsonSchemaAssociation } from "../engine";
import * as monaco from "./core";

/**
 * Without the project's files on disk the TS worker only knows open editors, so "cannot find
 * module" (2307, 2792), "no declaration file" (7016) and "no JSX.IntrinsicElements" (7026,
 * without React types) would flag every import and tag; imported names
 * become `any` instead.
 */
const IGNORED_TS_DIAGNOSTICS = [2307, 2792, 7016, 7026];

/** The tsx/jsx providers, and how to register them again (setBuiltinTypeScript). */
const variantProviders = new Map<string, monaco.IDisposable[]>();
const variantRegistrars = new Map<string, () => void>();
const diagnosticsStarted = new Set<string>();
let builtinTypeScript = true;
let savedModes: { ts: unknown; js: unknown } | null = null;

/**
 * Turns Monaco's own TypeScript/JavaScript service off while a project-wide language server
 * (typescript-language-server) handles those files, and back on when it stops (D199): two
 * services would give every completion, hover and error twice.
 */
let tsServers = 0;

/**
 * A project-wide TypeScript server took over; dispose when it stops. Counted, so two clients (or
 * a restart that attaches the new one before the old one is gone) keep the built-in service off.
 */
export function replaceBuiltinTypeScript(): monaco.IDisposable {
  tsServers++;
  setBuiltinTypeScript(false);
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      tsServers--;
      if (tsServers === 0) setBuiltinTypeScript(true);
    },
  };
}

/** Whether Monaco's own TypeScript service is checking TS/JS (checkText needs it). */
export function builtinTypeScriptOn(): boolean {
  return builtinTypeScript;
}

/**
 * The built-in TypeScript providers' methods, by adapter: they answer nothing while a project
 * server has taken over (D379). Monaco 0.57's TS mode registers its providers once, when the first
 * TS/JS file opens, and never looks at `setModeConfiguration` again: with a file open before the
 * server started (an untrusted folder trusted, the server installed), every symbol, hover,
 * completion and reference came twice, the server's and the built-in one's.
 */
const BUILTIN_METHODS: Record<string, string[]> = {
  SuggestAdapter: ["provideCompletionItems"],
  SignatureHelpAdapter: ["provideSignatureHelp"],
  QuickInfoAdapter: ["provideHover"],
  DocumentHighlightAdapter: ["provideDocumentHighlights"],
  DefinitionAdapter: ["provideDefinition"],
  ReferenceAdapter: ["provideReferences"],
  OutlineAdapter: ["provideDocumentSymbols"],
  RenameAdapter: ["provideRenameEdits"],
  FormatAdapter: ["provideDocumentRangeFormattingEdits"],
  FormatOnTypeAdapter: ["provideOnTypeFormattingEdits"],
  CodeActionAdaptor: ["provideCodeActions"],
  InlayHintsAdapter: ["provideInlayHints"],
};
let adaptersGuarded = false;
/** The adapters' own methods, for answering when the server couldn't (builtinCompletions). */
const originals = new Map<string, (...args: unknown[]) => unknown>();

/**
 * The built-in service's completions, asked directly (D380): the server failed this request, and
 * the built-in provider is silent while a server runs.
 */
export async function builtinCompletions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  context: monaco.languages.CompletionContext,
  token: monaco.CancellationToken,
): Promise<monaco.languages.CompletionList | null> {
  const mode = (await import("monaco-editor/languages/features/typescript/tsMode.js")) as Record<
    string,
    unknown
  >;
  const original = originals.get("SuggestAdapter.provideCompletionItems");
  const Suggest = mode.SuggestAdapter as (new (worker: unknown) => object) | undefined;
  if (!original || !Suggest) return null;
  const js = /^(javascript|jsx)$/.test(model.getLanguageId());
  const get = (js ? mode.getJavaScriptWorker : mode.getTypeScriptWorker) as () => Promise<
    (...uris: unknown[]) => Promise<unknown>
  >;
  const worker = (...uris: unknown[]) => get().then((w) => w(...uris));
  try {
    return (await original.call(
      new Suggest(worker),
      model,
      position,
      context,
      token,
    )) as monaco.languages.CompletionList | null;
  } catch {
    return null;
  }
}

function guardBuiltinAdapters(mode: Record<string, unknown>): void {
  if (adaptersGuarded) return;
  adaptersGuarded = true;
  for (const [name, methods] of Object.entries(BUILTIN_METHODS)) {
    const proto = (mode[name] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    if (!proto) continue;
    for (const method of methods) {
      const original = proto[method];
      if (typeof original !== "function") continue;
      originals.set(`${name}.${method}`, original as (...args: unknown[]) => unknown);
      proto[method] = function (this: unknown, ...args: unknown[]) {
        if (!builtinTypeScript)
          return Promise.resolve(method === "provideCompletionItems" ? { suggestions: [] } : null);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  }
}

function setBuiltinTypeScript(on: boolean): void {
  if (on === builtinTypeScript) return;
  builtinTypeScript = on;
  if (!on) {
    void import("monaco-editor/languages/features/typescript/tsMode.js")
      .then((mode) => guardBuiltinAdapters(mode as Record<string, unknown>))
      .catch(() => {});
    savedModes = {
      ts: typescriptDefaults.modeConfiguration,
      js: javascriptDefaults.modeConfiguration,
    };
    const off = Object.fromEntries(
      Object.keys(typescriptDefaults.modeConfiguration).map((k) => [k, false]),
    );
    typescriptDefaults.setModeConfiguration(off);
    javascriptDefaults.setModeConfiguration(off);
    for (const defaults of [typescriptDefaults, javascriptDefaults])
      defaults.setDiagnosticsOptions({
        ...defaults.getDiagnosticsOptions(),
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
    for (const list of variantProviders.values()) for (const d of list) d.dispose();
    variantProviders.clear();
    // Markers the built-in service left.
    for (const model of monaco.editor.getModels())
      for (const owner of ["typescript", "javascript", "tsx", "jsx"])
        monaco.editor.setModelMarkers(model, owner, []);
    return;
  }
  if (savedModes) {
    typescriptDefaults.setModeConfiguration(savedModes.ts as never);
    javascriptDefaults.setModeConfiguration(savedModes.js as never);
  }
  for (const defaults of [typescriptDefaults, javascriptDefaults])
    defaults.setDiagnosticsOptions({
      ...defaults.getDiagnosticsOptions(),
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: false,
    });
  for (const register of variantRegistrars.values()) register();
}

export function configureLanguageFeatures(): void {
  jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false });
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    comments: "ignore",
    trailingCommas: "ignore",
    enableSchemaRequest: false, // offline: no schema downloads
    schemas: [],
  });
  const compilerOptions = {
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    jsx: JsxEmit.Preserve,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true,
  };
  typescriptDefaults.setCompilerOptions(compilerOptions);
  javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setDiagnosticsOptions({
      ...defaults.getDiagnosticsOptions(),
      diagnosticCodesToIgnore: IGNORED_TS_DIAGNOSTICS,
    });
  }
  registerJsonc();
  registerJsxVariant("tsx", "typescript");
  registerJsxVariant("jsx", "javascript");
}

/** settings.json / keybindings.json validation and completion. */
export function setJsonSchemas(associations: readonly JsonSchemaAssociation[]): void {
  jsonDefaults.setDiagnosticsOptions({
    ...jsonDefaults.diagnosticsOptions,
    schemas: associations.map((a) => ({
      uri: a.uri,
      fileMatch: [...a.files.map((f) => monaco.Uri.file(f).toString()), ...(a.patterns ?? [])],
      schema: a.schema as JSONSchema,
    })),
  });
}

/**
 * `jsonc` (tsconfig.json, settings.json…) keeps its own id for the status bar and Shiki's JSONC
 * grammar; it gets the JSON service with the same options (comments allowed) and schemas.
 */
function registerJsonc(): void {
  const jsonc = {
    get languageId() {
      return "jsonc";
    },
    get modeConfiguration() {
      return jsonDefaults.modeConfiguration;
    },
    get diagnosticsOptions() {
      return jsonDefaults.diagnosticsOptions;
    },
    onDidChange: (listener: (d: unknown) => void) =>
      jsonDefaults.onDidChange(() => listener(jsonc)),
  };
  monaco.languages.onLanguage("jsonc", () => {
    void import("monaco-editor/languages/features/json/jsonMode.js")
      .then((mode) => mode.setupMode(jsonc))
      .catch((err: unknown) => console.warn("jsonc language features unavailable", err));
  });
}

/**
 * Registers the TS mode's providers for `variant` (tsx/jsx), reusing the worker of `base`.
 * The worker is created by requesting `base`'s rich language features, which is what fires
 * `register.js`'s own `onLanguage(base)` hook (the only place that sets up `base`). Creating a
 * model of `base` isn't enough: that only requests basic features, so a project whose first
 * file was a .tsx never got its TS worker — no definitions, symbols or breadcrumbs (D116).
 */
function registerJsxVariant(variant: "tsx" | "jsx", base: "typescript" | "javascript"): void {
  monaco.languages.onLanguage(variant, () => {
    void (async () => {
      const mode = await import("monaco-editor/languages/features/typescript/tsMode.js");
      StandaloneServices.get(ILanguageService).requestRichLanguageFeatures(base);
      // register.js sets `base` up asynchronously (loading its own chunk): wait until its worker
      // exists, generously — a slow cold start shouldn't leave .tsx without its features.
      let worker: unknown;
      const started = Date.now();
      while (!worker && Date.now() - started < 20_000) {
        worker = await (base === "typescript"
          ? mode.getTypeScriptWorker()
          : mode.getJavaScriptWorker()
        ).catch(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 50)));
      }
      if (!worker) throw new Error(`${base} worker did not start`);
      const defaults = base === "typescript" ? typescriptDefaults : javascriptDefaults;
      const libFiles = new mode.LibFiles(worker);
      const L = monaco.languages;
      // Registered while the built-in service is in use; a project-wide server replaces them (D199).
      const register = () => {
        variantProviders.get(variant)?.forEach((d) => {
          d.dispose();
        });
        const list: monaco.IDisposable[] = [
          L.registerCompletionItemProvider(variant, new mode.SuggestAdapter(worker)),
          L.registerSignatureHelpProvider(variant, new mode.SignatureHelpAdapter(worker)),
          L.registerHoverProvider(variant, new mode.QuickInfoAdapter(worker)),
          L.registerDocumentHighlightProvider(variant, new mode.DocumentHighlightAdapter(worker)),
          L.registerDefinitionProvider(variant, new mode.DefinitionAdapter(libFiles, worker)),
          L.registerReferenceProvider(variant, new mode.ReferenceAdapter(libFiles, worker)),
          L.registerDocumentSymbolProvider(variant, new mode.OutlineAdapter(worker)),
          L.registerRenameProvider(variant, new mode.RenameAdapter(libFiles, worker)),
          L.registerDocumentRangeFormattingEditProvider(variant, new mode.FormatAdapter(worker)),
          L.registerOnTypeFormattingEditProvider(variant, new mode.FormatOnTypeAdapter(worker)),
          L.registerCodeActionProvider(variant, new mode.CodeActionAdaptor(worker)),
          L.registerInlayHintsProvider(variant, new mode.InlayHintsAdapter(worker)),
        ];
        // The diagnostics adapter has no dispose of its own here; it follows `defaults` (whose
        // diagnostics switch off with the built-in service).
        if (!diagnosticsStarted.has(variant)) {
          diagnosticsStarted.add(variant);
          new mode.DiagnosticsAdapter(libFiles, defaults, variant, worker);
        }
        variantProviders.set(variant, list);
      };
      variantRegistrars.set(variant, register);
      if (builtinTypeScript) register();
    })().catch((err: unknown) => console.warn(`${variant} language features unavailable`, err));
  });
}

// ---- Emmet (D199) ----
// emmet-monaco-es (MIT): abbreviations as completions (div.card>ul>li*3, then Tab or Enter), in
// HTML-like files, stylesheets and JSX/TSX, as in VS Code. Loaded the first time it's on.
const HTML_LIKE = new Set(["html", "vue", "svelte", "php", "astro", "handlebars", "xml"]);
const STYLESHEETS = new Set(["css", "scss", "less", "sass"]);
const JSX = new Set(["jsx", "tsx"]);
let emmetOff: (() => void)[] = [];
let emmetWanted = "";

export function setEmmet(languages: readonly string[]): void {
  const key = [...languages].sort().join(",");
  if (key === emmetWanted) return;
  emmetWanted = key;
  for (const off of emmetOff) off();
  emmetOff = [];
  if (!languages.length) return;
  void import("emmet-monaco-es")
    .then(({ emmetHTML, emmetCSS, emmetJSX }) => {
      if (emmetWanted !== key) return;
      // Shiki colors the text, not a Monarch tokenizer: emmet reads the text itself.
      const options = { tokenizer: "standard" as const };
      const pick = (set: Set<string>) => languages.filter((l) => set.has(l));
      const m = monaco as unknown as Parameters<typeof emmetHTML>[0];
      if (pick(HTML_LIKE).length) emmetOff.push(emmetHTML(m, pick(HTML_LIKE), options));
      if (pick(STYLESHEETS).length) emmetOff.push(emmetCSS(m, pick(STYLESHEETS), options));
      if (pick(JSX).length) emmetOff.push(emmetJSX(m, pick(JSX), options));
    })
    .catch((err: unknown) => console.warn("Emmet unavailable", err));
}
