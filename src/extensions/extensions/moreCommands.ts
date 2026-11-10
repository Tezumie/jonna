// More extension commands (D176): the guide agents read before building or changing an
// extension, moving a development extension into the installed ones, a folder's extension status
// (the explorer's menu), and "Edit with agent".
import guide from "../../../docs/extensions.md?raw";
import apiTypes from "../../api/index.d.ts?raw";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderName, workspaceFolderPath } from "../../workbench/workspaceFolder";
import type { ExtensionManager } from "./manager";

const norm = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();

const exists = (path: string) =>
  fsIpc.stat(path).then(
    () => true,
    () => false,
  );

/** Compares dotted versions ("1.10.0" > "1.9.2"); -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function registerMoreCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
): void {
  const register: typeof services.dispatcher.register = (c) =>
    sub.add(services.dispatcher.register({ category: "Extensions", ...c }));
  const folderOf = (folder: string) => {
    const root = services.workspace.root.peek();
    return root ? services.workspace.resolve(folder) : folder;
  };

  register({
    id: "extensions.guide",
    title: "Extension authoring guide",
    description: `How to extend or change the IDE itself with an extension — read this before building one. With no input: its table of contents (sections with a line on each); { section } returns one section as Markdown (e.g. "extension.json" for the manifest, "code", "webview-panels", "api" for the TypeScript types main.js gets). Small working examples: extensions.examples. Workflow: extensions.create in <workspace folder>/extensions, edit, extensions.validate, extensions.try, check ide://extensions.`,
    input: s.object({
      section: s.string().describe("A section id from the table of contents").optional(),
      part: s.enum(["guide", "api"]).describe("(Older form) the whole guide or the API").optional(),
    }),
    effects: ["read"],
    palette: false,
    run: ({ section, part }) => {
      if (part === "guide") return { guide };
      if (part === "api") return { api: apiTypes };
      const sections = guideSections(guide);
      if (!section) {
        const lines = sections.map(
          (s) => `- ${s.id} — ${s.title} (${Math.round(s.text.length / 100) / 10}k): ${s.lead}`,
        );
        return `Extension guide — read the sections you need with extensions.guide { section }:\n${lines.join("\n")}\n- api — the TypeScript types of the \`ide\` object main.js gets (${Math.round(apiTypes.length / 1000)}k)\nStart with "extension.json" and "code"; extensions.examples has small working extensions.`;
      }
      const want = section.toLowerCase().replace(/^#+\s*/, "");
      if (want === "api") return apiTypes;
      const hit =
        sections.find((s) => s.id === want) ??
        sections.find((s) => s.title.toLowerCase() === want) ??
        sections.find((s) => s.id.includes(want) || s.title.toLowerCase().includes(want));
      if (!hit)
        throw new Error(
          `No section "${section}". Sections: ${[...sections.map((s) => s.id), "api"].join(", ")}.`,
        );
      return hit.text;
    },
  });

  // Reading any loaded extension's files, installed ones too (they live outside the open folder,
  // where the agent's file tools can't go): to compare, learn from or debug them. Read-only, and
  // only inside a known extension folder (the Rust side checks).
  const recordOf = (id: string) => {
    const r = manager.require(id);
    return r;
  };
  register({
    id: "extensions.listFiles",
    title: "List extension files",
    description:
      "The files of a loaded extension (installed, bundled or development): paths relative to its folder, with sizes. Installed extensions live outside the open folder; read them with extensions.readFile.",
    input: s.object({ id: s.string().describe("Extension id, e.g. bundled.todo-tree") }),
    effects: ["read"],
    palette: false,
    run: async ({ id }) => {
      const r = recordOf(id);
      return { id, root: r.root, dev: r.dev, files: await extIpc.files(r.root) };
    },
  });
  register({
    id: "extensions.readFile",
    title: "Read extension file",
    description:
      "The text of one file of a loaded extension (installed ones too), e.g. its main.js or extension.json, to compare with or learn from (read-only; at most 512 KB).",
    input: s.object({
      id: s.string().describe("Extension id"),
      path: s.string().describe("Relative to the extension's folder, e.g. main.js"),
    }),
    effects: ["read"],
    palette: false,
    run: async ({ id, path }) => {
      const r = recordOf(id);
      if (hiddenPart(path)) throw new Error(`${path}: hidden files aren't shared.`);
      const bytes = await extIpc.read(r.root, path.replace(/^\.?[\\/]+/, ""));
      if (bytes.length > 512 * 1024) throw new Error(`${path} is too large to read here.`);
      if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file.`);
      return { id, path, text: new TextDecoder().decode(bytes) };
    },
  });

  register({
    id: "extensions.listIcons",
    title: "List icon names",
    description:
      "Every icon name of the IDE's icon set: what an extension's `icon` (in extension.json), view, tree row, menu item and `$(name)` in status bar text can use.",
    input: s.empty(),
    effects: ["read"],
    palette: false,
    run: () => ({
      icons: [...document.querySelectorAll('symbol[id^="i-"]')].map((el) => el.id.slice(2)).sort(),
    }),
  });

  register({
    id: "extensions.installPermanently",
    title: "Install extension permanently",
    description:
      'Copies a development extension (unpacked, or in the open folder\'s extensions) into the installed extensions, so it\'s there in every folder; it keeps its permissions, and its folder stays where it is but is no longer loaded. A development copy of an installed extension (same id, made with extensions.copyForDevelopment) updates it (mode "replace") or installs beside it under a new id (mode "new", newId optional: <id>-2…); without mode the user is asked.',
    input: s.object({
      id: s.string().describe("Extension id, e.g. local.todo-list"),
      mode: s.enum(["replace", "new"]).optional(),
      newId: s.string().optional(),
    }),
    effects: ["write"],
    run: async ({ id, mode, newId }, ctx) => {
      // The user, or an agent they allowed to change the IDE; never an extension (it would make
      // itself, or another, run in every folder).
      if (ctx.caller.kind === "ext" || ctx.caller.kind === "mcp")
        throw new Error("Only the user or the agent can install extensions permanently.");
      const record = manager.require(id);
      const replaces = record.replaces;
      const name = record.manifest?.displayName ?? id;
      let chosen = mode;
      if (replaces && !chosen) {
        if (ctx.caller.kind === "test") chosen = "replace";
        else {
          const version = record.manifest?.version ?? "?";
          const older = compareVersions(version, replaces.version) <= 0;
          const notes = [
            older
              ? `This copy's version (${version}) isn't newer than the installed ${replaces.version}: raise "version" in its manifest so it's clear which is which.`
              : `Installed: ${replaces.version} → this copy: ${version}.`,
            replaces.bundled
              ? `${name} comes with the IDE: your copy is kept when the IDE updates (go back to the IDE's version from its page at any time).`
              : "",
            replaces.source
              ? `It was installed from ${replaces.source.repo}: replaced, it no longer updates from there.`
              : "",
          ].filter(Boolean);
          const answer = await showDialog<"replace" | "new" | "cancel">({
            title: `Update the installed ${name}?`,
            message: `This development copy uses the same id (${id}) as the installed ${name}.\n\n${notes.join("\n\n")}\n\nOr install it as a separate extension with its own id (both stay installed).`,
            actions: [
              { label: "Cancel", value: "cancel" },
              { label: "Install as new", value: "new" },
              { label: "Replace installed", value: "replace", variant: "primary" },
            ],
            cancelValue: "cancel",
          });
          if (answer === "cancel") return { installed: false };
          chosen = answer;
        }
      }
      const done = await manager.installPermanently(id, chosen ?? "replace", newId);
      services.notifications.show(
        "success",
        done.replaced
          ? `Updated ${name} (was ${done.replaced}).${done.customized ? " The IDE's own updates to it are skipped now; go back to its version from the extension's page." : ""}`
          : done.id !== id
            ? `Installed ${name} as ${done.id}, beside the original.`
            : `Installed ${name} permanently.`,
      );
      return done;
    },
  });

  register({
    id: "extensions.copyForDevelopment",
    title: "Copy extension for development",
    description:
      "Copies an installed (or bundled) extension's files into <workspace folder>/extensions in the open folder and loads the copy for development: with the same id it replaces the installed one while it's loaded (change it, check it, then extensions.installPermanently to update the installed one); with fork: true it gets its own id (<id>-2…) and runs beside the original. Returns the folder.",
    input: s.object({
      id: s.string(),
      fork: s.boolean().optional(),
    }),
    effects: ["write"],
    run: async ({ id, fork }, ctx) => {
      if (ctx.caller.kind === "ext" || ctx.caller.kind === "mcp")
        throw new Error("Only the user or the agent can copy extensions.");
      const root = services.workspace.root.peek();
      if (!root) throw new Error("Open a folder first: the copy goes in its extensions folder.");
      const record = manager.require(id);
      if (record.dev) return { folder: record.root, id, copied: false };
      const base = (id.split(".").pop() || id).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const parent = joinPath(workspaceFolderPath(root), "extensions");
      let name = base;
      for (let n = 2; await exists(joinPath(parent, name)); n++) name = `${base}-${n}`;
      const target = joinPath(parent, name);
      for (const f of await extIpc.files(record.root)) {
        if (hiddenPart(f.path)) continue;
        const bytes = await extIpc.read(record.root, f.path);
        await fsIpc.write(f.path.split("/").reduce(joinPath, target), bytes, "extension");
      }
      let newId = id;
      if (fork) {
        newId = `${id}-2`;
        for (let n = 3; manager.get(newId); n++) newId = `${id}-${n}`;
        const manifestPath = joinPath(target, record.manifestFile);
        const json = JSON.parse(new TextDecoder().decode(await fsIpc.read(manifestPath)));
        if (record.manifestFile === "package.json") json.name = newId.split(".").slice(1).join(".");
        else json.id = newId;
        await fsIpc.write(
          manifestPath,
          new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`),
          "extension",
        );
      }
      services.events.emit("files.didCreate", { path: target, kind: "dir" });
      // Copied to be worked on: it runs (the installed one may have been off; that's by id).
      if (manager.get(id)?.status === "disabled") await manager.setEnabled(id, true);
      await manager.loadUnpacked(target, ctx.caller.kind === "user");
      return { folder: target, id: newId, copied: true, replacesInstalled: !fork };
    },
  });

  register({
    id: "extensions.revertToBundled",
    title: "Go back to the IDE's version of an extension",
    description:
      "For a bundled extension the user replaced with a changed copy: removes their copy and installs the IDE's own version again (updated with the IDE from then on).",
    input: s.object({ id: s.string() }),
    effects: ["write"],
    run: async ({ id }, ctx) => {
      if (ctx.caller.kind !== "test") {
        const ok = await showDialog({
          title: "Go back to the IDE's version?",
          message: `Your changed copy of ${manager.get(id)?.manifest?.displayName ?? id} is removed and the IDE's own version is installed again. Keep a development copy first if you want your changes.`,
          actions: [
            { label: "Cancel", value: false },
            { label: "Use the IDE's version", value: true, variant: "danger" },
          ],
          cancelValue: false,
        });
        if (!ok) return { reverted: false };
      }
      await manager.revertToBundled(id);
      return { reverted: true };
    },
  });

  register({
    id: "extensions.folderStatus",
    title: "Extension folder status",
    description:
      "Whether a folder is an extension (has extension.json or a VS Code package.json), and if so its id and whether it's loaded (installed or for development).",
    input: s.object({ folder: s.string() }),
    effects: ["read"],
    palette: false,
    run: async ({ folder }) => {
      const path = folderOf(folder);
      const record = manager.records.peek().find((r) => norm(r.root) === norm(path));
      if (record) return { extension: true, id: record.id, loaded: true, dev: record.dev };
      // Ours, or a VS Code extension's package.json (one with "contributes").
      const exists = (name: string) =>
        fsIpc.stat(joinPath(path, name)).then(
          () => true,
          () => false,
        );
      const manifest =
        (await exists("extension.json")) ||
        ((await exists("package.json")) &&
          (await fsIpc
            .read(joinPath(path, "package.json"))
            .then((b) => /"contributes"\s*:/.test(new TextDecoder().decode(b)))
            .catch(() => false)));
      if (!manifest) return { extension: false };
      const pending = manager.workspace.peek().find((w) => norm(w.root) === norm(path));
      return { extension: true, id: pending?.id ?? null, loaded: false, dev: true };
    },
  });

  register({
    id: "extensions.editWithAgent",
    title: "Edit extension with the agent",
    description:
      "Opens the agent panel with a message about an extension (to finish and send): where its files are and how to reload it.",
    input: s.object({ id: s.string() }),
    effects: [],
    agent: "hidden",
    run: async ({ id }, ctx) => {
      const r = manager.require(id);
      // Relative to its folder; with several, the folder's name first (D251).
      const owner = services.workspace.folderOf(r.root);
      const several = services.workspace.folders.peek().length > 1;
      const where = owner
        ? `${several ? `${owner.name}/` : ""}${r.root.slice(owner.path.length + 1)}`
        : r.root;
      const name = r.manifest?.displayName ?? id;
      const text = r.dev
        ? `Change the ${name} extension (${id}, files in ${where})${r.replaces ? ` — a development copy replacing the installed ${r.replaces.version}; when it works, extensions.installPermanently updates the installed one` : ""}: `
        : `The ${name} extension (${id}) is installed, so its files are read-only. First call_command extensions.copyForDevelopment {"id":"${id}"} (a development copy in ${workspaceFolderName()}/extensions that replaces the installed one while loaded; fork: true for a separate extension), change the copy, then extensions.installPermanently to update the installed one: `;
      await ctx.execute("agent.compose", { text });
    },
  });
}

/** The guide's "## " sections: an id (slug), the title, the first sentence, the text. */
export function guideSections(
  markdown: string,
): { id: string; title: string; lead: string; text: string }[] {
  const out: { id: string; title: string; lead: string; text: string }[] = [];
  const parts = markdown.split(/^(?=## )/m);
  const intro = parts[0]?.startsWith("## ") ? null : parts.shift();
  if (intro?.trim()) {
    const body = intro.replace(/^# .*\n/, "").trim();
    out.push({ id: "overview", title: "Overview", lead: firstSentence(body), text: intro.trim() });
  }
  for (const part of parts) {
    const title = (part.match(/^## (.*)$/m)?.[1] ?? "").replace(/\s*\(D\d+\)\s*$/, "").trim();
    const body = part.replace(/^## .*\n/, "").trim();
    const id = title
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-|-$/g, "");
    // Two sections with the same title: the second gets "-2".
    let unique = id;
    for (let n = 2; out.some((s) => s.id === unique); n++) unique = `${id}-${n}`;
    out.push({ id: unique, title, lead: firstSentence(body), text: part.trim() });
  }
  return out;
}

function firstSentence(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (plain.match(/^.*?[.!?](\s|$)/)?.[0] ?? plain).trim().slice(0, 140);
}

/**
 * A dot file or folder in an extension's path (`.env`, `.git/config`): not shown to agents, as
 * the Files tab and its listing don't show them either.
 */
export function hiddenPart(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..");
}
