// Updates (D192): "Check for updates…" in the Help menu, and with update.mode "default" a quiet
// check a minute after start and once a day; a newer version is offered in a notification, and
// nothing is downloaded until the user says so. Builds without an update endpoint (development,
// forks) say so and never connect.

import { isTauri } from "../../core/ipc/invoke";
import { type UpdateChannel, type UpdateInfo, updateIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

const FIRST_CHECK_MS = 60_000;
const EVERY_MS = 24 * 60 * 60_000;

export function registerUpdates(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, notifications, settings, state } = services;
  const last = signal<(UpdateInfo & { checkedAt: number }) | null>(null);
  const installing = signal<string | null>(null);
  let offered: string | null = null;
  // update.channel (D204): "beta" checks the beta endpoint when the build has one.
  const channel = (): UpdateChannel =>
    settings.peek<string>("update.channel") === "beta" ? "beta" : "stable";

  const offer = (info: UpdateInfo) => {
    if (!info.available || offered === info.available) return;
    offered = info.available;
    notifications.show(
      "info",
      `Version ${info.available} is available (you have ${info.current}).`,
      {
        title: "Update",
        actions: [
          {
            label: "Install and restart",
            run: () => void dispatcher.execute("update.install", {}).catch(() => {}),
          },
          ...(info.notes
            ? [
                {
                  label: "What's new",
                  run: () =>
                    void dispatcher
                      .execute("editor.openReadOnly", {
                        title: `What's new in ${info.available}.md`,
                        content: info.notes ?? "",
                      })
                      .catch(() => {}),
                },
              ]
            : []),
        ],
      },
    );
  };

  const check = async (): Promise<UpdateInfo> => {
    const info = await updateIpc.check(channel());
    last.value = { ...info, checkedAt: Date.now() };
    return info;
  };

  sub.add(
    dispatcher.register({
      id: "update.check",
      title: "Check for updates…",
      category: "Help",
      description:
        "Asks the update server whether a newer version is out and offers it (nothing is downloaded until the user installs it). Builds made without an update endpoint have no updates.",
      input: s.empty(),
      effects: ["network"],
      run: async (_input, ctx) => {
        const info = await check();
        const user = ctx.caller.kind === "user";
        if (!info.configured) {
          if (user)
            notifications.show(
              "info",
              "This build doesn't update itself: it was made without an update server (a development build, or one you built yourself).",
            );
        } else if (user && channel() === "beta" && !info.betaAvailable) {
          notifications.show(
            "info",
            `This build has no beta channel, so it checked stable releases: ${info.available ? `version ${info.available} is available.` : `you have the latest version (${info.current}).`}`,
          );
          if (info.available) {
            offered = null;
            offer(info);
          }
        } else if (info.available) {
          offered = null;
          offer(info);
        } else if (user)
          notifications.show("info", `You have the latest version (${info.current}).`);
        return info;
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "update.install",
      title: "Install update and restart",
      category: "Help",
      description:
        "Downloads the newer version, checks its signature, installs it and restarts the IDE (unsaved files are kept by hot exit, and asked about otherwise).",
      input: s.empty(),
      effects: ["network", "write"],
      agent: "hidden",
      run: async () => {
        if (installing.peek()) return { installing: true };
        // Unsaved changes: the same question as closing the window.
        if (!(await services.workspace.confirmClose("window"))) return { installed: false };
        installing.value = "Starting…";
        await services.persistence.flush();
        const progress = notifications.show("info", "Downloading the update…", { title: "Update" });
        let total: number | null = null;
        try {
          await updateIpc.install(channel(), (p) => {
            if (p.kind === "started") total = p.total;
            installing.value =
              p.kind === "installing"
                ? "Installing…"
                : p.kind === "progress" && total
                  ? `${Math.round((p.downloaded / total) * 100)}%`
                  : "Downloading…";
          });
          return { installed: true };
        } catch (err) {
          notifications.show(
            "error",
            `The update didn't install: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { installed: false };
        } finally {
          installing.value = null;
          progress.dispose();
        }
      },
    }),
  );

  sub.add(
    state.register("ide://update", {
      description:
        "Updates: the mode and channel (stable or beta), the last check (when, the channel it used, a newer version if any) and an install in progress.",
      get: () => ({
        mode: settings.peek<string>("update.mode") ?? "default",
        channel: channel(),
        last: last.peek(),
        installing: installing.peek(),
      }),
    }),
  );

  // The quiet checks: a minute after start, then daily (update.mode "default").
  if (!isTauri()) return;
  const auto = () =>
    settings.peek<string>("update.mode") === "default" || !settings.peek("update.mode");
  const quiet = () => {
    if (!auto()) return;
    void check()
      .then((info) => info.configured && offer(info))
      .catch(() => {});
  };
  const first = setTimeout(quiet, FIRST_CHECK_MS);
  const daily = setInterval(quiet, EVERY_MS);
  sub.add({
    dispose: () => {
      clearTimeout(first);
      clearInterval(daily);
    },
  });
}
