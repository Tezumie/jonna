// Models for files that aren't open, so peek views (references, definitions) can preview them.
// They are read-only copies, never synced to language servers; opening the file replaces them.
import type { EngineHost } from "../engine";
import { languageForPath } from "../languages";
import * as monaco from "./core";

/** At most this many peek-only models live at once; one peek asks for at most as many. */
const MAX_PEEK_MODELS = 50;

/**
 * Peek-only models, least recently asked for first. Without a bound every peek over new files
 * leaked up to 50 models for the session. Only models created here are listed: a model of an
 * open document is never peek-only (opening a file disposes the peek copy and makes its own).
 */
const peekModels = new Map<string, monaco.editor.ITextModel>();

export function isPeekOnly(model: monaco.editor.ITextModel): boolean {
  return peekModels.get(model.uri.toString()) === model;
}

/** Disposes every peek-only model (the workspace closed). */
export function disposePeekModels(): void {
  for (const model of [...peekModels.values()]) model.dispose();
  peekModels.clear();
}

function track(model: monaco.editor.ITextModel): void {
  const key = model.uri.toString();
  peekModels.set(key, model);
  const sub = model.onWillDispose(() => {
    sub.dispose();
    if (peekModels.get(key) === model) peekModels.delete(key);
  });
}

/** Marks a peek model as just used (moves it to the newest end). */
function touch(model: monaco.editor.ITextModel): void {
  const key = model.uri.toString();
  if (peekModels.get(key) !== model) return;
  peekModels.delete(key);
  peekModels.set(key, model);
}

function evict(): void {
  while (peekModels.size > MAX_PEEK_MODELS) {
    const oldest = peekModels.values().next().value;
    if (!oldest) return;
    oldest.dispose(); // its onWillDispose removes it from the map
  }
}

export async function ensureModels(host: EngineHost, paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].slice(0, MAX_PEEK_MODELS);
  const missing: string[] = [];
  for (const path of unique) {
    const existing = monaco.editor.getModel(monaco.Uri.file(path));
    // Still in use for this peek: keep it out of the eviction below.
    if (existing) touch(existing);
    else missing.push(path);
  }
  await Promise.all(
    missing.map(async (path) => {
      const text = await host.readFile(path);
      const uri = monaco.Uri.file(path);
      if (text === null || monaco.editor.getModel(uri)) return;
      track(monaco.editor.createModel(text, languageForPath(path), uri));
    }),
  );
  evict();
}
