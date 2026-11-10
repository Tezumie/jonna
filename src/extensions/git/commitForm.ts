// The commit box of Source control: the operation banner (merge / rebase in progress, Continue /
// Abort), the message box with its "write it for me" button, and Commit with VS Code's menu of
// variants (it turns into Publish branch / Sync changes when there's nothing to commit). One
// form for the selected repository; D229: in scm.repositories.selectionMode "multiple", one per
// shown repository (VS Code's input per repository), each committing to its own. Every action
// is a git.* command with that repository.

import { h, on } from "../../core/dom/index";
import type { Disposable } from "../../core/lifecycle/index";
import { DisposableStore, MutableDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { WRITING_COMMIT_MESSAGE } from "./commitMessage";
import type { GitRepo } from "./controller";
import { commitSummary } from "./model";

const OPERATION_NAMES = {
  merge: "Merging",
  rebase: "Rebasing",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
} as const;

/** The message box's text, for the form's repository. */
export interface CommitText {
  get(): string;
  set(value: string): void;
  onChange(fn: () => void): Disposable;
}

export interface CommitFormOptions {
  /** "multiple" mode: the repository's name above the box. */
  title?: string;
  /**
   * Runs before commands that act on the selected repository (writing the message, the
   * Ctrl/Cmd+Enter keybinding): "multiple" mode makes the form's repository the selected one.
   */
  activate?: () => Promise<void>;
}

export class CommitForm implements Disposable {
  private readonly store = new DisposableStore();
  readonly element: HTMLElement;
  readonly message: HTMLTextAreaElement;
  /** The open menu (one at a time; replaced, not accumulated). */
  private readonly menuHandle = this.store.add(new MutableDisposable());
  /** What the primary button runs: commit, or publish / sync when there's nothing to commit. */
  private primary = "git.commit";

  constructor(
    private readonly services: WorkbenchServices,
    private readonly git: GitRepo,
    text: CommitText,
    private readonly options: CommitFormOptions = {},
  ) {
    this.message = h("textarea", {
      class: "input scm-message",
      rows: 2,
      spellcheck: "true",
      "aria-label": options.title ? `Commit message for ${options.title}` : "Commit message",
    });
    this.message.value = text.get();
    const commit = h(
      "button",
      { class: "button button-primary scm-commit", type: "button" },
      icon("check"),
      h("span", {}, "Commit"),
    );
    const more = h(
      "button",
      {
        class: "button button-primary scm-commit-more",
        type: "button",
        "aria-label": "More commit actions",
      },
      icon("chevron-down"),
    );
    setTooltip(more, "More commit actions");
    const write = h(
      "button",
      {
        class: "icon-button scm-generate",
        type: "button",
        "aria-label": "Generate commit message",
      },
      icon("agent"),
    );
    setTooltip(write, "Generate commit message (your model, from the staged changes)");
    const bannerText = h("span", { class: "scm-banner-text" });
    const abort = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      "Abort",
    );
    const proceed = h(
      "button",
      { class: "button button-primary button-sm", type: "button" },
      "Continue",
    );
    const banner = h(
      "div",
      { class: "scm-banner", role: "status", hidden: true },
      icon("git-merge"),
      bannerText,
      abort,
      proceed,
    );
    const title = options.title
      ? h("div", { class: "scm-form-title" }, icon("git-branch"), h("span", {}, options.title))
      : null;
    this.element = h(
      "div",
      { class: `scm-form${title ? " scm-form-repo" : ""}` },
      title,
      banner,
      h("div", { class: "scm-message-wrap" }, this.message, write),
      h("div", { class: "scm-commit-row" }, commit, more),
    );
    if (title) {
      const branch = h("span", { class: "scm-repo-branch" });
      title.append(branch);
      this.store.add(
        effect(() => {
          const b = git.status.value?.branch;
          branch.textContent = b?.head ?? (b?.oid ? b.oid.slice(0, 7) : "");
          return undefined;
        }),
      );
    }

    // While it writes, the button is a stop button (D174).
    const writing = () => git.busy.peek() === WRITING_COMMIT_MESSAGE;
    this.store.add(
      on(write, "click", () =>
        this.runSelected(writing() ? "git.cancelCommitMessage" : "git.generateCommitMessage"),
      ),
    );
    // Hidden when git.aiCommitMessage.enabled is off (it's on by default, D173).
    this.store.add(
      effect(() => {
        services.settings.version.value;
        write.hidden = services.settings.peek<boolean>("git.aiCommitMessage.enabled") === false;
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        const busy = git.busy.value === WRITING_COMMIT_MESSAGE;
        write.replaceChildren(icon(busy ? "square" : "agent"));
        write.classList.toggle("is-running", busy);
        const label = busy
          ? "Stop writing the commit message"
          : "Generate commit message (your model, from the staged changes)";
        write.setAttribute(
          "aria-label",
          busy ? "Stop writing the commit message" : "Generate commit message",
        );
        setTooltip(write, label);
        return undefined;
      }),
    );
    this.store.add(on(abort, "click", () => this.run("git.abortOperation", this.here())));
    this.store.add(on(proceed, "click", () => this.run("git.continueOperation", this.here())));
    this.store.add(on(more, "click", () => this.commitMenu(more)));
    this.store.add(on(commit, "click", () => this.run(this.primary, this.here())));
    this.store.add(
      on(this.message, "input", () => {
        text.set(this.message.value);
        this.autosize();
      }),
    );
    this.store.add(
      text.onChange(() => {
        if (this.message.value !== text.get()) this.message.value = text.get();
        this.autosize();
      }),
    );
    // Ctrl/Cmd+Enter is the git.commit keybinding, active while the box has focus; it commits
    // the selected repository, so focusing the box selects its own ("multiple" mode).
    this.store.add(
      on(this.message, "focus", () => {
        services.context.set("scmMessageFocus", true);
        void options.activate?.();
      }),
    );
    this.store.add(on(this.message, "blur", () => services.context.set("scmMessageFocus", false)));
    // Typing selects it too: a window without the OS focus gets no focus event (pasted text,
    // dictation, the UI tests).
    this.store.add(on(this.message, "input", () => void options.activate?.()));

    this.store.add(
      effect(() => {
        const groups = git.groups.value;
        const branch = git.status.value?.branch.head;
        const key =
          services.keyboard.labelFor("git.commit") ??
          (services.platform === "mac" ? "⌘Enter" : "Ctrl+Enter");
        this.message.placeholder = options.title
          ? `Message (${key} to commit on "${branch ?? options.title}")`
          : `Message (${key} to commit)`;
        this.message.title = branch ? `Commit message for "${branch}"` : "Commit message";
        // Nothing to commit: VS Code's button publishes the branch or syncs it instead.
        const b = git.status.value?.branch;
        const pending = groups.staged.length + groups.changes.length + groups.merge.length;
        const remotes = git.repoState.value?.remotes.length ?? 0;
        let look: [IconName, string, string, string] = [
          "check",
          "Commit",
          "git.commit",
          commitSummary(groups),
        ];
        if (!pending && b?.oid && b.head && !b.upstream)
          look = [
            "cloud-upload",
            remotes ? "Publish branch" : "Publish to GitHub",
            "git.sync",
            remotes ? `Push ${b.head} and track it` : "Create a GitHub repository and push to it",
          ];
        else if (!pending && b?.upstream && (b.ahead > 0 || b.behind > 0))
          look = [
            "refresh-cw",
            "Sync changes",
            "git.sync",
            `Pull ${b.behind} and push ${b.ahead} commit${b.ahead === 1 ? "" : "s"} (${b.upstream})`,
          ];
        this.primary = look[2];
        // Behind / ahead as a count and an arrow icon (VS Code's), not a text arrow that reads
        // like a digit at a glance.
        const counts =
          look[2] === "git.sync" && b?.upstream
            ? [
                ...(b.behind
                  ? [h("span", { class: "scm-sync-count" }, String(b.behind), icon("arrow-down"))]
                  : []),
                ...(b.ahead
                  ? [h("span", { class: "scm-sync-count" }, String(b.ahead), icon("arrow-up"))]
                  : []),
              ]
            : [];
        commit.replaceChildren(icon(look[0]), h("span", {}, look[1]), ...counts);
        setTooltip(commit, look[3]);
        return undefined;
      }),
    );
    // The operation in progress (merge, rebase…): the banner.
    this.store.add(
      effect(() => {
        const op = git.repoState.value?.operation ?? null;
        banner.hidden = op === null;
        if (op) {
          const conflicts = git.groups.value.merge.length;
          bannerText.textContent = `${OPERATION_NAMES[op]}${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve` : " · stage the result, then Continue"}`;
          proceed.disabled = conflicts > 0;
        }
        return undefined;
      }),
    );
    queueMicrotask(() => this.autosize());
  }

  focus(): void {
    this.message.focus();
  }

  private autosize(): void {
    this.message.style.height = "auto";
    this.message.style.height = `${Math.min(this.message.scrollHeight, 160)}px`;
  }

  private commitMenu(anchor: HTMLElement): void {
    const key = (id: string) => this.services.keyboard.labelFor(id);
    const item = (label: string, command: string, glyph: IconName, separatorBefore = false) => ({
      label,
      icon: glyph,
      ...(key(command) && { keybinding: key(command) }),
      ...(separatorBefore && { separatorBefore: true }),
      // The form's repository: no "Choose a repository" picker (D220).
      run: () =>
        command === "git.generateCommitMessage"
          ? this.runSelected(command)
          : this.run(command, this.here()),
    });
    this.menuHandle.value = showMenu(anchor, [
      item("Commit", "git.commit", "git-commit-horizontal"),
      item("Commit staged", "git.commitStaged", "git-commit-horizontal"),
      item("Commit all", "git.commitAll", "git-commit-horizontal"),
      item("Commit (amend)", "git.commitAmend", "git-commit-horizontal"),
      item("Commit & push", "git.commitAndPush", "cloud-upload", true),
      item("Commit & sync", "git.commitAndSync", "refresh-cw"),
      item("Undo last commit", "git.undoLastCommit", "undo-2", true),
      ...(this.services.settings.peek<boolean>("git.aiCommitMessage.enabled") !== false
        ? [item("Generate commit message", "git.generateCommitMessage", "agent", true)]
        : []),
    ]);
  }

  /** `{ repository }` of the form's repository. */
  private here(): { repository?: string } {
    const root = this.git.repo.peek()?.root;
    return root ? { repository: root } : {};
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  /** A command that acts on the selected repository: this form's becomes the selected one first. */
  private runSelected(command: string): void {
    void (async () => {
      await this.options.activate?.();
      await this.services.dispatcher.execute(command, {});
    })().catch(() => {});
  }

  dispose(): void {
    this.store.dispose();
  }
}
