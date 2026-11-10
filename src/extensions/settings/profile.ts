// Export / import a settings profile (D130): user settings.json, keybindings.json and user
// snippets in one file, written and read where the user picks with the system dialog.
import { fsIpc } from "../../core/ipc/fs";
import { settingsIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { s } from "../../core/schema/index";
import { buildProfile, parseProfile, profileSummary } from "../../core/settings/profile";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (t: string) => new TextEncoder().encode(t);

export function registerProfileCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, notifications, events } = services;
  const paths = () => {
    const user = settings.filePath("user");
    if (!user) throw new Error("Profiles are only available in the desktop app.");
    return { user, keys: settings.keybindingsPath, snippets: joinPath(dirname(user), "snippets") };
  };
  /** Test paths may be relative to the open folder. */
  const testPath = (path: string | undefined) => {
    const root = services.workspace.root.peek();
    return path && root && !/^([a-zA-Z]:)?[\\/]/.test(path) ? joinPath(root, path) : path;
  };
  const readText = (path: string | null) =>
    path ? fsIpc.read(path).then(decode, () => undefined) : Promise.resolve(undefined);

  sub.add(
    dispatcher.register({
      id: "settings.exportProfile",
      title: "Export profile…",
      category: "Preferences",
      description:
        "Saves the user settings, keybindings and user snippets to one file (asks where), to import on another machine. API keys aren't included.",
      input: s.object({ path: s.string().describe("Debug builds only: where to save").optional() }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ path }) => {
        const p = paths();
        const snippets: Record<string, string> = {};
        for (const e of await fsIpc.listDir(p.snippets).catch(() => [])) {
          if (e.kind !== "file" || !/\.(json|code-snippets)$/.test(e.name)) continue;
          const text = await readText(e.path);
          if (text !== undefined) snippets[e.name] = text;
        }
        const profile = buildProfile(product.nameLong, {
          ...(await readText(p.user).then((t) => (t === undefined ? {} : { settings: t }))),
          ...(await readText(p.keys).then((t) => (t === undefined ? {} : { keybindings: t }))),
          snippets,
        });
        const saved = await settingsIpc.saveProfile(
          `${product.nameShort.toLowerCase()}-profile.json`,
          JSON.stringify(profile, null, 2),
          testPath(path),
        );
        if (!saved) return { saved: null };
        notifications.show("success", `Exported ${profileSummary(profile)}.`);
        return { saved, contains: profileSummary(profile) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "settings.importProfile",
      title: "Import profile…",
      category: "Preferences",
      description:
        "Replaces the user settings, keybindings and snippets with those in an exported profile file (asks which file, then confirms). Snippet files not in the profile are kept.",
      input: s.object({ path: s.string().describe("Debug builds only: the file").optional() }),
      // Confirmed in run (the confirmation names what the picked file holds).
      effects: ["write"],
      agent: "hidden",
      run: async ({ path }, ctx) => {
        const p = paths();
        const picked = await settingsIpc.openProfile(testPath(path));
        if (!picked) return { imported: null };
        const profile = parseProfile(picked[1]);
        const what = profileSummary(profile);
        if (what === "nothing") throw new Error("That profile is empty.");
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            "Import profile?",
            `Replaces your ${what} with the profile's${profile.app ? ` (from ${profile.app}${profile.exported ? `, ${profile.exported.slice(0, 10)}` : ""})` : ""}. This can't be undone.`,
            "Import",
            true,
          ))
        )
          return { imported: null };
        if (profile.settings !== undefined) {
          await fsIpc.write(p.user, encode(profile.settings));
          await settings.reload("user");
        }
        if (profile.keybindings !== undefined && p.keys)
          await fsIpc.write(p.keys, encode(profile.keybindings));
        for (const [name, text] of Object.entries(profile.snippets ?? {})) {
          const file = joinPath(p.snippets, name);
          await fsIpc.write(file, encode(text));
          events.emit("files.didSave", { path: file });
        }
        notifications.show("success", `Imported ${what}.`);
        return { imported: what };
      },
    }),
  );
}
