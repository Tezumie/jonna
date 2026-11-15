// Sync (D435): the account's settings, the user's own files, a project's chats and snapshots of
// its unfinished work on every computer of the account, sealed on this one before they leave.
// This is the part people see: the Sync tab (view.ts), the commands (commands.ts) and
// ide://sync, over the controller (controller.ts) that runs the loop. Only with a screen: a
// screenless session doesn't sync.
import type { BuiltinExtension } from "../../core/extensions/index";
import { accountsIpc } from "../../core/ipc/accounts";
import { perf } from "../../core/perf";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerSyncCommands } from "./commands";
import { SyncController } from "./controller";
import manifest from "./extension.json";
import { SyncSession } from "./session";
import { syncViewDescriptor } from "./view";

/** Coming back to the window starts a pass at most this often. */
const FOCUS_PASS_MS = 2 * 60_000;

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
    const refresh = async () => {
      if (disposed) return;
      passedAt = Date.now();
      const base = controller.base();
      const profile = base ? await accountsIpc.profile(base).catch(() => null) : null;
      if (disposed) return;
      if (JSON.stringify(profile) !== JSON.stringify(session.profile.peek()))
        session.profile.value = profile;
      await controller.pass(true);
    };

    sub.add(dock.views.register(syncViewDescriptor(services, controller, session)));
    registerSyncCommands(sub, services, { controller, session });

    // Once the folder is back (the project's identity is the folder's).
    void perf
      .whenMarked("workspaceRestored")
      .then(refresh)
      .catch(() => {});

    const onFocus = () => {
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
          "Sync: whether it is open to the account (`available`), where it stands here (`state`: signedOut, unavailable, off, pending, on), this account's computers, storage, the last pass (`activity`), and the open project with its snapshots (newest first). Never the recovery key or a verification code.",
        get: () => {
          const status = controller.status.peek();
          const activity = controller.activity.peek();
          const project = controller.project.peek();
          return {
            available: !!controller.base() && session.available(),
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
            })),
            recoveryKeySet: !!status && status.recoveryCreatedAt !== null,
            usageBytes: status?.usageBytes ?? 0,
            storageLimit: status?.storageLimit || session.profile.peek()?.storageLimit || 0,
            activity: { state: activity.state, message: activity.message, at: activity.at },
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
