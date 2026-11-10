// Workspace trust (PLAN M6, D103). A folder's own files can make the IDE run programs: its tasks
// (.vscode/tasks.json, the IDE's tasks.json, package.json scripts), launch configurations, test
// runners. As in VS Code, the IDE asks whether the user trusts the folder's authors when a folder
// it hasn't decided about opens (`security.workspace.trust.startupPrompt`), and again before the
// first one of those runs if that question was dismissed. The answer is remembered per folder; a
// trusted parent folder covers the folders under it (trustModel.ts). In restricted mode those stay
// off until the user trusts the folder. Settings that start programs (language servers, agents,
// MCP servers) are user-only already, so a folder's settings can't set them.
import type { ContextKeyService } from "../core/context/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { basename, dirname, pathKey } from "../core/paths/index";
import { effect, type Signal, signal } from "../core/reactive/index";
import { showDialog } from "../ui/Dialog";
import type { PersistenceService } from "./persistence";
import { RiskyFolders } from "./riskyFolders";
import { type TrustState, trustOf, withDecision } from "./trustModel";
import { isUntitledWorkspace, type WorkspaceService } from "./workspace";

export type { TrustState } from "./trustModel";

export class WorkspaceTrust implements Disposable {
  /** The open folder's state ("unknown" until the user decides, or with no folder). */
  readonly state: Signal<TrustState> = signal<TrustState>("unknown");
  /** The trusted parent folder the open folder's trust comes from, if it isn't its own. */
  readonly inheritedFrom: Signal<string | null> = signal<string | null>(null);
  private readonly store = new DisposableStore();
  private asking: Promise<boolean> | null = null;
  /** Aborts an open trust dialog (the folder closed, or trust was set another way). */
  private dialog: AbortController | null = null;
  /** Folders asked about when they opened this session (a dismissed question isn't repeated). */
  private readonly promptedOnOpen = new Set<string>();
  /**
   * Downloads, the home folder, the Desktop, temp (D213): a risky folder only counts as trusted
   * by its own decision, never through a trusted parent folder.
   */
  readonly risky = new RiskyFolders();

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly persistence: PersistenceService,
    context: ContextKeyService,
  ) {
    const update = () => {
      // Every folder of a multi-root workspace (D251): trusted only when each is, restricted
      // when any is (VS Code's rule); with one folder, that folder's decision.
      const folders = this.subjects();
      const decisions = folders.map((f) =>
        trustOf(this.persistence.globalState().trust, f, !this.risky.riskOf(f)),
      );
      const state: TrustState = !decisions.length
        ? "unknown"
        : decisions.some((d) => d.state === "restricted")
          ? "restricted"
          : decisions.every((d) => d.state === "trusted")
            ? "trusted"
            : "unknown";
      this.state.value = state;
      this.inheritedFrom.value =
        decisions.length === 1 ? (decisions[0]?.inheritedFrom ?? null) : null;
    };
    this.store.add(workspace.onDidOpen(update));
    this.store.add(workspace.onDidChangeFolders(update));
    this.store.add(workspace.setTrustGuard((paths, answer) => this.guardAdd(paths, answer)));
    this.store.add(workspace.setAddConfirm((paths, why) => this.confirmAdd(paths, why)));
    this.store.add(
      workspace.onDidClose(() => {
        this.dialog?.abort();
        queueMicrotask(update);
      }),
    );
    this.store.add(toDisposable(() => this.dialog?.abort()));
    // Where Downloads is becomes known (or a test moves it): a parent's trust may no longer count.
    this.store.add(
      effect(() => {
        this.risky.version.value;
        if (workspace.root.peek()) update();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        context.set("workspaceTrusted", this.state.value === "trusted");
        return undefined;
      }),
    );
  }

  /**
   * What the decision covers: every folder, and a saved workspace file (it brings settings, tasks
   * and launch configurations of its own, VS Code counts it too). An untitled workspace's file is
   * the IDE's own, in its data folder.
   */
  private subjects(): string[] {
    const file = this.workspace.file.peek();
    return [...this.workspace.folderPaths(), ...(file && !isUntitledWorkspace(file) ? [file] : [])];
  }

  /**
   * Before folders join a trusted workspace (D251): authors not decided about yet are asked about,
   * as VS Code does — trusted, they join trusted; restricted, they join and the workspace becomes
   * restricted; cancelled, they don't join. Decided ones keep their decision.
   */
  private async guardAdd(paths: readonly string[], given?: boolean): Promise<boolean> {
    if (this.state.peek() !== "trusted") return true;
    const trust = this.persistence.globalState().trust;
    const undecided = paths.filter(
      (p) => trustOf(trust, p, !this.risky.riskOf(p)).state === "unknown",
    );
    if (!undecided.length) return true;
    // Answered already (the command's `trust` input, the user's own).
    const answer =
      given === undefined
        ? await this.askAdd(undecided)
        : given
          ? ("trust" as const)
          : ("restrict" as const);
    if (answer === "cancel") return false;
    await this.persistence.saveGlobal((current) => ({
      trust: undecided.reduce(
        (t, p) => withDecision(t, p, answer === "trust", false),
        current.trust,
      ),
    }));
    return true;
  }

  private askAdd(undecided: readonly string[]): Promise<"trust" | "restrict" | "cancel"> {
    return showDialog<"trust" | "restrict" | "cancel">({
      title:
        undecided.length === 1
          ? `Trust the authors of “${basename(undecided[0] ?? "")}”?`
          : `Trust the authors of these ${undecided.length} folders?`,
      message: `${undecided.join("\n")}\n\nThis workspace is trusted. A folder's files can define tasks, launch configurations and tests that run programs on your computer: trust it if you know where it comes from. Restricted, it joins and the whole workspace runs in restricted mode until you trust it.`,
      actions: [
        { label: "Cancel", value: "cancel", variant: "secondary" },
        { label: "Add restricted", value: "restrict", variant: "secondary" },
        { label: "Trust and add", value: "trust", variant: "primary" },
      ],
      cancelValue: "cancel",
      defaultValue: "restrict",
      size: "md",
    });
  }

  /** Folders the user didn't pick (a workspace file changed on disk, network folders): asked. */
  private async confirmAdd(paths: readonly string[], why: "file" | "network"): Promise<boolean> {
    const answer = await showDialog<boolean>({
      title:
        why === "network"
          ? "Open network folders?"
          : `Add ${paths.length === 1 ? "a folder" : `${paths.length} folders`} to the workspace?`,
      message:
        why === "network"
          ? `The workspace file lists folders on another computer:\n${paths.join("\n")}\n\nOpening them connects to that computer with your Windows sign-in. Open them only if you know the workspace file and the computer.`
          : `The workspace file changed and now lists:\n${paths.join("\n")}\n\nAdded, their files are part of the workspace: the agent and extensions can read them. Add them only if you made this change.`,
      actions: [
        { label: "Don't add", value: false, variant: "secondary" },
        { label: why === "network" ? "Open them" : "Add", value: true, variant: "primary" },
      ],
      cancelValue: false,
      defaultValue: false,
      size: "md",
    });
    return answer === true;
  }

  get trusted(): boolean {
    return this.state.peek() === "trusted";
  }

  /**
   * Remembers the decision for the open folder (and, trusting, maybe for its parent folder); in a
   * multi-root workspace, for every one of its folders (D251).
   */
  async set(trusted: boolean, options: { parent?: boolean } = {}): Promise<void> {
    const folders = this.subjects();
    if (!folders.length) throw new Error("No folder is open.");
    const parent = options.parent === true && folders.length === 1;
    // Applied to the decisions on disk: another window may have changed them.
    await this.persistence.saveGlobal((current) => ({
      trust: folders.reduce(
        (trust, folder) => withDecision(trust, folder, trusted, parent),
        current.trust,
      ),
    }));
    // Decided another way (a command, a test script): an open trust dialog has nothing to ask.
    this.dialog?.abort();
    this.state.value = trusted ? "trusted" : "restricted";
    this.inheritedFrom.value = null;
  }

  /**
   * Trusts a folder the IDE just made empty for the user (D273): nothing in it comes from anyone
   * else, so it isn't asked about, and code running in the empty window keeps running when it
   * opens there. Saved before the folder opens; its parent isn't trusted with it.
   */
  async trustCreated(folder: string): Promise<void> {
    await this.persistence.saveGlobal((current) => ({
      trust: withDecision(current.trust, folder, true),
    }));
  }

  /**
   * Resolves when the folder may run `what` (e.g. "Task “build”"): trusted, or the user trusts
   * it now. Restricted folders don't ask again: they throw with how to change it.
   */
  async require(what: string): Promise<void> {
    if (this.trusted) return;
    // An empty window (no folder) is trusted, as VS Code's is by default
    // (security.workspace.trust.emptyWindow, D268): there are no folder's files to protect.
    if (!this.subjects().length) return;
    if (this.state.peek() === "restricted")
      throw new Error(
        `${what} can't run: this folder is in restricted mode. Run "Manage workspace trust" to trust it.`,
      );
    if (!(await this.askOnce(what)))
      throw new Error(`${what} didn't run: the folder stays in restricted mode.`);
  }

  /**
   * The question VS Code asks when a folder opens: once per folder the user hasn't decided about
   * (nothing for one already trusted, itself or through a parent).
   */
  async askOnOpen(): Promise<void> {
    const location = this.workspace.location.peek();
    if (!location || this.state.peek() !== "unknown") return;
    const key = pathKey(location);
    if (this.promptedOnOpen.has(key)) return;
    this.promptedOnOpen.add(key);
    await this.askOnce();
  }

  /** One dialog at a time: a task started while the open-time question shows waits for it. */
  private askOnce(what?: string): Promise<boolean> {
    this.asking ??= this.ask(what).finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  /** The trust dialog, with "Trust the parent folder too"; saves the answer. */
  async ask(what?: string): Promise<boolean> {
    const root = this.workspace.root.peek();
    if (!root) return false;
    const folders = this.workspace.folders.peek();
    const several = folders.length > 1;
    // A multi-root workspace has no one parent to offer.
    const parent = several ? root : dirname(root);
    let trustParent = false;
    const controller = new AbortController();
    this.dialog?.abort();
    this.dialog = controller;
    const answer = await showDialog<"trust" | "restrict" | "cancel">({
      title: several
        ? `Trust the authors of the ${folders.length} folders in “${this.workspace.name.peek() ?? basename(root)}”?`
        : `Trust the authors of “${basename(root)}”?`,
      message: `${several ? `${folders.map((f) => f.name).join(", ")}.\n\n` : ""}${what ? `${what} comes from this folder's files and runs programs on your computer.` : "This folder's files can define tasks, launch configurations and tests that run programs on your computer."}\n\nTrust the folder if you know where it comes from. In restricted mode its tasks, debugging and tests don't run; you can still browse and edit everything, and change this later with "Manage workspace trust".`,
      actions: [
        { label: "Stay restricted", value: "restrict", variant: "secondary" },
        { label: several ? "Trust folders" : "Trust folder", value: "trust", variant: "primary" },
      ],
      cancelValue: "cancel",
      defaultValue: "restrict",
      size: "md",
      signal: controller.signal,
      ...(parent !== root && {
        checkbox: {
          label: `Trust the authors of all files in the parent folder “${basename(parent)}”`,
          detail: parent,
          onCheck: (checked: boolean) => (trustParent = checked),
        },
      }),
    });
    if (this.dialog === controller) this.dialog = null;
    // Aborted: the folder closed, or trust was set while the dialog showed.
    if (controller.signal.aborted) return this.trusted;
    if (answer === "cancel") return false;
    await this.set(answer === "trust", { parent: answer === "trust" && trustParent });
    return answer === "trust";
  }

  dispose(): void {
    this.store.dispose();
  }
}
