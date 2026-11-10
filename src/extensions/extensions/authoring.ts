// Tools for building extensions, mostly for agents (D191, wishlist 11–13 and 15): check a
// manifest before loading it (extensions.validate), its JSON Schema (extensions.manifestSchema),
// run one of its commands and get the log lines it wrote (extensions.try), and small working
// examples to copy (extensions.examples).
import { manifestSchema } from "../../core/extensions/manifestSchema";
import { parseManifest } from "../../core/extensions/thirdParty";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { EXAMPLES, exampleText } from "./examples";
import type { ExtensionManager } from "./manager";

const decode = (b: Uint8Array) => new TextDecoder().decode(b).replace(/^﻿/, "");

async function exists(path: string): Promise<boolean> {
  return fsIpc.stat(path).then(
    () => true,
    () => false,
  );
}

/** Line and column of a JSON.parse error position, when the message has one. */
function jsonPosition(text: string, message: string): string {
  const at = Number(message.match(/position (\d+)/)?.[1]);
  if (!Number.isFinite(at)) return "";
  const before = text.slice(0, at);
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return ` (line ${line}, column ${column})`;
}

export interface ValidationReport {
  ok: boolean;
  manifest: string | null;
  id?: string;
  errors: string[];
  warnings: string[];
}

/** Checks an extension folder the way loading it would, and more (files it names exist). */
export async function validateFolder(folder: string): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let file: string | null = null;
  for (const name of ["extension.json", "package.json"])
    if (await exists(joinPath(folder, name))) {
      file = name;
      break;
    }
  if (!file)
    return {
      ok: false,
      manifest: null,
      errors: ["No extension.json in this folder (start new extensions with extensions.create)."],
      warnings,
    };
  const text = decode(await fsIpc.read(joinPath(folder, file)));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      manifest: file,
      errors: [`${file} isn't valid JSON: ${message}${jsonPosition(text, message)}`],
      warnings,
    };
  }
  let manifest: ReturnType<typeof parseManifest>;
  try {
    manifest = parseManifest(json, file);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/^[^:]*: /, "");
    return { ok: false, manifest: file, errors: message.split("; "), warnings };
  }
  // Fields the parser doesn't know (an invented field is ignored silently otherwise).
  const known = new Set(Object.keys((manifestSchema().properties as object) ?? {}));
  if (file === "extension.json" && json && typeof json === "object")
    for (const key of Object.keys(json))
      if (!known.has(key)) warnings.push(`Unknown field "${key}": it's ignored.`);
  // Files it names.
  const files: [string, string][] = [];
  if (manifest.main) files.push([manifest.main, "main"]);
  if (manifest.icon) files.push([manifest.icon, "icon"]);
  for (const v of manifest.contributes.views) if (v.path) files.push([v.path, `view ${v.id}`]);
  for (const v of manifest.contributes.viewers) if (v.path) files.push([v.path, `viewer ${v.id}`]);
  for (const shot of manifest.screenshots) files.push([shot.path, "screenshot"]);
  for (const [rel, what] of files)
    if (!(await exists(joinPath(folder, rel)))) errors.push(`${what}: ${rel} doesn't exist.`);
  if (!manifest.main && manifest.contributes.commands.length)
    warnings.push("It declares commands but has no main.js to run them.");
  return { ok: errors.length === 0, manifest: file, id: manifest.id, errors, warnings };
}

export function registerAuthoringCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
): void {
  const register: typeof services.dispatcher.register = (c) =>
    sub.add(services.dispatcher.register({ category: "Extensions", palette: false, ...c }));

  register({
    id: "extensions.validate",
    title: "Validate extension",
    description:
      "Checks an extension folder before (or after) loading it: the manifest's JSON, every field error the loader would report, unknown fields, and that the files it names (main, views, viewers, icon, screenshots) exist. `folder` is absolute or relative to the open folder; or `id` of a loaded one.",
    input: s.object({
      folder: s.string().optional(),
      id: s.string().optional(),
    }),
    effects: ["read"],
    run: async ({ folder, id }) => {
      const { workspace } = services;
      const root = workspace.root.peek();
      const path = id
        ? manager.require(id).root
        : folder && root
          ? workspace.resolve(folder)
          : folder;
      if (!path) throw new Error('Give "folder" (or "id").');
      // Any of the workspace's folders (D251).
      if (!id && root && !workspace.contains(path))
        throw new Error(
          workspace.folders.peek().length > 1
            ? "Only folders inside the workspace's folders can be checked by path."
            : "Only folders inside the open folder can be checked by path.",
        );
      return validateFolder(path);
    },
  });

  register({
    id: "extensions.manifestSchema",
    title: "Extension manifest schema",
    description:
      "The JSON Schema of extension.json: every field the IDE reads, with descriptions. The editor validates manifests in an extensions folder with it.",
    input: s.empty(),
    effects: ["read"],
    run: () => manifestSchema(),
  });

  register({
    id: "extensions.try",
    title: "Try an extension command",
    description:
      "Runs one of a (development) extension's own commands and returns its result or error, plus the log lines the extension wrote meanwhile (console output, errors, denied requests) — the build, run, read-log loop in one call. Changing commands still ask the user as usual.",
    input: s.object({
      id: s.string().describe("Extension id"),
      command: s.string().describe("One of its commands"),
      input: s.unknown().describe("The command's input").optional(),
      waitMs: s
        .integer({ min: 0, max: 5000 })
        .describe("Wait for late log lines (default 300)")
        .optional(),
    }),
    // Asking is the command's own business (it runs as the caller), not this wrapper's.
    effects: ["read"],
    run: async ({ id, command, input, waitMs }, ctx) => {
      const record = manager.require(id);
      const own = record.manifest?.contributes.commands.map((c) => c.id) ?? [];
      if (!own.includes(command))
        throw new Error(
          `${command} isn't a command of ${id}. Its commands: ${own.join(", ") || "none"}.`,
        );
      if (record.status !== "active")
        throw new Error(
          `${id} isn't running (${record.status}${record.error ? `: ${record.error}` : ""}). See extensions.validate and ide://extensions.`,
        );
      const since = Date.now();
      let result: unknown;
      let error: string | null = null;
      try {
        result = await ctx.execute(command, input ?? {});
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await new Promise((done) => setTimeout(done, waitMs ?? 300));
      const log = manager
        .logOf(id)
        .filter((l) => l.time >= since)
        .map((l) => `[${l.level}] ${l.text}`);
      return { ok: error === null, ...(error ? { error } : { result: result ?? null }), log };
    },
  });

  register({
    id: "extensions.examples",
    title: "Extension examples",
    description: `Small complete extensions to copy (manifest and code): ${EXAMPLES.map((e) => e.name).join(", ")}. With no input, the list; with { name }, that example's files as Markdown.`,
    input: s.object({ name: s.string().optional() }),
    effects: ["read"],
    run: ({ name }) => {
      if (!name)
        return `Examples (extensions.examples { name }):\n${EXAMPLES.map((e) => `- ${e.name} — ${e.summary}`).join("\n")}`;
      const e = EXAMPLES.find((x) => x.name === name.toLowerCase().trim());
      if (!e)
        throw new Error(
          `No example "${name}". Examples: ${EXAMPLES.map((x) => x.name).join(", ")}.`,
        );
      return exampleText(e);
    },
  });
}
