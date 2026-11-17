// What the Sync tab and the sync commands share besides the controller (D435): the account as
// last read, which step of a flow the tab shows, and the two things that must never reach a
// command's input, its result, state or a log: the recovery key while it is shown, and what the
// person typed back. The tab hands those over here and the command takes them from here, so the
// buttons still only run commands.
import type { AccountProfile } from "../../core/ipc/accounts";
import { type Signal, signal } from "../../core/reactive/index";
import type { SyncPageId } from "./model";
import { ShareLook } from "./shareView.model";
import { SnapshotLook } from "./snapshotView.model";

export type SyncStep =
  | { step: "none" }
  /** The recovery key is on show: to confirm before sync turns on, or a new one to keep. */
  | { step: "key"; purpose: "setup" | "new"; error: string | null }
  /** The recovery key is asked for, to join without another computer. */
  | { step: "recovery"; error: string | null };

export const DEFAULT_DEVICE_NAME = "This computer";

export class SyncSession {
  /** The signed-in account (null: nobody, or not read yet). */
  readonly profile: Signal<AccountProfile | null> = signal<AccountProfile | null>(null);
  readonly step: Signal<SyncStep> = signal<SyncStep>({ step: "none" });
  /** The page the tab shows while sync is on. */
  readonly page: Signal<SyncPageId> = signal<SyncPageId>("overview");
  /** The project whose detail the Projects page shows (null: none picked). */
  readonly projectId: Signal<string | null> = signal<string | null>(null);
  /** The snapshot whose files the Projects page shows instead of the history (none: the history). */
  readonly look = new SnapshotLook();
  /** The teammate's shared project the Team page shows instead of the team (none: the team). */
  readonly shares = new ShareLook();
  /** The command running from the tab now (its buttons wait), by id. */
  readonly working: Signal<string | null> = signal<string | null>(null);
  /** The computer's name as typed in the tab. */
  deviceName = DEFAULT_DEVICE_NAME;
  /** This computer's own name, once read: what the name field starts with. */
  readonly ownName: Signal<string | null> = signal<string | null>(null);

  private shownKey: string | null = null;
  private typed: string | null = null;

  /** Whether sync is open to the signed-in account. */
  available(): boolean {
    return this.profile.peek()?.sync === true;
  }

  /** Takes this computer's own name as the name to join under, unless one was typed. */
  suggestName(name: string): void {
    const own = name.trim();
    if (!own) return;
    if (this.deviceName === DEFAULT_DEVICE_NAME) this.deviceName = own;
    this.ownName.value = own;
  }

  /** The recovery key to show, while its step is open. */
  recoveryKey(): string | null {
    return this.shownKey;
  }

  showKey(key: string, purpose: "setup" | "new"): void {
    this.shownKey = key;
    this.step.value = { step: "key", purpose, error: null };
  }

  /** What the person typed (a confirmation, a recovery key), for the next command to take. */
  offer(text: string): void {
    this.typed = text;
  }

  /** Takes what was typed; it is gone afterwards. */
  take(): string | null {
    const text = this.typed;
    this.typed = null;
    return text;
  }

  /** Leaves the step; the key shown and anything typed are forgotten. */
  closeStep(): void {
    this.shownKey = null;
    this.typed = null;
    if (this.step.peek().step !== "none") this.step.value = { step: "none" };
  }
}
