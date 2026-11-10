// Output styles (D356, core/agent/outputStyles.ts): Claude Code's /output-style. The built-ins and
// the user's own style files: `<config>/output-styles/*.md` (and Claude Code's
// `~/.claude/output-styles`), and a trusted folder's `<IDE folder>/output-styles` (and
// `.claude/output-styles`): a folder's file steers the agent, so an untrusted folder's aren't read,
// as with its custom modes. `agent.outputStyle` names the style; sessionTurn.ts puts it into the
// system prompt (kept per chat for the provider's cache: a change rebuilds it once).
// `agent.setOutputStyle` (the picker, /output-style) and ide://agent/outputStyles.

import {
  BUILTIN_STYLES,
  DEFAULT_STYLE,
  findStyle,
  mergeStyles,
  type OutputStyle,
  parseOutputStyleFile,
} from "../../core/agent/outputStyles";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, joinPath, resolveInRoot } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderLabelsOf } from "../../workbench/workspaceFolder";
import { readText } from "./changeset";
import { activePlugins, pluginLabel } from "./pluginContributions";

const SETTING = "agent.outputStyle";
/** Style files read per folder. */
const FILES_PER_FOLDER = 50;
/** Read again after this long (files edited meanwhile); a picker or a change reads at once. */
const FRESH_MS = 10_000;

let home: Promise<string | null> | undefined;
const homeDir = () => {
  home ??= appIpc
    .info()
    .then((i) => i.homeDir)
    .catch(() => null);
  return home;
};

/** The folders style files come from: the project's (trusted folders only), then the user's. */
async function styleFolders(
  services: WorkbenchServices,
): Promise<{ dir: string; label: string; source: "user" | "project" }[]> {
  const others = services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false;
  const out: { dir: string; label: string; source: "user" | "project" }[] = [];
  const root = services.workspace.root.peek();
  if (root && services.trust.trusted) {
    const listed = services.workspace.folders.peek();
    const folders = listed.length ? listed : [{ path: root, name: root }];
    for (const f of folders)
      for (const label of [
        ...workspaceFolderLabelsOf(f.path, "output-styles"),
        ...(others ? [".claude/output-styles"] : []),
      ])
        out.push({ dir: resolveInRoot(f.path, label), label, source: "project" });
  }
  const settings = services.settings.filePath("user");
  if (settings)
    out.push({
      dir: joinPath(dirname(settings), "output-styles"),
      label: "your output styles",
      source: "user",
    });
  // Enabled plugins' styles (D375), after the user's own.
  for (const p of activePlugins.peek())
    for (const dir of p.outputStyleDirs)
      out.push({ dir, label: pluginLabel(p.name), source: "user" });
  const h = others ? await homeDir() : null;
  if (h)
    out.push({
      dir: joinPath(joinPath(h, ".claude"), "output-styles"),
      label: "~/.claude/output-styles",
      source: "user",
    });
  return out;
}

let cache: { at: number; key: string; styles: Promise<OutputStyle[]> } | null = null;

/** Every style: the built-ins, the project's, the user's (the first of a name wins). */
export function outputStyles(services: WorkbenchServices, fresh = false): Promise<OutputStyle[]> {
  const key = `${services.workspace.root.peek() ?? ""}\0${services.trust.trusted}\0${activePlugins
    .peek()
    .map((p) => p.id)
    .join(",")}`;
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < FRESH_MS) return cache.styles;
  const styles = (async () => {
    const lists: OutputStyle[][] = [];
    for (const { dir, label, source } of await styleFolders(services)) {
      const entries = await fsIpc.listDir(dir).catch(() => []);
      const list: OutputStyle[] = [];
      for (const e of entries
        .filter((e) => e.kind === "file" && /\.md$/i.test(e.name))
        .slice(0, FILES_PER_FOLDER)) {
        const text = await readText(services, e.path).catch(() => null);
        const style = text === null ? null : parseOutputStyleFile(text, e.name, source, e.path);
        if (style) list.push({ ...style, label });
      }
      lists.push(list);
    }
    return mergeStyles(BUILTIN_STYLES, ...lists);
  })();
  cache = { at: Date.now(), key, styles };
  return styles;
}

/** The style `agent.outputStyle` names now (Default when it's gone, with `missing`). */
export async function activeOutputStyle(
  services: WorkbenchServices,
): Promise<{ style: OutputStyle; missing: boolean }> {
  const wanted = services.settings.peek<string>(SETTING);
  if (!wanted || wanted.trim().toLowerCase() === DEFAULT_STYLE)
    return { style: BUILTIN_STYLES[0] as OutputStyle, missing: false };
  return findStyle(await outputStyles(services), wanted);
}

/** The style's name as the chat shows it ("" for Default). */
export function outputStyleLabel(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.toLowerCase() === DEFAULT_STYLE) return "";
  return BUILTIN_STYLES.find((b) => b.name.toLowerCase() === name.toLowerCase())?.name ?? name;
}

export function registerOutputStyles(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, state, quickInput } = services;
  // A setting changed or the folder's trust: read the files again next time.
  sub.add(
    settings.model.onDidChange((keys) => {
      if (keys.includes(SETTING) || keys.includes("agent.thirdPartyConfigs")) cache = null;
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setOutputStyle",
      title: "Agent: choose output style…",
      category: "Agent",
      description:
        "Chooses how the agent talks while it works (D356, Claude Code's output styles; agent.outputStyle): Default, Explanatory (insights about the code's choices), Learning (asks you to write small parts yourself at TODO(human) markers), or a style file of your own (<config>/output-styles/*.md, a trusted folder's <workspace folder>/output-styles, Claude Code's). Same as /output-style [name]. Without `style` a person picks from a list. `scope` workspace keeps it for this folder only. The chats' prompts are rebuilt with it on their next message.",
      input: s.object({
        style: s.string().describe("A style's name (ide://agent/outputStyles)").optional(),
        scope: s.enum(["user", "workspace"]).optional(),
      }),
      effects: ["write"],
      run: async ({ style, scope }, ctx) => {
        const styles = await outputStyles(services, true);
        let chosen = style?.trim();
        if (!chosen) {
          if (ctx.caller.kind !== "user")
            return { style: settings.peek<string>(SETTING), styles: styles.map((x) => x.name) };
          const current = findStyle(styles, settings.peek<string>(SETTING)).style.name;
          const picked = await quickInput.pick(
            styles.map((x) => ({
              id: x.name,
              label: x.name === current ? `${x.name} (current)` : x.name,
              description: x.source === "built-in" ? "Built-in" : (x.label ?? x.source),
              detail: x.description,
            })),
            { placeholder: "How the agent talks while it works" },
          );
          if (!picked) return { style: current, changed: false };
          chosen = picked.id;
        }
        const found = findStyle(styles, chosen);
        if (found.missing)
          throw new Error(
            `No output style named ${chosen}: ${styles.map((x) => x.name).join(", ")}.`,
          );
        const value =
          found.style.source === "built-in" ? found.style.name.toLowerCase() : found.style.name;
        const where =
          scope === "workspace" && settings.filePath("workspace") ? "workspace" : "user";
        await settings.update(SETTING, value, where);
        cache = null;
        return { style: found.style.name, scope: where, changed: true };
      },
    }),
  );

  sub.add(
    state.register("ide://agent/outputStyles", {
      description:
        "Output styles (D356): the one in use (agent.outputStyle; `missing` when its file is gone, Default is used), and every style with its description, where it comes from and its file.",
      get: async () => {
        // Read again: the files as they are now (and the chats' next prompt with them).
        const styles = await outputStyles(services, true);
        const { style, missing } = findStyle(styles, settings.peek<string>(SETTING));
        return {
          current: style.name,
          setting: settings.peek<string>(SETTING),
          missing,
          styles: styles.map((x) => ({
            name: x.name,
            description: x.description,
            source: x.source,
            keepCodingInstructions: x.keepCodingInstructions,
            ...(x.path && { path: x.path }),
          })),
        };
      },
    }),
  );
}
