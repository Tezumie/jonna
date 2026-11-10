// Workspace trust commands (D103): see and change whether the open folder's tasks may run, a
// status bar item in restricted mode, and `ide://workspace/trust`.
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { trustOf } from "../../workbench/trustModel";
import { registerRiskyFolders } from "./riskyFolderCommands";

const OPEN_PROMPT_DELAY_MS = 400;

export function registerTrustCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, trust, statusBar, state, workspace, settings, context, persistence } =
    services;
  // VS Code asks when a folder opens (security.workspace.trust.startupPrompt "once"): a moment
  // after, so the folder's layout is up behind the dialog. Never in a test run (scripts set trust
  // themselves); a folder already decided, itself or through a parent, isn't asked.
  // Restricted settings (D209: terminal profiles, the automation profile) follow the trust.
  sub.add(
    effect(() => {
      settings.model.setTrusted(trust.state.value === "trusted");
      return undefined;
    }),
  );
  let pending: ReturnType<typeof setTimeout> | undefined;
  sub.add(
    toDisposable(() => {
      if (pending !== undefined) clearTimeout(pending);
    }),
  );
  sub.add(
    workspace.onDidOpen(() => {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        if (context.get("testRun")) return;
        if (settings.peek<string>("security.workspace.trust.startupPrompt") === "never") return;
        void trust.askOnOpen().catch(() => {});
      }, OPEN_PROMPT_DELAY_MS);
    }),
  );
  sub.add(
    dispatcher.register({
      id: "workspace.manageTrust",
      title: "Manage workspace trust",
      category: "Workspace",
      description:
        "Asks whether to trust the open folder's authors: trusted folders may run their own tasks; restricted ones don't.",
      input: s.empty(),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "hidden",
      run: async () => ({ trusted: await trust.ask() }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "workspace.setTrust",
      title: "Set workspace trust",
      category: "Workspace",
      description:
        "Trusts the open folder (its tasks may run) or puts it in restricted mode. Only the user (and test scripts) can change trust.",
      input: s.object({
        trusted: s.boolean().describe("true: trust; false: restricted mode"),
        parent: s
          .boolean()
          .describe("Trusting: also trust the parent folder (and so every folder under it)")
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "hidden",
      palette: false,
      run: async ({ trusted, parent }) => {
        await trust.set(trusted, { parent: parent === true });
        return { state: trust.state.peek() };
      },
    }),
  );
  sub.add(
    statusBar.add({
      id: "workspace.trust",
      name: "Restricted mode",
      alignment: "left",
      // VS Code's place: the far left, after only the remote indicator.
      priority: 100.5,
      text: () =>
        workspace.root.value && trust.state.value === "restricted"
          ? "$(shield) Restricted mode"
          : "",
      tooltip: () => "This folder's tasks don't run. Click to manage workspace trust.",
      command: "workspace.manageTrust",
    }),
  );
  sub.add(
    state.register("ide://workspace/trust", {
      description:
        "Workspace trust of the open folder: trusted, restricted (its tasks, debugging, tests, git and the agents' project instruction files don't run) or unknown (asked when it opens, and before the first task runs). `inheritedFrom`: the trusted parent folder it's trusted through. `risky`: downloads, home, desktop, temp or root (a drive root) when the folder is one (D213), else null. A multi-root workspace (D251) is trusted only when every folder is (restricted when any is): `folders` gives each folder's own decision and risk.",
      get: () => ({
        state: trust.state.peek(),
        ...(trust.inheritedFrom.peek() && { inheritedFrom: trust.inheritedFrom.peek() }),
        risky: trust.risky.riskOf(workspace.root.peek())?.kind ?? null,
        ...(workspace.isMultiRoot() && {
          folders: workspace.folders.peek().map((f) => {
            const risk = trust.risky.riskOf(f.path);
            const decision = trustOf(persistence.globalState().trust, f.path, !risk);
            return {
              name: f.name,
              path: f.path,
              trust: decision.state,
              ...(decision.inheritedFrom && { inheritedFrom: decision.inheritedFrom }),
              risky: risk?.kind ?? null,
            };
          }),
        }),
      }),
    }),
  );
  // The caution before Downloads and the like open (D213).
  registerRiskyFolders(sub, services);
}
