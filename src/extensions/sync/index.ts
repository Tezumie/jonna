// Sync (D435): the account's settings, the user's own files, a project's chats and snapshots of
// its unfinished work on every computer of the account, sealed on this one before they leave.
// This is the part people see: the Sync tab (view.ts), the commands (commands.ts) and
// ide://sync, over the controller (controller.ts) that runs the loop. Only with a screen: a
// screenless session doesn't sync.
import type { BuiltinExtension } from "../../core/extensions/index";
import { accountsIpc } from "../../core/ipc/accounts";
import { syncIpc } from "../../core/ipc/sync";
import { perf } from "../../core/perf";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerSyncCommands } from "./commands";
import { SyncController } from "./controller";
import manifest from "./extension.json";
import { lapsedUntil, planSituation, statusBarWords } from "./model";
import { SyncSession } from "./session";
import { syncViewDescriptor } from "./view";

/** Coming back to the window starts a pass at most this often. */
const FOCUS_PASS_MS = 2 * 60_000;
/**
 * Coming back to the window while the account could buy sync, or its subscription ended, reads
 * the account's plan again at most this often: a purchase in the browser shows without a restart.
 */
const FOCUS_PLAN_MS = 30_000;

export const syncExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const session = new SyncSession();
    if (!services.hasScreen) {
      // No loop and no tab without a screen; the commands are there and say so.
      registerSyncCommands(sub, services, { controller: null, session });
      return;
    }
    const { dock, events, state, workspace } = services;
    const controller = sub.add(new SyncController(services));
    let disposed = false;
    sub.add({
      dispose: () => {
        disposed = true;
        session.closeStep();
      },
    });

    /** Reads who is signed in, then where sync stands (and syncs, when it is on). */
    let passedAt = 0;
    /** Whether the server was asked for the profile since this window started. */
    let asked = false;
    const refresh = async () => {
      if (disposed) return;
      passedAt = Date.now();
      const base = controller.base();
      // The first time, the server is asked: the profile saved here may be from before the
      // account's plan changed, or from a version that didn't know of plans (an offer would
      // not show, a subscription that ended would look like one that never was). After that
      // the saved one is read; the accounts extension keeps it fresh.
      const saved = () => accountsIpc.profile(base).catch(() => null);
      const first = !asked;
      asked = true;
      const profile = !base
        ? null
        : first
          ? await accountsIpc.check(base).catch(saved)
          : await saved();
      if (disposed) return;
      if (JSON.stringify(profile) !== JSON.stringify(session.profile.peek()))
        session.profile.value = profile;
      await controller.pass(true);
    };

    sub.add(dock.views.register(syncViewDescriptor(services, controller, session)));
    registerSyncCommands(sub, services, { controller, session });

    // This computer's own name, for the "Computer name" field.
    void syncIpc
      .deviceName()
      .then((name) => {
        if (!disposed) session.suggestName(name);
      })
      .catch(() => {});

    // The status bar: there only while sync is on here (or waiting to be approved). Quiet: an
    // icon and a word, colored only for an error.
    const words = () =>
      statusBarWords(
        !!controller.base() && session.profile.value?.sync === true,
        controller.status.value?.state ?? null,
        controller.activity.value,
        planSituation(session.profile.value, controller.status.value) === "lapsed",
      );
    sub.add(
      services.statusBar.add({
        id: "sync.status",
        name: "Sync",
        alignment: "right",
        priority: 28,
        text: () => words()?.text ?? "",
        tooltip: () => words()?.tooltip ?? "",
        tone: () => (words()?.error ? "error-text" : undefined),
        command: "sync.show",
        input: { page: "overview" },
      }),
    );

    // A last snapshot as the window or the folder closes, when something changed. Never in the
    // way of closing: a few seconds at most, and always yes.
    sub.add(
      workspace.onWillClose(async () => {
        await controller.snapshotOnClose().catch(() => {});
        return true;
      }),
    );

    // Once the folder is back (the project's identity is the folder's).
    void perf
      .whenMarked("workspaceRestored")
      .then(refresh)
      .catch(() => {});

    let planCheckedAt = 0;
    const onFocus = () => {
      const plan = planSituation(session.profile.peek(), controller.status.peek());
      // Back from the browser, perhaps from paying: the same command as "Check again", so the
      // account's menu hears of it too. Never while a pass runs.
      if (
        (plan === "offered" || plan === "lapsed") &&
        !controller.busy() &&
        Date.now() - planCheckedAt >= FOCUS_PLAN_MS
      ) {
        planCheckedAt = Date.now();
        passedAt = planCheckedAt;
        void services.dispatcher.execute("sync.checkPlan", {}).catch(() => {});
        return;
      }
      if (Date.now() - passedAt >= FOCUS_PASS_MS) void refresh().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    sub.add({ dispose: () => window.removeEventListener("focus", onFocus) });

    // Signed in or out: sync opens or closes with the account.
    sub.add(
      events.on("command.executed", (event) => {
        if (event.status !== "ok") return;
        if (event.id === "accounts.signIn" || event.id === "accounts.signOut")
          void refresh().catch(() => {});
      }),
    );

    // Another folder: its identity and snapshots, then a pass.
    let root = workspace.root.peek();
    sub.add(
      effect(() => {
        const now = workspace.root.value;
        if (now === root) return undefined;
        root = now;
        void controller
          .refreshProject()
          .then(() => controller.pass())
          .catch(() => {});
        return undefined;
      }),
    );

    // Sync just came on here (set up, joined, approved from another computer): sync at once.
    let standing = controller.status.peek()?.state;
    sub.add(
      effect(() => {
        const now = controller.status.value?.state;
        if (now === standing) return undefined;
        standing = now;
        if (now === "on") void controller.pass().catch(() => {});
        return undefined;
      }),
    );

    sub.add(
      state.register("ide://sync", {
        description:
          "Sync: whether it is open to the account (`available`), whether the account could subscribe to it (`offered`: sync is on sale to it and it doesn't have it; sync.managePlan opens the plans), where it stands here (`state`: signedOut, unavailable, off, pending, on), `lapsedUntil` (null, or, when the account's subscription ended, when what is synced is deleted, in ms: until then it can be read and snapshots restored, and nothing is written), this account's computers, storage, the last pass (`activity`; its state is off, idle, syncing, offline, error, other, blocked, or lapsed while the subscription is ended), the page the Sync tab shows while sync is on (`page`: overview, projects, content, computers, security, storage, activity), what the account holds (`overview`: the settings count, the user's files by name, chats without a folder, and each project by name with its chats, snapshots, the latest snapshot's size, last change and computer, and whether it syncs from this computer), the open project with its snapshots (newest first), and what sync did lately (`recent`). A waiting computer's `codeChecked` says whether its code is being compared. Never the recovery key, a verification code or any content.",
        get: () => {
          const status = controller.status.peek();
          const activity = controller.activity.peek();
          const project = controller.project.peek();
          const profile = session.profile.peek();
          const plan = controller.base() ? planSituation(profile, status) : "none";
          return {
            available: !!controller.base() && session.available(),
            offered: plan === "offered",
            lapsedUntil: plan === "lapsed" ? lapsedUntil(profile, status) : null,
            state: status?.state ?? (session.profile.peek() ? "off" : "signedOut"),
            device:
              status?.deviceId && status.state !== "off"
                ? { id: status.deviceId, name: status.deviceName ?? "" }
                : null,
            devices: (status?.devices ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              platform: d.platform,
              status: d.status,
              current: d.current,
              // Whether a code is on show for it; never the code.
              codeChecked: d.code !== null,
            })),
            recoveryKeySet: !!status && status.recoveryCreatedAt !== null,
            usageBytes: status?.usageBytes ?? 0,
            storageLimit: status?.storageLimit || session.profile.peek()?.storageLimit || 0,
            activity: { state: activity.state, message: activity.message, at: activity.at },
            page: session.page.peek(),
            overview: controller.overview.peek(),
            recent: controller.log.peek(),
            project: project
              ? { root: project.root, id: project.id, on: project.on, known: project.known }
              : null,
            snapshots: controller.snapshots.peek().map((row) => ({
              id: row.id,
              time: row.summary.time,
              deviceName: row.summary.deviceName,
              branch: row.summary.branch,
              files: row.summary.files,
              bytes: row.summary.bytes,
              pinned: row.summary.pinned ?? null,
            })),
          };
        },
      }),
    );
  },
};
