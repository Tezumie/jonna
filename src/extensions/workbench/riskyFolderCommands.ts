// The risky-folder caution (D213): before Downloads (or a folder in it), the home folder, the
// Desktop, temp or a drive root opens as the workspace — from Open folder, a recent folder, the command line or
// a drop, all of which go through workspace.open — a dialog explains the risk and offers
// restricted mode (the default), trust, or cancel, with "Don't ask again for this folder"
// (`security.warnRiskyFolders` turns it off). A risky folder never inherits a trusted parent's
// trust (trust.ts). Commands: workspace.resetRiskyFolderWarnings, the test hook
// security.setTestDownloadsFolder; state: ide://security/riskyFolders (ide://workspace has `risky`).
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { isAbsolute, pathKey } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { askRiskyOpen } from "../../workbench/riskyFolders";
import type { WorkbenchServices } from "../../workbench/services";
import { withDecision } from "../../workbench/trustModel";

export function registerRiskyFolders(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, trust, state, workspace, settings, persistence } = services;
  const risky = trust.risky;
  risky.setExtra(() => {
    const list = settings.peek<unknown>("security.riskyFolders");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  });
  void risky.ready();
  /** The choice made in the dialog, applied to the canonical folder once it's open. */
  let pending: { trusted: boolean } | null = null;

  sub.add(
    workspace.setOpenGuard(async (path, requested) => {
      await risky.ready();
      if (!requested) pending = null;
      // The canonical path of a folder just asked about (or let through) isn't asked again.
      if (requested && risky.riskOf(requested)) return true;
      const match = risky.riskOf(path);
      if (!match) return true;
      if (settings.peek<boolean>("security.warnRiskyFolders") === false) return true;
      const global = persistence.globalState();
      const key = pathKey(path);
      if (global.riskyFolderDismissed?.includes(key)) return true;
      // Already restricted by its own decision: it opens restricted, nothing to warn about.
      if (global.trust?.[key] === false) return true;
      const nested = risky.key(path) !== risky.key(match.folder);
      const { choice, dontAsk } = await askRiskyOpen(path, match, nested);
      if (choice === "cancel") return false;
      const trusted = choice === "trusted";
      // Saved before the folder opens, so it starts restricted: git, language servers and the
      // agent's rules never see it as undecided.
      await persistence.saveGlobal((current) => ({
        trust: withDecision(current.trust, path, trusted),
        ...(dontAsk && {
          riskyFolderDismissed: [
            ...(current.riskyFolderDismissed ?? []).filter((k) => k !== key),
            key,
          ],
        }),
      }));
      pending = { trusted };
      return true;
    }),
  );
  // The canonical folder (a link, another spelling) gets the same answer.
  sub.add(
    workspace.onDidOpen(() => {
      const choice = pending;
      pending = null;
      if (!choice) return;
      // A multi-root workspace (D251): the answer was saved for the folder it asked about; the
      // others keep their own decisions.
      if (workspace.folders.peek().length > 1) return;
      if (trust.state.peek() !== (choice.trusted ? "trusted" : "restricted"))
        void trust.set(choice.trusted).catch(() => {});
    }),
  );
  sub.add(toDisposable(() => risky.setExtra(() => [])));

  sub.add(
    dispatcher.register({
      id: "workspace.resetRiskyFolderWarnings",
      title: "Reset risky folder warnings",
      category: "Workspace",
      description:
        "Asks again before a risky folder (Downloads, the home folder, the Desktop, temp, a drive root) opens, for the folders where “Don't ask again” was checked.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: async () => {
        const count = persistence.globalState().riskyFolderDismissed?.length ?? 0;
        await persistence.saveGlobal({ riskyFolderDismissed: undefined });
        return { reset: count };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "security.setTestDownloadsFolder",
      title: "Set the Downloads folder (test runs)",
      category: "Developer",
      description:
        "Test runs only: treats `path` (absolute, or relative to the open folder) as the user's Downloads folder (no path: the real one again), so a script can check the risky-folder caution and the agent's questions. `open`: then opens it as the workspace, through the caution.",
      input: s.object({
        path: s.string({ minLength: 1 }).optional(),
        open: s.boolean().optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ path, open }, ctx) => {
        if (ctx.caller.kind !== "test") throw new Error("Only test scripts can set this.");
        await risky.ready();
        const root = workspace.root.peek();
        const abs = path && !isAbsolute(path) && root ? workspace.resolve(path) : path;
        risky.setTestDownloads(abs ?? null);
        const opened = open && abs ? await workspace.open(abs) : undefined;
        return { downloads: risky.downloadFolders(), ...(open && { opened: opened ?? null }) };
      },
    }),
  );

  sub.add(
    state.register("ide://security/riskyFolders", {
      description:
        "Risky folders (D213): the user's Downloads folders (those inside them count too), home, Desktop and temp folders (a drive root counts too); `extra` from security.riskyFolders; whether the open-time caution is on and the folders it won't ask about again; `open`: the open folder's risk ({ kind, folder }) or null; in a multi-root workspace (D251), `folders`: each folder's risk.",
      get: () => {
        const known = risky.known();
        return {
          downloads: risky.downloadFolders(),
          home: known.home,
          desktop: known.desktop,
          temp: known.temp,
          warn: settings.peek<boolean>("security.warnRiskyFolders") !== false,
          dismissed: persistence.globalState().riskyFolderDismissed ?? [],
          open: risky.riskOf(workspace.root.peek()),
          ...(workspace.isMultiRoot() && {
            folders: workspace.folders.peek().map((f) => ({
              name: f.name,
              path: f.path,
              risky: risky.riskOf(f.path),
            })),
          }),
        };
      },
    }),
  );
}
