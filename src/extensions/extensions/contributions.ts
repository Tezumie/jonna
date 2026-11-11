// An extension's declarative contributions (D102): color themes, languages with their TextMate
// grammars, and snippets. These work the same for our extensions and VS Code extensions (their
// package.json); files are read from the extension folder only when needed (a theme when picked,
// a grammar when a file of the language opens).

import { toBase64 } from "../../core/extensions/rpcAuthFs";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { asIconTheme } from "../../core/iconTheme/index";
import { asProductIconTheme } from "../../core/iconTheme/productIcons";
import { extIpc } from "../../core/ipc/extensions";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { parseJsoncOrThrow } from "../../core/settings/jsonc";
import { normalizeLanguageId } from "../../core/settings/languageOverrides";
import type {
  ColorThemeEntry,
  Contributions,
  GrammarEntry,
  IconThemeEntry,
  JsonSchemaEntry,
  LanguageEntry,
  SemanticTokenScopesEntry,
  SnippetEntry,
} from "../../workbench/contributions";

/** A font file as a data: URL (the page's CSP takes fonts from data: and its own origin). */
function fontDataUrl(file: string, bytes: Uint8Array): string {
  const type = /\.woff2$/i.test(file)
    ? "font/woff2"
    : /\.woff$/i.test(file)
      ? "font/woff"
      : /\.otf$/i.test(file)
        ? "font/otf"
        : "font/ttf";
  return `data:${type};base64,${toBase64(bytes)}`;
}

/** Reads a JSON (with comments) file of the extension. */
export async function readJson(root: string, path: string): Promise<unknown> {
  return parseJsoncOrThrow(await extIpc.readText(root, path), path);
}

const dirOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

/** Joins a path relative to `base`'s folder ("themes/a.json" + "./b.json" → "themes/b.json"). */
export function joinRelative(base: string, rel: string): string {
  const parts = `${dirOf(base)}${rel.replace(/^\.\//, "")}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (!out.length) throw new Error(`${rel} points outside the extension`);
      out.pop();
    } else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

/** A VS Code color theme with its `include` chain merged (base first), tokenColors files loaded. */
export async function loadColorTheme(root: string, path: string, depth = 0): Promise<unknown> {
  if (depth > 5) throw new Error("theme includes nest too deeply");
  const theme = (await readJson(root, path)) as Record<string, unknown>;
  let colors: Record<string, unknown> = {};
  let tokenColors: unknown[] = [];
  let semanticTokenColors: Record<string, unknown> = {};
  if (typeof theme.include === "string") {
    const base = (await loadColorTheme(root, joinRelative(path, theme.include), depth + 1)) as {
      colors?: Record<string, unknown>;
      tokenColors?: unknown[];
      semanticTokenColors?: Record<string, unknown>;
    };
    colors = { ...base.colors };
    tokenColors = [...(base.tokenColors ?? [])];
    semanticTokenColors = { ...base.semanticTokenColors };
  }
  if (typeof theme.tokenColors === "string") {
    if (!theme.tokenColors.endsWith(".json"))
      throw new Error(`${theme.tokenColors}: only JSON token color files are supported`);
    const file = (await readJson(root, joinRelative(path, theme.tokenColors))) as
      | unknown[]
      | { tokenColors?: unknown[]; settings?: unknown[] };
    tokenColors.push(...(Array.isArray(file) ? file : (file.tokenColors ?? file.settings ?? [])));
  } else if (Array.isArray(theme.tokenColors)) tokenColors.push(...theme.tokenColors);
  return {
    ...theme,
    include: undefined,
    colors: { ...colors, ...(theme.colors as Record<string, unknown> | undefined) },
    tokenColors,
    semanticTokenColors: {
      ...semanticTokenColors,
      ...(theme.semanticTokenColors as Record<string, unknown> | undefined),
    },
  };
}

interface VsCodeSnippet {
  prefix?: string | string[];
  body?: string | string[];
  description?: string | string[];
}

/** A VS Code snippets file → entries (one per prefix). */
export function parseSnippets(json: unknown, language: string, source: string): SnippetEntry[] {
  if (!json || typeof json !== "object") return [];
  const out: SnippetEntry[] = [];
  for (const [name, raw] of Object.entries(json as Record<string, VsCodeSnippet>)) {
    if (!raw || typeof raw !== "object") continue;
    const body = Array.isArray(raw.body) ? raw.body.join("\n") : raw.body;
    if (typeof body !== "string") continue;
    const prefixes = Array.isArray(raw.prefix) ? raw.prefix : [raw.prefix ?? name];
    const description = Array.isArray(raw.description)
      ? raw.description.join("\n")
      : (raw.description ?? "");
    for (const prefix of prefixes)
      if (typeof prefix === "string" && prefix)
        out.push({ language, name, prefix, body, description, source });
  }
  return out;
}

export function themeKind(uiTheme: string): "dark" | "light" {
  return uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
}

/**
 * Adds the extension's themes, languages and snippets. `warn` reports files that can't be used
 * (they're skipped; the rest still works).
 */
export async function addDeclarative(
  manifest: ThirdPartyManifest,
  root: string,
  contributions: Contributions,
  warn: (message: string) => void,
): Promise<Disposable> {
  const store = new DisposableStore();
  const c = manifest.contributes;
  const themes: ColorThemeEntry[] = c.themes.map((t) => ({
    label: t.label,
    kind: themeKind(t.uiTheme),
    source: manifest.id,
    load: () => loadColorTheme(root, t.path),
  }));
  store.add(contributions.addThemes(themes));
  // File icon themes: the JSON when picked, each image (or font) when first shown, as a blob URL.
  // Each load makes a theme's images anew: the previous ones are released a little later (the
  // icons on screen switch first), and all of them with the extension (D261).
  const release = (urls: Map<string, Promise<string>>) => {
    for (const u of urls.values()) void u.then((x) => URL.revokeObjectURL(x)).catch(() => {});
  };
  const iconThemes: IconThemeEntry[] = c.iconThemes.map((t) => {
    let current: Map<string, Promise<string>> | null = null;
    let previous: Map<string, Promise<string>> | null = null;
    let timer = 0;
    store.add(
      toDisposable(() => {
        window.clearTimeout(timer);
        for (const urls of [current, previous]) if (urls) release(urls);
      }),
    );
    return {
      id: t.id,
      label: t.label,
      source: manifest.id,
      load: async () => {
        const doc = asIconTheme(await readJson(root, t.path));
        const urls = new Map<string, Promise<string>>();
        if (previous) release(previous);
        previous = current;
        current = urls;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (previous) release(previous);
          previous = null;
        }, 10_000);
        const url = (rel: string) => {
          const file = joinRelative(t.path, rel);
          let u = urls.get(file);
          if (!u) {
            u = extIpc.read(root, file).then((bytes) => {
              // A font as a data: URL: the page's CSP takes fonts from data: only (D267).
              if (/\.(woff2?|[ot]tf)$/i.test(file)) return fontDataUrl(file, bytes);
              const type = /\.svg$/i.test(file)
                ? "image/svg+xml"
                : /\.png$/i.test(file)
                  ? "image/png"
                  : "application/octet-stream";
              return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
            });
            urls.set(file, u);
          }
          return u;
        };
        return { doc, url };
      },
    };
  });
  store.add(contributions.addIconThemes(iconThemes));
  // Product icon themes (D267): the JSON when picked, its fonts as data: URLs.
  store.add(
    contributions.addProductIconThemes(
      (c.productIconThemes ?? []).map((t) => ({
        id: t.id,
        label: t.label,
        source: manifest.id,
        load: async () => ({
          doc: asProductIconTheme(await readJson(root, t.path)),
          url: async (rel: string) => {
            const file = joinRelative(t.path, rel);
            return fontDataUrl(file, await extIpc.read(root, file));
          },
        }),
      })),
    ),
  );

  // Languages by the editor's ids (VS Code's "typescriptreact" is the editor's "tsx").
  const languages: LanguageEntry[] = c.languages.map((l) => ({
    id: normalizeLanguageId(l.id),
    extensions: (l.extensions ?? []).map((e) => e.toLowerCase()),
    filenames: l.filenames ?? [],
    aliases: l.aliases ?? [],
    ...(l.filenamePatterns?.length && { filenamePatterns: l.filenamePatterns }),
    ...(l.firstLine && { firstLine: l.firstLine }),
    ...(l.configuration && {
      configuration: () => readJson(root, l.configuration as string),
    }),
    source: manifest.id,
  }));
  store.add(contributions.addLanguages(languages));
  // Every grammar, a language's or not (injections, ones another extension's language uses).
  const grammars = c.grammars.flatMap((g): GrammarEntry[] => {
    if (!/\.json$/i.test(g.path)) {
      warn(`${g.path}: only JSON grammars are supported (convert .tmLanguage files to JSON)`);
      return [];
    }
    return [
      {
        scopeName: g.scopeName,
        ...(g.language && { language: normalizeLanguageId(g.language) }),
        ...(g.injectTo?.length && { injectTo: g.injectTo }),
        ...(g.embeddedLanguages && { embeddedLanguages: g.embeddedLanguages }),
        ...(g.tokenTypes && { tokenTypes: g.tokenTypes }),
        load: () => readJson(root, g.path),
        source: manifest.id,
      },
    ];
  });
  store.add(contributions.addGrammars(grammars));
  const superTypes = Object.fromEntries(
    (c.semanticTokenTypes ?? []).flatMap((t) => (t.superType ? [[t.id, t.superType]] : [])),
  );
  const tokenScopes: SemanticTokenScopesEntry[] = (c.semanticTokenScopes ?? []).map((e) => ({
    ...(e.language && { language: normalizeLanguageId(e.language) }),
    scopes: e.scopes,
    source: manifest.id,
  }));
  if (Object.keys(superTypes).length)
    tokenScopes.push({ scopes: {}, superTypes, source: manifest.id });
  store.add(contributions.addSemanticTokenScopes(tokenScopes));

  const snippets = (
    await Promise.all(
      c.snippets.map(async (s) => {
        try {
          return parseSnippets(await readJson(root, s.path), s.language, manifest.id);
        } catch (err) {
          warn(`${s.path}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }),
    )
  ).flat();
  store.add(contributions.addSnippets(snippets));
  // JSON schemas for files (VS Code's jsonValidation, D419): the editor's JSON service gets them.
  const jsonSchemas = (
    await Promise.all(
      (c.jsonValidation ?? []).map(async (v): Promise<JsonSchemaEntry[]> => {
        try {
          return [
            {
              uri: `ide://schemas/ext/${manifest.id}/${v.path}`,
              fileMatch: v.fileMatch,
              schema: await readJson(root, v.path),
              source: manifest.id,
            },
          ];
        } catch (err) {
          warn(`${v.path}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }),
    )
  ).flat();
  store.add(contributions.addJsonSchemas(jsonSchemas));
  // Problem matchers and patterns, by name, for tasks (`"problemMatcher": "$name"`).
  store.add(
    contributions.addProblemMatchers(
      c.problemMatchers.map((m) => ({
        name: m.name,
        definition: m.definition,
        source: manifest.id,
      })),
      c.problemPatterns.map((p) => ({ name: p.name, definition: p.pattern, source: manifest.id })),
    ),
  );
  return store;
}
