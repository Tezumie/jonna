// Workspace trust (PLAN M6, D103). A folder's own files can make the IDE run programs: its tasks
// (.vscode/tasks.json, the IDE's tasks.json, package.json scripts), launch configurations, test
// runners. As in VS Code, the IDE asks whether the user trusts the folder's authors when a folder
// it hasn't decided about opens (`security.workspace.trust.startupPrompt`), and again before the
// first one of those runs if that question was dismissed. The answer is remembered per folder; a
// trusted parent folder covers the folders under it (trustModel.ts). In restricted mode those stay
// off until the user trusts the folder. Settings that start programs (language servers, agents,
// MCP servers) are user-only already, so a folder's settings can't set them.
import type { ContextKeyService } from "../core/context/index";
import { setGitTrust } from "../core/ipc/git";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { pathKey } from "../core/paths/index";
import { effect, type Signal, signal } from "../core/reactive/index";
import type { PersistenceService } from "./persistence";
import { RiskyFolders } from "./riskyFolders";
import { type TrustState, trustOf, withDecision } from "./trustModel";
import { isUntitledWorkspace, type WorkspaceService } from "./workspace";

export type { TrustState } from "./trustModel";

/**
 * The questions trust asks a person. The window answers them with dialogs (trustDialogs.ts);
 * without a screen a policy answers (headless/services.ts).
 */
export interface TrustPrompts {
  /** Folders joining a trusted workspace whose authors aren't decided about yet. */
  addFolders(undecided: readonly string[]): Promise<"trust" | "restrict" | "cancel">;
  /** Folders the user didn't pick (a workspace file changed on disk, network folders). */
  confirmAdd(paths: readonly string[], why: "file" | "network"): Promise<boolean>;
  /**
   * Whether the open folder's authors are trusted (`what`: the thing that wants to run).
   * `trustParent`: the parent folder too. `signal` aborts the question (the folder closed, or
   * trust was set another way); the answer is ignored then.
   */
  folder(request: TrustFolderRequest): Promise<{
    answer: "trust" | "restrict" | "cancel";
    trustParent: boolean;
  }>;
}

export interface TrustFolderRequest {
  root: string;
  folders: readonly { name: string; path: string }[];
  workspaceName: string | null;
  what: string | undefined;
  signal: AbortSignal;
}

export class WorkspaceTrust implements Disposable {
  /** The open folder's state ("unknown" until the user decides, or with no folder). */
  readonly state: Signal<TrustState> = signal<TrustState>("unknown");
  /** The trusted parent folder the open folder's trust comes from, if it isn't its own. */
  readonly inheritedFrom: Signal<string | null> = signal<string | null>(null);
  private readonly store = new DisposableStore();
  private asking: Promise<boolean> | null = null;
  /** The last state sent to the backend has arrived (see `publish`). */
  private published: Promise<void> = Promise.resolve();
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
    private readonly prompts: TrustPrompts,
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
      // Each time, not only when the state changes: a folder that joined is held for git by
      // the backend until it hears the answer for the workspace as it is now.
      this.publish();
    };
    this.store.add(workspace.onDidOpen(update));
    this.store.add(workspace.onDidChangeFolders(update));
    this.store.add(workspace.setTrustGuard((paths, answer) => this.guardAdd(paths, answer)));
    this.store.add(workspace.setAddConfirm((paths, why) => this.prompts.confirmAdd(paths, why)));
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
        ? await this.prompts.addFolders(undecided)
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
    this.publish();
  }

  /**
   * Tells the backend the state (its git runs in the open folders only while they are
   * trusted, and holds a folder from the moment it opens). One call after the other, so the
   * last state is the one that stays.
   */
  private publish(): void {
    const trusted = this.state.peek() === "trusted";
    this.published = this.published.then(() => setGitTrust(trusted)).catch(() => {});
  }

  /** Resolves once the backend has the state as it is now (before git is asked anything). */
  whenPublished(): Promise<void> {
    return this.published;
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

  /** The trust question, with "Trust the parent folder too"; saves the answer. */
  async ask(what?: string): Promise<boolean> {
    const root = this.workspace.root.peek();
    if (!root) return false;
    const controller = new AbortController();
    this.dialog?.abort();
    this.dialog = controller;
    const { answer, trustParent } = await this.prompts.folder({
      root,
      folders: this.workspace.folders.peek(),
      workspaceName: this.workspace.name.peek(),
      what,
      signal: controller.signal,
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
