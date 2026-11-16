// The sync commands (D435). Everything the Sync tab's buttons do runs through these. The ones
// that handle keys, approve or remove a computer, or change the folder's files are hidden from
// agents: they need the person. No command takes or returns a recovery key or a verification
// code: the tab shows them, and what the person types back reaches a command through the
// session (session.ts), never through its input.
import { relativeAge } from "../../core/agent/rooms";
import { accountsIpc } from "../../core/ipc/accounts";
import { type SyncStatus, syncIpc } from "../../core/ipc/sync";
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { accountPageUrl, hasPlanPage, hasTeamPage, teamPageUrl } from "../../core/ownServices";
import { Schema, s } from "../../core/schema/index";
import { confirmAction, showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { SnapshotRow, SyncController } from "./controller";
import {
  countOf,
  estimateWarning,
  folderName,
  formatSize,
  lapsedReason,
  lapsedUntil,
  planSituation,
  planUrl,
  projectCounts,
  SYNC_PAGE_IDS,
  snapshotFacts,
  teamOf,
} from "./model";
import { DEFAULT_DEVICE_NAME, type SyncSession } from "./session";

export const SYNC_VIEW = "sync";

const CATEGORY = "Sync";
const DEPENDENCIES_NOTE =
  "Dependencies never travel with a snapshot: install them again if the project needs them.";

const codeOf = (err: unknown): string =>
  err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";

const nullSchema = new Schema<null>({ type: "null" }, (value, path, issues) => {
  if (value !== null) issues.push({ path, message: "expected null" });
});

export interface SyncCommandParts {
  /** Null without a screen: sync runs in the window only, and the commands say so. */
  controller: SyncController | null;
  session: SyncSession;
}

export function registerSyncCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  { controller, session }: SyncCommandParts,
): void {
  const { dispatcher, dock, notifications, quickInput } = services;
  const sync = (): SyncController => {
    if (!controller) throw new Error("Sync runs only in the IDE's window.");
    return controller;
  };

  const showTab = (): string => dock.openView(SYNC_VIEW, null, "main", true);

  /** The accounts server, once sync is known to be open to the signed-in account. */
  const open = async (): Promise<string> => {
    const base = sync().base();
    if (!base) throw new Error("Sync needs an account, and this build has no accounts service.");
    const profile = await accountsIpc.profile(base).catch(() => null);
    if (JSON.stringify(profile) !== JSON.stringify(session.profile.peek()))
      session.profile.value = profile;
    if (!profile) throw new Error("Sign in to your account to use sync.");
    if (profile.sync !== true) throw new Error("Sync isn't open to this account yet.");
    return base;
  };

  /** Where sync stands, read again when what's known is from before the sign-in. */
  const standing = async (): Promise<SyncStatus> => {
    const known = sync().status.peek();
    if (known && known.state !== "signedOut" && known.state !== "unavailable") return known;
    const read = await sync().refreshStatus();
    if (!read) throw new Error("Sync needs an account, and this build has no accounts service.");
    return read;
  };

  /** The accounts server, once sync is on for this computer. */
  const whenOn = async (): Promise<string> => {
    const base = await open();
    if ((await standing()).state !== "on")
      throw new Error("Sync is off on this computer. Turn it on in the Sync tab first.");
    return base;
  };

  /** Refuses what writes to the account while its subscription is ended. */
  const refuseLapsed = (): void => {
    if (planSituation(session.profile.peek(), sync().status.peek()) === "lapsed")
      throw new Error(lapsedReason(teamOf(session.profile.peek())));
  };

  /** The accounts server, once sync is on here and the account can be written to. */
  const whenWritable = async (): Promise<string> => {
    const base = await whenOn();
    refuseLapsed();
    return base;
  };

  const nameOf = (given: string | undefined): string => {
    const name = (given ?? session.deviceName).trim() || DEFAULT_DEVICE_NAME;
    session.deviceName = name;
    return name;
  };

  const describe = (row: SnapshotRow): string =>
    `${row.summary.pinned ? `"${row.summary.pinned}", ` : ""}${row.summary.deviceName}, ${relativeAge(row.summary.time)}`;

  const snapshot = (id: string): SnapshotRow => {
    const row = sync()
      .snapshots.peek()
      .find((r) => r.id === id);
    if (!row) throw new Error("That snapshot is gone.");
    return row;
  };

  /** Restores a snapshot, asking first about the folder's own changes. */
  const restore = async (row: SnapshotRow, confirmFirst: boolean) => {
    const changes = await sync().localChanges();
    let stash = false;
    if (changes.length > 0) {
      const shown = changes.slice(0, 8).join("\n");
      const more = changes.length > 8 ? `\n…and ${changes.length - 8} more` : "";
      stash = await showDialog<boolean>({
        title: `This folder has ${countOf(changes.length, "changed file")} of its own`,
        message: `Restoring the snapshot from ${describe(row)} would replace them. They can be stashed first, so nothing is lost.\n\n${shown}${more}`,
        actions: [
          { label: "Cancel", value: false },
          { label: "Stash them and continue", value: true, variant: "primary" },
        ],
        cancelValue: false,
      });
      if (!stash) return { restored: false, cancelled: true };
    } else if (confirmFirst) {
      const ok = await confirmAction(
        "Restore this snapshot?",
        `The folder is brought to the snapshot from ${describe(row)} (${countOf(row.summary.files, "file")}).`,
        "Restore",
      );
      if (!ok) return { restored: false, cancelled: true };
    }
    let done: Awaited<ReturnType<SyncController["restore"]>>;
    try {
      done = await sync().restore(row.id, stash);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (code !== "SyncDirty" || stash) throw err;
      // A folder without git: files here differ from the snapshot's. Asked, then kept aside.
      const go = await showDialog<boolean>({
        title: "This folder has files of its own that differ",
        message: `${err instanceof Error ? err.message : String(err)} Restoring the snapshot from ${describe(row)} would replace them. Their current versions can be kept in a folder of their own first.`,
        actions: [
          { label: "Cancel", value: false },
          { label: "Keep them aside and continue", value: true, variant: "primary" },
        ],
        cancelValue: false,
      });
      if (!go) return { restored: false, cancelled: true };
      done = await sync().restore(row.id, true);
    }
    const lines = [
      `Restored ${countOf(done.files, "file")}${done.deleted ? ` and removed ${done.deleted}` : ""}${done.branch ? ` on ${done.branch}` : ""}.`,
      ...(done.stashed ? [`Your own changes are in a stash: ${done.stashed}`] : []),
      ...done.notes,
      DEPENDENCIES_NOTE,
    ];
    if (done.notes.length > 0 || done.stashed)
      await showDialog({
        title: "Snapshot restored",
        message: lines.join("\n\n"),
        actions: [{ label: "OK", value: true, variant: "primary" }],
        cancelValue: true,
      });
    else notifications.show("success", lines.join(" "), { title: "Sync" });
    return {
      restored: true,
      files: done.files,
      deleted: done.deleted,
      branch: done.branch,
      detached: done.detached,
      stashed: done.stashed !== null,
      notes: done.notes,
    };
  };

  /** Removes a computer (this one: sync goes off here) after the person agrees. */
  const remove = async (base: string, status: SyncStatus, id: string) => {
    const device = status.devices.find((d) => d.id === id);
    const mine = id === status.deviceId;
    if (!device && !mine) throw new Error("No such computer in this account's sync.");
    const name = device?.name ?? status.deviceName ?? DEFAULT_DEVICE_NAME;
    // A request that was never approved has nothing to lose: no question.
    const waiting = mine ? status.state === "pending" : device?.status === "pending";
    if (!waiting) {
      const last = status.devices.filter((d) => d.status === "approved").length <= 1;
      const ok = mine
        ? await confirmAction(
            "Turn sync off on this computer?",
            `This computer stops syncing and is removed from the account's computers. What is already here stays: your settings, files, chats and projects.\n\nThe synced copy stays in the account for your other computers. To delete it, use Reset sync on the account page.${last ? "\n\nThis is the only computer that syncs: afterwards the recovery key is the only way back to the synced copy." : ""}`,
            "Turn off",
            true,
          )
        : await confirmAction(
            `Remove ${name} from sync?`,
            "It stops syncing and can't read anything synced from now on. What it already has stays on it.",
            "Remove",
            true,
          );
      if (!ok) return { removed: false, cancelled: true };
    }
    await syncIpc.removeDevice(base, id);
    if (mine) session.closeStep();
    await sync().refreshStatus();
    if (!mine) sync().note(`${name} was removed from sync.`);
    return { removed: true, device: name, current: mine };
  };

  sub.add(
    dispatcher.register({
      id: "sync.show",
      title: "Sync",
      category: CATEGORY,
      description:
        "Opens the Sync tab: turning sync on or joining it, and once it is on its pages: overview (state, counts, what needs attention), projects (the open folder, every project by name, a project's snapshot history), content (what syncs and what the account holds of it), computers, security (the recovery key, what the service can see), storage and activity. `page` opens one of them; `project` (with page \"projects\") shows that project's detail. State: ide://sync.",
      input: s.object({
        page: s.enum(SYNC_PAGE_IDS).describe("The page to show").optional(),
        project: s
          .string()
          .describe("A project's id (ide://sync overview.projects), to show its detail")
          .optional(),
      }),
      effects: [],
      agent: "discoverable",
      needsScreen: true,
      run: ({ page, project }) => {
        if (project !== undefined) {
          session.projectId.value = project;
          session.page.value = page ?? "projects";
        } else if (page !== undefined) session.page.value = page;
        const tabId = showTab();
        void open()
          .then(() => sync().pass(true))
          .catch(() => {});
        return { tabId, page: session.page.peek() };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.turnOn",
      title: "Turn on sync…",
      category: CATEGORY,
      description:
        "Starts sync for an account that doesn't sync yet, from this computer: the Sync tab shows the recovery key for the person to keep, and they confirm it there before anything is sent. Never returns the key.",
      input: s.object({
        name: s.string({ maxLength: 80 }).describe("This computer's name").optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ name }) => {
        const base = await open();
        const status = await standing();
        if (status.state === "on") throw new Error("Sync is already on on this computer.");
        refuseLapsed();
        const step = session.step.peek();
        const typed = step.step === "key" && step.purpose === "setup" ? session.take() : null;
        if (typed !== null) {
          // The confirmation typed in the tab: only now is anything sent.
          try {
            await syncIpc.setup(base, typed);
          } catch (err) {
            if (codeOf(err) !== "SyncRecoveryKey") throw err;
            session.step.value = {
              step: "key",
              purpose: "setup",
              error: "That doesn't match the recovery key. Check its last four characters.",
            };
            return { state: "off", confirmed: false };
          }
          session.closeStep();
          await sync().pass(true);
          notifications.show("success", "Sync is on.", { title: "Sync" });
          return { state: sync().status.peek()?.state ?? "on", confirmed: true };
        }
        if (status.exists)
          throw new Error("This account already syncs: join it from this computer instead.");
        session.showKey(await syncIpc.prepare(base, nameOf(name)), "setup");
        showTab();
        return { state: "off", step: "recoveryKey" };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.join",
      title: "Join sync…",
      category: CATEGORY,
      description:
        "Asks to join the account's sync from this computer. It then waits: on a computer that already syncs, the person chooses Check code for this one, both show the same code, and that computer approves it.",
      input: s.object({
        name: s.string({ maxLength: 80 }).describe("This computer's name").optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ name }) => {
        const base = await open();
        const status = await standing();
        if (status.state === "on") throw new Error("Sync is already on on this computer.");
        refuseLapsed();
        if (status.state !== "pending") {
          if (!status.exists)
            throw new Error("This account doesn't sync yet: turn sync on from this computer.");
          // The code to compare shows in the tab, from the status, once another computer
          // starts checking this one.
          await syncIpc.join(base, nameOf(name));
          await sync().refreshStatus();
        }
        session.closeStep();
        showTab();
        return { state: sync().status.peek()?.state ?? "pending" };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.useRecoveryKey",
      title: "Join sync with the recovery key…",
      category: CATEGORY,
      description:
        "Joins the account's sync from this computer with the recovery key instead of another computer's approval: the Sync tab asks for the key. The key is typed there, never passed to a command.",
      input: s.empty(),
      effects: ["network"],
      agent: "hidden",
      run: async () => {
        const base = await open();
        const status = await standing();
        if (status.state === "on") throw new Error("Sync is already on on this computer.");
        refuseLapsed();
        if (!status.exists)
          throw new Error("This account doesn't sync yet: turn sync on from this computer.");
        const key = session.step.peek().step === "recovery" ? session.take() : null;
        if (key === null) {
          session.closeStep();
          session.step.value = { step: "recovery", error: null };
          showTab();
          return { state: status.state, step: "enterRecoveryKey" };
        }
        try {
          await syncIpc.joinRecovery(base, nameOf(undefined), key);
        } catch (err) {
          if (codeOf(err) !== "SyncRecoveryKey") throw err;
          session.step.value = {
            step: "recovery",
            error: "That isn't this account's recovery key. Check it and try again.",
          };
          return { state: status.state, joined: false };
        }
        session.closeStep();
        await sync().pass(true);
        notifications.show("success", "Sync is on.", { title: "Sync" });
        return { state: sync().status.peek()?.state ?? "on", joined: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.closeStep",
      title: "Close the sync step",
      category: CATEGORY,
      description:
        "Leaves the Sync tab's recovery-key step (the key on show, or the key being asked for) without changing anything; a key that was shown is forgotten.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      palette: false,
      run: () => {
        session.closeStep();
        return { closed: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.reviewDevice",
      title: "Check a waiting computer's code…",
      category: CATEGORY,
      description:
        "Starts checking a computer that asked to join: once the waiting computer has answered (a moment later), it and this computer both show the same six-digit code in their Sync tabs, for the person to compare before approving. Never returns the code.",
      input: s.object({ device: s.string().describe("The waiting device's id (ide://sync)") }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ device }) => {
        await whenWritable();
        const waiting = sync()
          .status.peek()
          ?.devices.find((d) => d.id === device && d.status === "pending");
        if (!waiting) throw new Error("No computer with that id is waiting to join.");
        // The code shows in the tab, from the status, once the waiting computer has answered
        // (the controller keeps asking until it has).
        await sync().reviewDevice(device);
        session.page.value = "computers";
        showTab();
        return { device: waiting.name, checking: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.approveDevice",
      title: "Approve a computer…",
      category: CATEGORY,
      description:
        "Lets a computer that asked to join read this account's sync. Only after sync.reviewDevice, and after the person checked that both computers show the same code (the Sync tab shows it).",
      input: s.object({ device: s.string().describe("The waiting device's id (ide://sync)") }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ device }) => {
        const base = await whenWritable();
        const waiting = sync()
          .status.peek()
          ?.devices.find((d) => d.id === device && d.status === "pending");
        if (!waiting) throw new Error("No computer with that id is waiting to join.");
        if (waiting.code === null) throw new Error("Check that device's code first.");
        await syncIpc.approve(base, device);
        await sync().refreshStatus();
        sync().note(`${waiting.name} was approved and now syncs.`);
        notifications.show("success", `${waiting.name} now syncs.`, { title: "Sync" });
        return { approved: waiting.name };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.renameDevice",
      title: "Rename this computer…",
      category: CATEGORY,
      description:
        "Gives this computer another name in the account's list of computers (what the Sync tab, the other computers and the account page show). Without `name`, asks for one. Only a computer can rename itself.",
      input: s.object({
        name: s.string().describe("The new name (at most 80 characters)").optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ name }) => {
        await open();
        const status = await standing();
        if (!status.deviceId || (status.state !== "on" && status.state !== "pending"))
          throw new Error("Sync is off on this computer. Turn it on in the Sync tab first.");
        refuseLapsed();
        let wanted = name;
        if (wanted === undefined) {
          wanted = await quickInput.prompt({
            prompt: "A name for this computer",
            value: status.deviceName ?? "",
            validate: (value) => (value.trim() ? undefined : "Give it a name."),
          });
          if (wanted === undefined) return { renamed: false, cancelled: true };
        }
        if (!wanted.trim()) throw new Error("Give the computer a name.");
        const kept = await sync().renameDevice(wanted.trim());
        return { renamed: true, name: kept };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.removeDevice",
      title: "Remove a computer from sync…",
      category: CATEGORY,
      description:
        "Removes a computer from the account's sync after asking: it stops syncing and can't read what's synced from then on. Removing this computer turns sync off here.",
      input: s.object({ device: s.string().describe("The device's id (ide://sync)") }),
      // Asked in run (the question names the computer).
      effects: ["network"],
      agent: "hidden",
      run: async ({ device }) => {
        const base = await open();
        return remove(base, await standing(), device);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.turnOff",
      title: "Turn off sync on this computer…",
      category: CATEGORY,
      description:
        "Removes this computer from the account's sync after asking (a request to join that is still waiting is just withdrawn). Settings, files and chats stay here.",
      input: s.empty(),
      effects: ["network"],
      agent: "hidden",
      run: async () => {
        const base = await open();
        const status = await standing();
        if (!status.deviceId || (status.state !== "on" && status.state !== "pending"))
          throw new Error("Sync is already off on this computer.");
        return remove(base, status, status.deviceId);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.newRecoveryKey",
      title: "Make a new recovery key…",
      category: CATEGORY,
      description:
        "Replaces the account's recovery key after asking; the old one stops working. The Sync tab shows the new key once, for the person to keep. Never returns it.",
      input: s.empty(),
      effects: ["network"],
      agent: "hidden",
      run: async () => {
        const base = await whenWritable();
        const ok = await confirmAction(
          "Make a new recovery key?",
          "The old recovery key stops working. The new one is shown once: keep it somewhere safe.",
          "Make a new key",
        );
        if (!ok) return { made: false, cancelled: true };
        session.showKey(await syncIpc.newRecoveryKey(base), "new");
        showTab();
        void sync()
          .refreshStatus()
          .catch(() => {});
        return { made: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.syncNow",
      title: "Sync now",
      category: CATEGORY,
      description:
        "Runs one sync pass now (settings, the user's own files, chats, the open project's snapshot) and returns how it went. While the account's subscription is ended the pass only reads the account and the state is \"lapsed\".",
      input: s.empty(),
      effects: ["network"],
      agent: "discoverable",
      run: async () => {
        await whenOn();
        await sync().pass(true);
        const { state, message, at } = sync().activity.peek();
        return { state, message, at };
      },
    }),
  );

  /** Opens the open folder's list of what snapshots leave out (made when it is missing). */
  const editIgnore = async () => {
    const path = await sync().ignoreFile();
    await dispatcher.execute("editor.openFile", { path });
    notifications.show(
      "info",
      "One pattern a line, as in a .gitignore file: a folder (build/), a kind of file (*.mp4), a path. What matches stays out of this project's snapshots.",
      { title: "Sync" },
    );
    return path;
  };

  const projectSync = async (on: boolean) => {
    // Stopping only changes this computer's note; starting writes to the account.
    await (on ? whenWritable() : whenOn());
    if (!services.workspace.root.peek()) throw new Error("Open a folder first.");
    if (services.workspace.remote.peek())
      throw new Error("Only folders on this computer can sync.");
    if (on) {
      // A copied folder carries the id file of the folder it was copied from: asked once,
      // before the two sync as one project.
      const other = await sync().copiedFrom();
      if (other) {
        const answer = await showDialog<"same" | "own" | null>({
          title: `Is this the same project as ${folderName(other) || other}?`,
          message: `This folder has the same project identity as ${other}, which syncs from this computer. The same project shares its chats and snapshots with that folder. A project of its own starts with a new identity and nothing synced.`,
          actions: [
            { label: "Cancel", value: null },
            { label: "A project of its own", value: "own" },
            { label: "The same project", value: "same", variant: "primary" },
          ],
          cancelValue: null,
        });
        if (answer === null) return { root: services.workspace.root.peek(), on: false };
        if (answer === "own") await sync().separateProject();
      }
      // A large folder without git would be stored whole: said first, with a way to leave
      // things out. (An estimate that fails isn't a reason not to sync.)
      const estimate = await sync()
        .estimate()
        .catch(() => null);
      const warning = estimate ? estimateWarning(estimate) : null;
      if (warning !== null) {
        const answer = await showDialog<"sync" | "ignore" | null>({
          title: "This is a large folder to sync",
          message: warning,
          actions: [
            { label: "Cancel", value: null },
            { label: "Choose what to leave out…", value: "ignore" },
            { label: "Sync it", value: "sync", variant: "primary" },
          ],
          cancelValue: null,
        });
        if (answer === "ignore") {
          await editIgnore();
          return { root: services.workspace.root.peek(), on: false, editingIgnore: true };
        }
        if (answer === null) return { root: services.workspace.root.peek(), on: false };
      }
    }
    await sync().setProjectSync(on);
    const project = sync().project.peek();
    return { root: project?.root ?? null, on: project?.on ?? false };
  };

  /** One of the account's projects, by id. */
  const accountProject = (id: string) => {
    const found = sync()
      .overview.peek()
      .projects.find((p) => p.id === id);
    if (!found) throw new Error("The account has no project with that id.");
    return found;
  };

  sub.add(
    dispatcher.register({
      id: "sync.project.enable",
      title: "Sync this project",
      category: CATEGORY,
      description:
        "Syncs the open folder from this computer: its chats travel, and snapshots of its unfinished work are taken automatically.",
      input: s.empty(),
      effects: ["write", "network"],
      agent: "hidden",
      run: () => projectSync(true),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.disable",
      title: "Stop syncing this project",
      category: CATEGORY,
      description:
        "Stops syncing the open folder from this computer. What's already synced stays in the account.",
      input: s.empty(),
      effects: ["write"],
      agent: "hidden",
      run: () => projectSync(false),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.editIgnore",
      title: "Choose what snapshots leave out…",
      category: CATEGORY,
      description:
        "Opens the open folder's .syncignore in the editor (made with an explanation when missing): patterns as in a .gitignore file for what stays out of the project's snapshots.",
      input: s.empty(),
      effects: ["write"],
      agent: "discoverable",
      run: async () => {
        await open();
        if (!services.workspace.root.peek()) throw new Error("Open a folder first.");
        if (services.workspace.remote.peek())
          throw new Error("Only folders on this computer can sync.");
        return { path: await editIgnore() };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.rename",
      title: "Rename a synced project…",
      category: CATEGORY,
      description:
        "Gives one of the account's projects another name: what the Sync tab on every computer and the account page show. No folder is renamed. Without `name`, asks for one.",
      input: s.object({
        id: s.string().describe("The project's id (ide://sync overview.projects)"),
        name: s.string().describe("The new name (at most 80 characters)").optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ id, name }) => {
        await whenWritable();
        const project = accountProject(id);
        let wanted = name;
        if (wanted === undefined) {
          wanted = await quickInput.prompt({
            prompt: "A name for this project (folders keep their own names)",
            value: project.name,
            validate: (value) => (value.trim() ? undefined : "Give it a name."),
          });
          if (wanted === undefined) return { renamed: false, cancelled: true };
        }
        const text = wanted.trim().slice(0, 80);
        if (!text) throw new Error("Give the project a name.");
        await sync().renameProject(id, text);
        return { renamed: true, id, name: text };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.forgetFolder",
      title: "Forget a folder that synced from this computer…",
      category: CATEGORY,
      description:
        "Stops syncing a folder from this computer: removes this computer's note that the folder syncs from here (a folder that was moved or deleted, or a project no longer wanted here). Nothing in the account is touched: the project, its chats and its snapshots stay there until deleted from the account.",
      input: s.object({
        folder: s.string().describe("The folder's path (ide://sync overview.projects[].folder)"),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ folder }) => {
        await whenOn();
        const forgotten = await sync().forgetFolder(folder);
        if (!forgotten) throw new Error("No folder with that path syncs from this computer.");
        return { forgotten: true, folder };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.link",
      title: "This folder is one of my synced projects…",
      category: CATEGORY,
      description:
        "Makes the open folder one of the account's projects that isn't on this computer yet (its identity is written to the folder), then syncs it from here: its chats arrive and its snapshots can be continued from. Without `id`, asks which project.",
      input: s.object({
        id: s.string().describe("The project's id (ide://sync overview.projects)").optional(),
      }),
      effects: ["write", "network"],
      agent: "hidden",
      run: async ({ id }) => {
        await whenWritable();
        if (!services.workspace.root.peek()) throw new Error("Open a folder first.");
        if (services.workspace.remote.peek())
          throw new Error("Only folders on this computer can sync.");
        if (sync().project.peek()?.on)
          throw new Error("This folder already syncs. Stop syncing it first.");
        let target = id;
        if (target === undefined) {
          const others = sync()
            .overview.peek()
            .projects.filter((p) => !p.here);
          if (others.length === 0)
            throw new Error("Every project in the account is already on this computer.");
          const picked = await quickInput.pick(
            others.map((p) => ({
              id: p.id,
              label: p.name,
              description: [
                projectCounts(p),
                p.lastChange === null ? null : `changed ${relativeAge(p.lastChange)}`,
              ]
                .filter(Boolean)
                .join(" · "),
            })),
            { placeholder: "Which of your synced projects is this folder?" },
          );
          if (!picked) return { linked: false, cancelled: true };
          target = picked.id;
        }
        const project = accountProject(target);
        if (project.here)
          throw new Error(
            `${project.name} already syncs from ${project.folder ?? "this computer"}.`,
          );
        await sync().linkProject(target);
        notifications.show("success", `This folder now syncs as ${project.name}.`, {
          title: "Sync",
        });
        return { linked: true, id: target, name: project.name };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.deleteFromAccount",
      title: "Delete a project from the account…",
      category: CATEGORY,
      description:
        "Deletes one project's synced copy from the account after asking: its snapshots and its chats' synced copies. Nothing on any computer is deleted; a computer that still syncs the project uploads it again. The open folder's own project stops syncing from here first.",
      input: s.object({
        id: s.string().describe("The project's id (ide://sync overview.projects)"),
      }),
      // Asked in run (the question names the project).
      effects: ["write", "network"],
      agent: "hidden",
      run: async ({ id }) => {
        await whenWritable();
        const project = accountProject(id);
        const open = sync().project.peek();
        const isOpen = !!open?.on && open.id === id;
        const ok = await confirmAction(
          `Delete ${project.name} from the account?`,
          [
            `Its snapshots (${project.snapshots}) and the synced copies of its chats (${project.chats}) are removed from the account. This can't be undone.`,
            "Nothing on any computer is deleted: the folders and the chats saved on your computers stay as they are.",
            "Another computer that still syncs this project uploads it again, so stop syncing it there first.",
            ...(project.here ? ["It stops syncing from this computer first."] : []),
          ].join("\n\n"),
          "Delete from the account",
          true,
        );
        if (!ok) return { deleted: false, cancelled: true };
        if (isOpen) await sync().setProjectSync(false);
        // Every folder here that is this project, or its chats would be uploaded again.
        await sync().stopSyncingProject(id);
        const { removed, failed } = await sync().deleteProjectFromAccount(id);
        if (failed > 0)
          throw new Error(
            `${countOf(failed, "item")} of ${project.name} couldn't be deleted (another computer changed them meanwhile). Try again.`,
          );
        notifications.show("success", `${project.name} was deleted from the account.`, {
          title: "Sync",
        });
        return { deleted: true, id, name: project.name, removed };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.create",
      title: "Snapshot now",
      category: CATEGORY,
      description:
        "Takes a snapshot of the open project's unfinished work now (uncommitted and unpushed work of a git project; otherwise its files without heavy folders).",
      input: s.empty(),
      effects: ["network"],
      agent: "discoverable",
      run: async () => {
        await whenWritable();
        const created = await sync().snapshotNow();
        if (!created) return { created: false };
        notifications.show(
          "success",
          `Snapshot taken: ${snapshotFacts(created.summary.files, created.summary.bytes, ", ")}.`,
          { title: "Sync" },
        );
        return {
          created: true,
          id: created.id,
          files: created.summary.files,
          bytes: created.summary.bytes,
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.continue",
      title: "Continue from another computer",
      category: CATEGORY,
      description:
        "Brings the open project to the newest snapshot another computer made. Asks first when the folder has changes of its own (they can be stashed).",
      input: s.empty(),
      effects: ["write", "network"],
      agent: "hidden",
      run: async () => {
        await whenOn();
        const row = sync().continueFrom();
        if (!row) throw new Error("No other computer has a newer snapshot of this project.");
        return restore(row, false);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.restore",
      title: "Restore a snapshot…",
      category: CATEGORY,
      description:
        "Brings the open project to one of its snapshots after asking. Changes of the folder's own can be stashed first; dependencies aren't part of a snapshot.",
      input: s.object({ id: s.string().describe("The snapshot's id (ide://sync)") }),
      effects: ["write", "network"],
      agent: "hidden",
      run: async ({ id }) => {
        await whenOn();
        return restore(snapshot(id), true);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.restoreFile",
      title: "Restore a file from a snapshot…",
      category: CATEGORY,
      description:
        "Brings one file of the open project to how a snapshot has it, after asking. Without `path`, lists the snapshot's files to pick one.",
      input: s.object({
        id: s.string().describe("The snapshot's id (ide://sync)"),
        path: s.string().describe("The file, relative to the folder").optional(),
      }),
      effects: ["write", "network"],
      agent: "hidden",
      run: async ({ id, path }) => {
        await whenOn();
        const row = snapshot(id);
        let target = path;
        if (target === undefined) {
          const files = (await sync().snapshotFiles(id)).filter((f) => !f.deleted);
          if (files.length === 0) throw new Error("That snapshot has no files to restore.");
          const picked = await quickInput.pick(
            files.map((f) => ({ id: f.path, label: f.path, description: formatSize(f.size) })),
            { placeholder: `Restore a file from ${describe(row)}` },
          );
          if (!picked) return { restored: false, cancelled: true };
          target = picked.id;
        }
        const ok = await confirmAction(
          "Restore this file?",
          `${target} is replaced by how the snapshot from ${describe(row)} has it.`,
          "Restore",
        );
        if (!ok) return { restored: false, cancelled: true };
        await sync().restoreFile(id, target);
        notifications.show("success", `Restored ${target}.`, { title: "Sync" });
        return { restored: true, path: target };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.pin",
      title: "Pin a snapshot…",
      category: CATEGORY,
      description:
        "Pins a snapshot under a name, so history never removes it; `name` null unpins it. Without `name`, asks for one.",
      input: s.object({
        id: s.string().describe("The snapshot's id (ide://sync)"),
        name: s.union(s.string({ maxLength: 80 }), nullSchema).optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ id, name }) => {
        await whenWritable();
        const row = snapshot(id);
        let pinned: string | null | undefined = name;
        if (pinned === undefined) {
          pinned = await quickInput.prompt({
            prompt: "A name for this snapshot (pinned snapshots are kept)",
            value: row.summary.pinned ?? "",
            validate: (value) => (value.trim() ? undefined : "Give it a name."),
          });
          if (pinned === undefined) return { pinned: row.summary.pinned ?? null, cancelled: true };
        }
        const text = pinned === null ? null : pinned.trim();
        if (text === "") throw new Error("Give the snapshot a name, or null to unpin it.");
        await sync().pin(id, text);
        return { id, pinned: text };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.delete",
      title: "Delete a snapshot…",
      category: CATEGORY,
      description: "Deletes one of the open project's snapshots after asking. This is final.",
      input: s.object({ id: s.string().describe("The snapshot's id (ide://sync)") }),
      // Asked in run (the question says which snapshot).
      effects: ["network"],
      agent: "hidden",
      run: async ({ id }) => {
        await whenWritable();
        const row = snapshot(id);
        const ok = await confirmAction(
          "Delete this snapshot?",
          `The snapshot from ${describe(row)} is deleted for every computer. This can't be undone.`,
          "Delete",
          true,
        );
        if (!ok) return { deleted: false, cancelled: true };
        await sync().deleteSnapshot(id);
        return { deleted: true, id };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.openAccountPage",
      title: "Open the account page",
      category: CATEGORY,
      description:
        "Opens the account page in the browser: devices, storage, and resetting sync when every computer and the recovery key are lost.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        const base = sync().base();
        if (!base) throw new Error("This build has no accounts service.");
        await openerIpc.openUrl(accountPageUrl(base));
        return { opened: true };
      },
    }),
  );

  /** The accounts server and the signed-in account, as saved (`fresh`: as the server has it). */
  const account = async (fresh: boolean) => {
    const base = sync().base();
    if (!base) throw new Error("Sync needs an account, and this build has no accounts service.");
    const saved = () => accountsIpc.profile(base).catch(() => null);
    // A server that can't be reached answers with the saved profile; so does a failed call.
    const profile = fresh ? await accountsIpc.check(base).catch(saved) : await saved();
    if (JSON.stringify(profile) !== JSON.stringify(session.profile.peek()))
      session.profile.value = profile;
    if (!profile) throw new Error("Sign in to your account to use sync.");
    return { base, profile };
  };

  sub.add(
    dispatcher.register({
      id: "sync.managePlan",
      title: "Manage plan…",
      category: CATEGORY,
      description:
        "Opens the account page's plan section in the browser: subscribing to Sync or renewing it, cancelling, cards, invoices and more storage. Payment happens only on that page, never in the IDE. Afterwards sync.checkPlan reads the account again (coming back to the window does too).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        if (!hasPlanPage()) throw new Error("This build has no plan page.");
        const { base } = await account(false);
        await openerIpc.openUrl(planUrl(base));
        return { opened: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.manageTeam",
      title: "Manage team…",
      category: CATEGORY,
      description:
        "Opens the account page's team section in the browser. A subscriber invites people into a team there: each member has Sync through it, the owner pays one seat a person, and the team shares one pool of storage. Inviting, removing, leaving and seats happen only on that page, never in the IDE; ide://sync says the team the account is in (`team`). Fails when the build's service has no teams.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        if (!hasTeamPage()) throw new Error("This build has no team page.");
        const { base } = await account(false);
        await openerIpc.openUrl(teamPageUrl(base));
        return { opened: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.checkPlan",
      title: "Check plan again",
      category: CATEGORY,
      description:
        'Reads the account and where sync stands again now, so a subscription bought or renewed in the browser shows without a restart. Returns `plan`: "on" (the account has sync), "lapsed" (its subscription ended; `lapsedUntil` is when what is synced is deleted, in ms), "offered" (it could subscribe) or "none"; and `state`, where sync stands on this computer (ide://sync).',
      input: s.empty(),
      effects: ["network"],
      agent: "discoverable",
      run: async () => {
        const { profile } = await account(true);
        // Reads the status (and syncs, when the account can be written to again).
        await sync().recheck();
        const status = sync().status.peek();
        const plan = planSituation(profile, status);
        return {
          plan,
          state: status?.state ?? "off",
          lapsedUntil: plan === "lapsed" ? lapsedUntil(profile, status) : null,
        };
      },
    }),
  );
}
