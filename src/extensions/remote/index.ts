// Remote development over SSH (D252): a window connected to another machine works on its files,
// runs its programs there (git, terminals, tasks, the agent's commands, language servers) and
// forwards its ports for the browser preview. The connection, the server it starts there and
// the routing are Rust's (src-tauri/src/remote, docs/remote.md); this is the window's side:
// connecting at startup (a window launched with `--remote`), Connect to host…, the remote folder
// picker, the "SSH: host" status item and its menu, forwarded ports, `ide://remote`.
import type { BuiltinExtension } from "../../core/extensions/index";
import { isTauri } from "../../core/ipc/invoke";
import { type RemoteEvent, type RemoteInfo, remoteIpc } from "../../core/ipc/remote";
import { appIpc } from "../../core/ipc/system";
import { basename, dirname } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import {
  authorityString,
  parseAuthority,
  type RemoteAuthority,
  remoteLabel,
  validHost,
} from "../../core/workspace/remoteLocation";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { devContainer, registerDevContainers } from "./devContainers";
import manifest from "./extension.json";

/** The window's remote: null for a local window. */
export const remote = signal<{
  authority: RemoteAuthority;
  /** "connecting" until the server answers; "disconnected" after the connection dropped. */
  status: "connecting" | "connected" | "disconnected";
  info: RemoteInfo | null;
  message: string;
} | null>(null);

/** Ports forwarded from the remote: remote port → local port. */
const forwarded = signal<ReadonlyMap<number, number>>(new Map());

/** ssh's yes/no question about a host key it doesn't know yet. */
export function isHostKeyQuestion(prompt: string): boolean {
  return /\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i.test(prompt.trim());
}

/**
 * ssh's sign-in questions while connecting (D252): one at a time in the quick input, a password
 * or passphrase masked, a new host key as a yes/no pick showing its fingerprint. Escape cancels
 * (ssh then fails, saying so). The answers go straight back to ssh; nothing keeps them.
 */
function askpassHandler(services: WorkbenchServices): (e: RemoteEvent) => void {
  let queue = Promise.resolve();
  let current: number | null = null;
  const cancelled = new Set<number>();
  const ask = async (prompt: string, secret: boolean): Promise<string | null> => {
    const text = prompt.trim();
    if (isHostKeyQuestion(text)) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const detail = lines.slice(0, -1).join(" ");
      const picked = await services.quickInput.pick(
        [
          {
            id: "yes",
            label: "Trust this host and connect",
            description: detail,
            detail: text,
            icon: "check",
          },
          { id: "no", label: "Don't connect", icon: "x" },
        ],
        {
          placeholder:
            lines.find((l) => /fingerprint is/i.test(l)) ?? lines[0] ?? "Trust this host?",
        },
      );
      return picked ? picked.id : null;
    }
    const value = await services.quickInput.prompt({
      prompt: text.replace(/:\s*$/, ""),
      placeholder: secret ? "Password or passphrase" : "",
      password: secret,
    });
    return value ?? null;
  };
  return (e) => {
    if (e.kind === "askpassCancel") {
      if (current === e.id) services.quickInput.cancel();
      else cancelled.add(e.id);
      return;
    }
    if (e.kind !== "askpass") return;
    const { id, prompt, secret } = e;
    queue = queue
      .then(async () => {
        if (cancelled.delete(id)) return;
        current = id;
        const answer = await ask(prompt, secret);
        current = null;
        await remoteIpc.askpassAnswer(id, answer);
      })
      .catch(() => {
        current = null;
        return remoteIpc.askpassAnswer(id, null).catch(() => {});
      });
  };
}

/**
 * Connects this window to `authority` (D252): the window was launched for it (`--remote`), or
 * an empty window asked to. Rust starts ssh, installs the server there if needed and starts it;
 * progress shows in the status item. Throws with the reason (sign-in refused, unknown host…).
 */
export async function connectRemote(
  services: WorkbenchServices,
  authority: RemoteAuthority,
): Promise<RemoteInfo> {
  remote.value = { authority, status: "connecting", info: null, message: "Connecting…" };
  services.workspace.remote.value = authority;
  // A container's transport is `docker exec` with the setting's program (D266).
  if (authority.kind === "container")
    await remoteIpc
      .setDocker(services.settings.peek<string>("remote.containers.dockerPath") || null)
      .catch(() => {});
  const onAskpass = askpassHandler(services);
  try {
    const info = await remoteIpc.connect(authorityString(authority), (e: RemoteEvent) => {
      if (e.kind === "askpass" || e.kind === "askpassCancel") return onAskpass(e);
      const now = remote.peek();
      if (!now) return;
      if (e.kind === "progress") remote.value = { ...now, message: e.message };
      else if (e.kind === "disconnected") {
        remote.value = { ...now, status: "disconnected", message: e.reason };
        services.notifications.show(
          "error",
          `The connection to ${remoteLabel(authority)} was lost: ${e.reason}`,
          {
            title: "Remote",
            actions: [
              {
                label: "Reconnect",
                run: () => void services.dispatcher.execute("remote.reconnect").catch(() => {}),
              },
            ],
          },
        );
      }
    });
    remote.value = { authority, status: "connected", info, message: "" };
    return info;
  } catch (err) {
    remote.value = {
      authority,
      status: "disconnected",
      info: null,
      message: err instanceof Error ? err.message : String(err),
    };
    throw err;
  }
}

export const remoteExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, quickInput, statusBar, state, workspace, notifications } = services;

    /** Closes the remote's folder and the connection; false when the user kept the folder. */
    const disconnect = async (): Promise<boolean> => {
      if (!(await workspace.close())) return false;
      await remoteIpc.disconnect();
      remote.value = null;
      workspace.remote.value = null;
      forwarded.value = new Map();
      devContainer.value = null;
      return true;
    };

    const current = (): RemoteAuthority => {
      const r = remote.peek();
      if (!r) throw new Error("This window isn't connected to a remote.");
      return r.authority;
    };

    /** A folder on the remote, browsed in the quick input (the system dialog can't see it). */
    const pickRemoteFolder = async (start: string): Promise<string | null> => {
      let dir = start;
      for (;;) {
        const entries = await remoteIpc.browse(dir);
        const folders = entries.filter((e) => e.kind === "dir");
        const picked = await quickInput.pick(
          [
            {
              id: "\u0000open",
              label: `Open ${dir}`,
              description: "this folder",
              icon: "folder-open" as const,
            },
            ...(dir !== "/"
              ? [
                  {
                    id: "\u0000up",
                    label: "..",
                    description: dirname(dir),
                    icon: "arrow-up" as const,
                  },
                ]
              : []),
            ...folders.map((f) => ({ id: f.path, label: f.name, icon: "folder" as const })),
          ],
          { placeholder: `${remoteLabel(current())} · ${dir}` },
        );
        if (!picked) return null;
        if (picked.id === "\u0000open") return dir;
        dir = picked.id === "\u0000up" ? dirname(dir) : picked.id;
      }
    };

    sub.add(
      dispatcher.register({
        id: "remote.connect",
        title: "Connect to host…",
        category: "Remote",
        description:
          "Opens a window on another machine over SSH (D252): its files, terminals, git, tasks, language servers and the agent's commands run there. `host`: an ~/.ssh/config Host or user@host[:port]; without it, lists the configured hosts (or type one). `folder`: an absolute folder there to open. Opens a new window unless `here` (only in a window with no folder open).",
        input: s.object({
          host: s.string().optional(),
          folder: s.string().describe("Absolute path on the remote").optional(),
          here: s.boolean().optional(),
          kind: s
            .enum(["ssh", "wsl"])
            .describe("Default ssh; wsl: a WSL distribution (tests)")
            .optional(),
        }),
        effects: [],
        agent: "hidden",
        run: async ({ host, folder, here, kind }) => {
          let target = host;
          if (!target) {
            const hosts = await remoteIpc.hosts().catch(() => []);
            const picked = await quickInput.pick(
              [
                ...hosts.map((h) => ({
                  id: h.host,
                  label: h.host,
                  description: [h.user && `${h.user}@`, h.hostname, h.port && `:${h.port}`]
                    .filter(Boolean)
                    .join(""),
                  icon: "server" as const,
                })),
                { id: "\u0000new", label: "Enter user@host…", icon: "plus" as const },
              ],
              { placeholder: "Select a host (from ~/.ssh/config) or enter one" },
            );
            if (!picked) return { connected: null };
            target =
              picked.id === "\u0000new"
                ? ((await quickInput.prompt({
                    prompt: "user@host (or user@host:port)",
                    placeholder: "me@server",
                  })) ?? undefined)
                : picked.id;
          }
          if (!target) return { connected: null };
          const authority: RemoteAuthority = { kind: kind ?? "ssh", host: target.trim() };
          if (!validHost(authority.kind, authority.host))
            throw new Error(`"${target}" isn't a host name (letters, digits, . _ - @ : only).`);
          if (here) {
            if (workspace.root.peek() || remote.peek()?.status === "connected")
              throw new Error("Connect here only from a window with no folder open.");
            const info = await connectRemote(services, authority);
            if (folder) await workspace.open(folder);
            return { connected: authorityString(authority), home: info.home };
          }
          await appIpc.newRemoteWindow(folder, authorityString(authority));
          return { connected: authorityString(authority), newWindow: true };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "remote.openFolder",
        title: "Open folder on the remote…",
        category: "Remote",
        description:
          "In a remote window, opens a folder on the remote: `path` (absolute there), or browse from the home folder.",
        input: s.object({ path: s.string().optional() }),
        effects: ["read"],
        when: "remoteConnected",
        agent: "hidden",
        run: async ({ path }) => {
          const target = path ?? (await pickRemoteFolder(remote.peek()?.info?.home ?? "/"));
          if (!target) return { opened: null };
          return { opened: await workspace.open(target) };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "remote.reconnect",
        title: "Reconnect to the remote",
        category: "Remote",
        description:
          "Connects this remote window again after the connection dropped, and reopens its folder.",
        input: s.empty(),
        effects: [],
        when: "remoteWindow",
        agent: "hidden",
        run: async () => {
          const authority = current();
          await connectRemote(services, authority);
          const location = workspace.root.peek();
          if (location) await workspace.open(workspace.file.peek() ?? location);
          return { connected: authorityString(authority) };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "remote.disconnect",
        title: "Close remote connection",
        category: "Remote",
        description:
          "Closes the remote's folder and the connection; the window stays, local and empty.",
        input: s.empty(),
        effects: [],
        when: "remoteWindow",
        agent: "hidden",
        run: async () => ({ closed: await disconnect() }),
      }),
    );

    // Dev containers (D266): a container is a remote reached with `docker exec`.
    registerDevContainers(sub, services, {
      connect: (authority) => connectRemote(services, authority),
      current: () => remote.peek()?.authority ?? null,
      disconnect,
    });

    sub.add(
      dispatcher.register({
        id: "remote.forwardPort",
        title: "Forward a port…",
        category: "Remote",
        description:
          "Makes a port on the remote reachable on this computer (localhost:<local>, the same number when it's free): for a dev server running there. Without `port`, lists the ports listening on the remote.",
        input: s.object({ port: s.integer({ min: 1, max: 65535 }).optional() }),
        effects: [],
        when: "remoteConnected",
        agent: "hidden",
        run: async ({ port }) => {
          let wanted = port;
          if (!wanted) {
            const listening = await remoteIpc.listening().catch(() => []);
            const picked = await quickInput.pick(
              [
                ...listening.map((l) => ({
                  id: String(l.port),
                  label: String(l.port),
                  description: [l.process, l.host].filter(Boolean).join(" · "),
                })),
                { id: "\u0000other", label: "Another port…" },
              ],
              { placeholder: "Which port on the remote?" },
            );
            if (!picked) return { forwarded: null };
            const text =
              picked.id === "\u0000other"
                ? await quickInput.prompt({ prompt: "Port on the remote" })
                : picked.id;
            wanted = Number(text);
          }
          if (!wanted || !Number.isInteger(wanted) || wanted < 1 || wanted > 65535)
            throw new Error("A port is a number from 1 to 65535.");
          const local = await remoteIpc.forwardPort(wanted);
          forwarded.value = new Map([...forwarded.peek(), [wanted, local]]);
          notifications.show(
            "info",
            `Port ${wanted} on ${remoteLabel(current())} is on localhost:${local}.`,
            {
              title: "Remote",
            },
          );
          return { remote: wanted, local };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "remote.stopForwarding",
        title: "Stop forwarding a port",
        category: "Remote",
        description: "Stops forwarding a remote port (`port`: the remote's).",
        input: s.object({ port: s.integer({ min: 1, max: 65535 }) }),
        effects: [],
        when: "remoteConnected",
        agent: "hidden",
        palette: false,
        run: async ({ port }) => {
          await remoteIpc.unforward(port);
          const next = new Map(forwarded.peek());
          next.delete(port);
          forwarded.value = next;
          return { stopped: port };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "remote.showLog",
        title: "Show the remote connection's log",
        category: "Remote",
        description:
          "Opens what ssh and the remote server reported for this window's connection (sign-in, install, errors).",
        input: s.empty(),
        effects: [],
        when: "remoteWindow",
        agent: "hidden",
        run: async () => {
          const text = await remoteIpc.log();
          await dispatcher
            .execute("workspace.newUntitledFile", { content: text, language: "log" })
            .catch(() => {
              notifications.show("info", text.slice(-2000) || "Nothing logged yet.", {
                title: "Remote",
              });
            });
          return { length: text.length };
        },
      }),
    );

    // The status item: "SSH: box" (VS Code's remote indicator), with the connection's menu.
    sub.add(
      statusBar.add({
        id: "remote.indicator",
        name: "Remote",
        alignment: "left",
        priority: 101,
        text: () => {
          const r = remote.value;
          if (!r) return "";
          return r.status === "connecting"
            ? `${remoteLabel(r.authority)} · ${r.message}`
            : r.status === "disconnected"
              ? `${remoteLabel(r.authority)} · disconnected`
              : remoteLabel(r.authority);
        },
        tooltip: () => {
          const r = remote.value;
          if (!r) return "";
          const info = r.info;
          return [
            remoteLabel(r.authority),
            info && `${info.user}@${info.os} ${info.arch}`,
            r.message,
            [...forwarded.value].map(([p, l]) => `Port ${p} → localhost:${l}`).join("\n"),
          ]
            .filter(Boolean)
            .join("\n");
        },
        command: "remote.menu",
      }),
    );
    sub.add(
      dispatcher.register({
        id: "remote.menu",
        title: "Remote connection menu",
        category: "Remote",
        description:
          "The remote indicator's menu (open a folder there, forward a port, the log, reconnect, close).",
        input: s.object({ x: s.number().optional(), y: s.number().optional() }),
        effects: [],
        agent: "hidden",
        palette: false,
        run: ({ x, y }) => {
          const r = remote.peek();
          const run =
            (command: string, input: unknown = {}) =>
            () =>
              void dispatcher.execute(command, input).catch(() => {});
          const inContainer = r?.authority.kind === "container";
          const items: MenuItem[] = !r
            ? [
                { label: "Connect to host…", icon: "server", run: run("remote.connect") },
                ...(workspace.root.peek()
                  ? [
                      {
                        label: "Reopen in container",
                        icon: "box" as const,
                        run: run("remote.reopenInContainer"),
                      },
                    ]
                  : []),
                {
                  label: "Attach to running container…",
                  icon: "box" as const,
                  run: run("remote.attachToContainer"),
                },
              ]
            : [
                ...(r.status === "connected"
                  ? [
                      {
                        label: "Open folder…",
                        icon: "folder-open" as const,
                        run: run("remote.openFolder"),
                      },
                      {
                        label: "Forward a port…",
                        icon: "plug" as const,
                        run: run("remote.forwardPort"),
                      },
                      ...[...forwarded.peek()].map(([p, l]) => ({
                        label: `Stop forwarding ${p} (localhost:${l})`,
                        icon: "x" as const,
                        run: run("remote.stopForwarding", { port: p }),
                      })),
                    ]
                  : [
                      {
                        label: "Reconnect",
                        icon: "refresh-cw" as const,
                        run: run("remote.reconnect"),
                      },
                    ]),
                ...(inContainer
                  ? [
                      {
                        label: "Rebuild container",
                        icon: "refresh-cw" as const,
                        separatorBefore: true,
                        run: run("remote.rebuildContainer"),
                      },
                      {
                        label: "Reopen folder locally",
                        icon: "folder-open" as const,
                        run: run("remote.reopenLocally"),
                      },
                    ]
                  : []),
                {
                  label: "Show log",
                  icon: "scroll-text" as const,
                  separatorBefore: true,
                  run: run("remote.showLog"),
                },
                {
                  label: "Close remote connection",
                  icon: "x" as const,
                  run: run("remote.disconnect"),
                },
              ];
          sub.add(showContextMenu(x ?? 8, y ?? window.innerHeight - 32, items));
        },
      }),
    );

    // Context keys for menus and `when`s (VS Code's remoteName too).
    sub.add(
      effect(() => {
        const r = remote.value;
        services.context.set("remoteWindow", !!r);
        services.context.set("remoteConnected", r?.status === "connected");
        services.context.set("remoteName", r ? r.authority.kind : "");
        return undefined;
      }),
    );

    sub.add(
      state.register("ide://remote", {
        description:
          "The window's remote (D252): null for a local window; else { authority (ssh:host / wsl:distro / container:[user@]id), label, status (connecting/connected/disconnected), message, info { os, arch, home, user, shell }, forwarded [{ remote, local }], container (a dev container, D266: { id, localFolder, configFile }) }.",
        get: () => {
          const r = remote.peek();
          if (!r) return null;
          return {
            authority: authorityString(r.authority),
            label: remoteLabel(r.authority),
            status: r.status,
            message: r.message,
            info: r.info,
            forwarded: [...forwarded.peek()].map(([p, l]) => ({ remote: p, local: l })),
            folder: workspace.root.peek() ? basename(workspace.root.peek() as string) : null,
            container: devContainer.peek(),
          };
        },
      }),
    );
  },
};

/**
 * At startup (main.ts): a window launched for a remote (`--remote ssh:box`, app_info's
 * `remote`) connects before its folder opens. A failed connection leaves the window empty,
 * saying why, with Reconnect in the indicator's menu.
 */
export async function connectAtStartup(
  services: WorkbenchServices,
  authority: string | null | undefined,
): Promise<boolean> {
  if (!isTauri() || !authority) return false;
  const parsed = parseAuthority(authority);
  if (!parsed) return false;
  try {
    await connectRemote(services, parsed);
    return true;
  } catch (err) {
    services.notifications.show(
      "error",
      `Couldn't connect to ${remoteLabel(parsed)}: ${err instanceof Error ? err.message : String(err)}`,
      { title: "Remote" },
    );
    return false;
  }
}
