// Extensions from git repositories (D185): `extensions.installFromRepo` clones a repository
// shallowly into a scratch folder (Rust, no history kept), finds the extensions in it (its top,
// or one per folder like a catalog), installs the chosen one and remembers where it came from,
// so `extensions.updateFromRepo` can fetch it again. `extensions.browseOfficial` is the same
// over the official repository (product.json `extensionsRepo`, or the setting while there's none).
import { extIpc } from "../../core/ipc/extensions";
import { joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { normalizeCloneUrl } from "../git/cloneBlame";
import type { ExtensionManager } from "./manager";
import type { RepoSource } from "./registry";

type Register = WorkbenchServices["dispatcher"]["register"];

interface Found {
  path: string;
  id: string;
  name: string;
  description: string;
}

/** The official repository: the setting (for trying one out), else the product's. */
export const officialRepo = (services: WorkbenchServices): string =>
  (services.settings.get<string>("extensions.officialRepo") ?? "").trim() || product.extensionsRepo;

export function registerFromRepo(
  services: WorkbenchServices,
  manager: ExtensionManager,
  register: Register,
): void {
  const { quickInput, statusBar, notifications } = services;

  /** Downloads, lets the user choose (or takes `path`), installs; the scratch folder goes. */
  const install = async (
    source: RepoSource,
    options: { ask: boolean; title: string; choose: boolean },
  ): Promise<{ id: string | null; from: string; path?: string; cancelled?: boolean }> => {
    const progress = signal(`Downloading ${source.repo}…`);
    const line = statusBar.add({
      id: "extensions.download",
      name: "Extension downloads",
      alignment: "left",
      priority: 95,
      text: () => `$(cloud-download) ${progress.value}`,
      tooltip: () => source.repo,
    });
    let download: { folder: string; extensions: string[] } | null = null;
    try {
      download = await extIpc.downloadGit(source.repo, source.ref);
      const found: Found[] = [];
      for (const rel of download.extensions) {
        const entry = await extIpc.peek(joinPath(download.folder, rel)).catch(() => null);
        if (!entry) continue;
        let m: Record<string, unknown> = {};
        try {
          m = JSON.parse(entry.manifest) as Record<string, unknown>;
        } catch {
          continue;
        }
        const text = (v: unknown) => (typeof v === "string" ? v : "");
        const id = text(m.id) || [text(m.publisher), text(m.name)].filter(Boolean).join(".");
        found.push({
          path: rel,
          id,
          name: text(m.displayName) || text(m.name) || rel || id,
          description: text(m.description),
        });
      }
      const wanted = (source.path ?? "").replace(/^\/+|\/+$/g, "");
      let chosen: Found | undefined;
      if (wanted || !options.choose) {
        chosen = found.find((f) => f.path === wanted);
        if (!chosen)
          throw new Error(
            wanted
              ? `${source.repo} has no extension in ${wanted}.`
              : `${source.repo} has no extension at its top.`,
          );
      } else if (found.length === 0) {
        throw new Error(
          `${source.repo} has no extension (an extension.json, or a VS Code extension's package.json).`,
        );
      } else if (found.length === 1) chosen = found[0];
      else {
        progress.value = "Choose an extension";
        const installed = new Set(manager.records.peek().map((r) => r.id));
        const picked = await quickInput.pick(
          found.map((f, i) => ({
            id: String(i),
            label: f.name,
            description: `${installed.has(f.id) ? "installed · " : ""}${f.description || f.path || "(top)"}`,
            icon: "blocks" as const,
          })),
          { placeholder: options.title },
        );
        chosen = picked ? found[Number(picked.id)] : undefined;
      }
      if (!chosen) return { id: null, from: source.repo };
      progress.value = `Installing ${chosen.name}…`;
      const id = await manager.installFrom(joinPath(download.folder, chosen.path), options.ask);
      // Cancelled when asked about its permissions (D259).
      if (!id) return { id: null, from: source.repo, cancelled: true };
      await manager.setSource(id, {
        repo: source.repo,
        ...(source.ref && { ref: source.ref }),
        ...(chosen.path && { path: chosen.path }),
      });
      return { id, from: source.repo, ...(chosen.path && { path: chosen.path }) };
    } finally {
      line.dispose();
      if (download) void extIpc.discardDownload(download.folder).catch(() => {});
    }
  };

  const repoInput = s.object({
    repo: s
      .string()
      .describe("owner/name on GitHub, or a git URL (https, ssh) or a local repository path")
      .optional(),
    ref: s.string().describe("Branch or tag (default: the repository's default branch)").optional(),
    path: s
      .string()
      .describe("The extension's folder in the repository (default: its top, or ask)")
      .optional(),
  });

  register({
    id: "extensions.installFromRepo",
    title: "Install extension from GitHub…",
    description:
      "Downloads a git repository (a shallow copy, no history) and installs the extension in it: at its top, in `path`, or one the user picks when it holds several. Remembers the repository so extensions.updateFromRepo can update it. The user is asked to grant its permissions.",
    input: repoInput,
    effects: ["write"],
    agent: "hidden",
    run: async ({ repo, ref, path }, ctx) => {
      const typed =
        repo ??
        (await quickInput.prompt({
          prompt: "Repository to install from",
          placeholder: "owner/name, or a git URL",
          validate: (v) => (v.trim() ? undefined : "Type owner/name or a URL"),
        }));
      if (!typed?.trim()) return { id: null };
      // A repository in the open folder can be named relative to it.
      const root = services.workspace.root.peek();
      const url = normalizeCloneUrl(typed);
      if (/^(\.\.?|~)([\\/]|$)/.test(url) && !root)
        throw new Error(
          `Open a folder to install from ${url}, or give the repository's full path.`,
        );
      const result = await install(
        {
          repo: root && /^\.\.?[\\/]/.test(url) ? services.workspace.resolve(url) : url,
          ...(ref && { ref }),
          ...(path && { path }),
        },
        { ask: ctx.caller.kind !== "test", title: "Install which extension?", choose: true },
      );
      if (result.id)
        notifications.show(
          "success",
          `Installed ${manager.get(result.id)?.manifest?.displayName ?? result.id}.`,
        );
      return result;
    },
  });

  register({
    id: "extensions.updateFromRepo",
    title: "Update extension from its repository",
    description:
      "Downloads an extension installed from a repository (extensions.installFromRepo) again and replaces the installed copy. Permissions it newly asks for are asked again.",
    input: s.object({ id: s.string().describe("Extension id") }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ id }, ctx) => {
      const source = manager.sourceOf(id);
      if (!source) throw new Error(`${id} wasn't installed from a repository.`);
      const before = manager.get(id)?.manifest?.version;
      const result = await install(source, {
        ask: ctx.caller.kind !== "test",
        title: "",
        choose: false,
      });
      if (result.id && result.id !== id) {
        // The repository's folder now holds another extension: that one was installed instead.
        await manager.setSource(id, undefined);
        throw new Error(
          `${source.repo} now has ${result.id} there instead of ${id}; it was installed beside it.`,
        );
      }
      const after = result.id ? manager.get(result.id)?.manifest?.version : undefined;
      notifications.show(
        "success",
        before && after && before !== after
          ? `Updated ${manager.get(id)?.manifest?.displayName ?? id} to ${after}.`
          : `${manager.get(id)?.manifest?.displayName ?? id} is up to date.`,
      );
      return { id: result.id, version: after ?? null };
    },
  });

  register({
    id: "extensions.browseOfficial",
    title: "Browse official extensions…",
    description:
      "Lists the extensions in the official repository and installs the one the user picks.",
    input: s.object({ path: s.string().describe("Install this one without asking").optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ path }, ctx) => {
      const repo = officialRepo(services);
      if (!repo) {
        notifications.show(
          "info",
          "There's no official extension repository yet. Install from GitHub with a repository's owner/name meanwhile.",
        );
        return { id: null };
      }
      const result = await install(
        { repo: normalizeCloneUrl(repo), ...(path && { path }) },
        {
          ask: ctx.caller.kind !== "test",
          title: "Install which official extension?",
          choose: true,
        },
      );
      if (result.id)
        notifications.show(
          "success",
          `Installed ${manager.get(result.id)?.manifest?.displayName ?? result.id}.`,
        );
      return result;
    },
  });
}
