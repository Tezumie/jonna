// What the agent needs from whoever is in front of it, as seams: whether there is a screen at
// all, who is watching (presence), the questions that don't belong to a chat (an MCP server's
// inputs, sign-in again, elicitation, sampling), and a place to run a workflow's script.
//
// The window sets its own (agentHostDesktop.ts: the document, the quick inputs and dialogs, a web
// worker). With nothing set there is no screen: nobody is watching, a question is answered by
// policy (dismissed unless the policy says otherwise) and stays readable while it waits, and
// there is nowhere to run a script. A run with no window (a terminal, a server) sets its own with
// `setAgentHost(services, headlessAgentHost({ … }))`.
//
// DOM-free: nothing here, or reachable from here, may touch the document.

import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import { type Signal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { promptPolicyOf, type UnattendedPolicy } from "./unattended";

/** Who is watching: the window focused and visible, a chat on screen. */
export interface Presence {
  /** Nobody is looking at the app now (the window hidden or without focus; no front end). */
  away(): boolean;
  /** Chat `session` is on screen now: what a notification would say is already in front of them. */
  showing(session: string): boolean;
  /** Asks for the person's attention outside the app (the taskbar button flashes). */
  requestAttention(): void;
  /** Told when `away` may have changed. */
  onDidChange(listener: () => void): Disposable;
}

/** Nobody is watching, and nothing can call them: a run with no front end. */
export const NOBODY: Presence = {
  away: () => true,
  showing: () => false,
  requestAttention: () => {},
  onDidChange: () => toDisposable(() => {}),
};

/** Why a host prompt is asked (a policy answers by it). */
export type PromptReason =
  /** A server's `${input:…}` value (a password when `password`). */
  | "mcp.input"
  /** A remote server wants more access: sign in again? */
  | "mcp.stepUp"
  /** A server's `elicitation/create`: its question and its fields. */
  | "mcp.elicitation"
  /** A server's `sampling/createMessage`: may it use the person's model? */
  | "mcp.sampling"
  /** The sampled answer, checked before it goes back to the server. */
  | "mcp.samplingReview"
  /** A missing argument of a server's prompt, or a resource template's variable. */
  | "mcp.argument"
  /** A yes or no before a command a person ran does something that can't be taken back. */
  | "confirm";

interface PromptBase {
  reason: PromptReason;
  /** The MCP server asking. */
  server: string;
}

/** A line to type (the window's input box takes these fields as they are). */
export interface TextPrompt extends PromptBase {
  prompt: string;
  value?: string;
  placeholder?: string;
  /** Mask what is typed, and never show it to the agent. */
  password?: boolean;
  /** Returns what is wrong with a value, or undefined. */
  validate?: (value: string) => string | undefined;
  /** Aborted when who asked is gone: this question goes away, answered as dismissed. */
  signal?: AbortSignal;
}

export interface PromptChoice {
  id: string;
  label: string;
  description?: string;
}

/** One of several choices (the window's pick list). */
export interface ChoicePrompt extends PromptBase {
  placeholder: string;
  choices: readonly PromptChoice[];
  /** Aborted when who asked is gone: this question goes away, answered as dismissed. */
  signal?: AbortSignal;
}

/** A text to check, change, then send or reject (the window's dialog). */
export interface ReviewPrompt extends PromptBase {
  title: string;
  message: string;
  /** The label of the text box. */
  label: string;
  text: string;
  /** Aborted when the answer came another way: the question goes away. */
  signal: AbortSignal;
}

/** A yes or no (the window's confirmation dialog). */
export interface ConfirmPrompt {
  reason: "confirm";
  title: string;
  message: string;
  /** The button that says yes ("Delete"). */
  confirmLabel: string;
  /** What it confirms can't be taken back: the button says so by its look. */
  destructive?: boolean;
}

/** How a review ended; `text` is the text as it stood then. */
export interface ReviewAnswer {
  choice: "send" | "reject" | "closed";
  text: string;
}

/**
 * The questions that aren't a chat's own (those wait on the session: its permissions and
 * questions, answered by commands). Dismissing answers `undefined`, as Esc does in the window.
 */
export interface HostPrompts {
  text(prompt: TextPrompt): Promise<string | undefined>;
  /** The chosen choice's id. */
  choose(prompt: ChoicePrompt): Promise<string | undefined>;
  review(prompt: ReviewPrompt): Promise<ReviewAnswer>;
  /** False when turned down or dismissed. */
  confirm(prompt: ConfirmPrompt): Promise<boolean>;
  /**
   * Takes the question on screen away, whoever asked it. Who wants only its own question gone
   * gives that question a `signal` instead: with several waiting, this takes another's.
   */
  cancel(): void;
}

/** A host prompt waiting with no screen: what was asked, and how to answer it. */
export type PendingPrompt = { id: string } & (
  | { kind: "text"; prompt: TextPrompt; answer(value: string | undefined): void }
  | { kind: "choice"; prompt: ChoicePrompt; answer(id: string | undefined): void }
  | { kind: "review"; prompt: ReviewPrompt; answer(answer: ReviewAnswer): void }
  | { kind: "confirm"; prompt: ConfirmPrompt; answer(yes: boolean): void }
);

/** What a prompt gets when there is no screen to show it on. */
export interface PromptPolicy {
  /**
   * `dismiss`: answered at once as if closed (a text or a choice: nothing; a review: rejected;
   * a confirmation: no).
   * `wait`: it stays in `pending` until a front end answers it. `{ answer }`: that answer (the
   * text typed, the choice's id, the reviewed text to send, or "yes" to a confirmation).
   */
  decide(prompt: PendingPrompt): "dismiss" | "wait" | { answer: string };
}

/** Every prompt is dismissed: a server gets no input, no more access, a declined question. */
export const DISMISS_ALL: PromptPolicy = { decide: () => "dismiss" };

/** Host prompts with no screen: answered by policy; the ones that wait are in `pending`. */
export interface HeadlessPrompts extends HostPrompts {
  /** The prompts a front end may answer (a terminal, a remote client), oldest first. */
  readonly pending: Signal<readonly PendingPrompt[]>;
}

export function headlessPrompts(policy: PromptPolicy = DISMISS_ALL): HeadlessPrompts {
  const pending = signal<readonly PendingPrompt[]>([]);
  let next = 1;
  /** Decides `entry` now, or leaves it in `pending`. */
  const settle = (entry: PendingPrompt, dismissed: () => void, given: (answer: string) => void) => {
    const decision = policy.decide(entry);
    if (decision === "wait") pending.value = [...pending.peek(), entry];
    else if (decision === "dismiss") dismissed();
    else given(decision.answer);
  };
  const done = (id: string) => {
    // One the policy answered at once was never in the list: readers aren't told of no change.
    if (pending.peek().some((p) => p.id === id))
      pending.value = pending.peek().filter((p) => p.id !== id);
  };
  /**
   * A text or a choice whose asker may go away: aborting its signal dismisses that one question,
   * and no other. `dismiss` is its answer for "nothing"; it returns what to call once answered.
   */
  const untilGone = (asker: AbortSignal | undefined, dismiss: () => void): (() => void) => {
    if (!asker) return () => {};
    asker.addEventListener("abort", dismiss, { once: true });
    return () => asker.removeEventListener("abort", dismiss);
  };
  return {
    pending,
    text: (prompt) =>
      new Promise((resolve) => {
        // Who asked is already gone: nothing is asked.
        if (prompt.signal?.aborted) return resolve(undefined);
        const id = `hp${next++}`;
        const answer = (value: string | undefined) => {
          answered();
          done(id);
          resolve(value);
        };
        const answered = untilGone(prompt.signal, () => answer(undefined));
        settle({ id, kind: "text", prompt, answer }, () => answer(undefined), answer);
      }),
    choose: (prompt) =>
      new Promise((resolve) => {
        if (prompt.signal?.aborted) return resolve(undefined);
        const id = `hp${next++}`;
        const answer = (value: string | undefined) => {
          answered();
          done(id);
          resolve(value);
        };
        const answered = untilGone(prompt.signal, () => answer(undefined));
        settle({ id, kind: "choice", prompt, answer }, () => answer(undefined), answer);
      }),
    review: (prompt) =>
      new Promise((resolve) => {
        const id = `hp${next++}`;
        const answer = (value: ReviewAnswer) => {
          done(id);
          resolve(value);
        };
        // The answer came another way (the command): the waiting one closes, as the dialog does.
        prompt.signal.addEventListener(
          "abort",
          () => answer({ choice: "closed", text: prompt.text }),
          { once: true },
        );
        settle(
          { id, kind: "review", prompt, answer },
          () => resolve({ choice: "reject", text: prompt.text }),
          (text) => resolve({ choice: "send", text }),
        );
      }),
    confirm: (prompt) =>
      new Promise((resolve) => {
        const id = `hp${next++}`;
        const answer = (yes: boolean) => {
          done(id);
          resolve(yes);
        };
        settle(
          { id, kind: "confirm", prompt, answer },
          () => resolve(false),
          (given) => resolve(given === "yes"),
        );
      }),
    cancel: () => {
      // The newest waiting question goes, as the window's one open quick input would. Whose it
      // is isn't known here: a caller with a question of its own to take back aborts its signal.
      const last = pending.peek().findLast((p) => p.kind === "text" || p.kind === "choice");
      if (last?.kind === "text" || last?.kind === "choice") last.answer(undefined);
    },
  };
}

/** The part of a worker a workflow's script needs (a web Worker, or Node's worker thread). */
export interface ScriptWorker {
  postMessage(message: unknown): void;
  /** Hears each message the script posts (its data). */
  onMessage(listener: (data: unknown) => void): void;
  /** Hears the worker failing (its message; empty when it gave none). */
  onError(listener: (message: string) => void): void;
  terminate(): void;
}

/** Starts the bundled worker script `script` (`workflow`), named `name` for debugging. */
export type WorkerFactory = (script: "workflow", name: string) => ScriptWorker;

export interface AgentHost {
  /**
   * There is a screen: tools that only make sense on one (screenshots, the browser pane, desktop
   * control, widgets) are offered. Without one they are left out of a chat's tools.
   */
  readonly screen: boolean;
  readonly presence: Presence;
  readonly prompts: HostPrompts;
  /** Where a workflow's script runs; null: nowhere, and run_workflow is left out. */
  readonly workers: WorkerFactory | null;
  /**
   * The permission policy of a run with nobody at the window (unattended.ts): its deny and allow
   * lists, and what happens to a question nobody can answer. None in the window: a chat's
   * questions are its cards.
   */
  readonly permissions?: UnattendedPolicy | null;
}

/** The host of a run with no window. Everything defaults to "nobody there". */
export function headlessAgentHost(
  options: {
    presence?: Presence;
    /** A policy, or prompts of the caller's own. */
    prompts?: HostPrompts;
    policy?: PromptPolicy;
    workers?: WorkerFactory | null;
    /** The run's permission policy; host prompts follow it unless `policy` or `prompts` is given. */
    permissions?: UnattendedPolicy | null;
  } = {},
): AgentHost {
  const permissions = options.permissions ?? null;
  return {
    screen: false,
    presence: options.presence ?? NOBODY,
    prompts:
      options.prompts ??
      headlessPrompts(options.policy ?? (permissions ? promptPolicyOf(permissions) : undefined)),
    workers: options.workers ?? null,
    permissions,
  };
}

const hosts = new WeakMap<WorkbenchServices, AgentHost>();

/** The agent's host for these services: the one set, else one for no screen. */
export function agentHost(services: WorkbenchServices): AgentHost {
  let host = hosts.get(services);
  if (!host) {
    host = headlessAgentHost();
    hosts.set(services, host);
  }
  return host;
}

/** Sets the agent's host (the window's, at activation; a headless entry's, before any chat). */
export function setAgentHost(services: WorkbenchServices, host: AgentHost): void {
  hosts.set(services, host);
}
