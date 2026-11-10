# Remote development

The window's side of remote development (D252, D266): a window connected to another machine
over SSH, or to a dev container, works on its files and runs its programs there. The connection,
the server and the routing are Rust's (`src-tauri/src/remote/`, `docs/remote.md`).

- `index.ts`: connecting (at startup for a window launched with `--remote`, Connect to host…),
  ssh's sign-in questions, the remote folder picker, the status bar's remote indicator and its
  menu, forwarded ports, `ide://remote`. Exports `remote` (the window's remote), `connectRemote`,
  `connectAtStartup`.
- `devContainers.ts` (D266): Reopen in container, Rebuild container, Reopen folder locally, Attach
  to running container, the notice on opening a folder with a configuration, the containers' log,
  the bring-up's status item. The plan is `src/core/workspace/devContainer.ts`; docker (or the
  devcontainers CLI) runs through `remoteIpc.docker`. Exports `devContainer` (this window's
  container and the local folder it came from).

**Commands:** `remote.connect`, `remote.openFolder`, `remote.reconnect`, `remote.disconnect`,
`remote.forwardPort`, `remote.stopForwarding`, `remote.showLog`, `remote.menu`;
`remote.reopenInContainer`, `remote.rebuildContainer`, `remote.reopenLocally`,
`remote.attachToContainer`, `remote.showContainerLog`.

**Settings:** `remote.containers.dockerPath`, `remote.containers.showReopenNotice`.

**State:** `ide://remote` (authority, label, status, info, forwarded ports, `container`).

**Context keys:** `remoteWindow`, `remoteConnected`, `remoteName` (`ssh`, `wsl`, `container`),
`devContainerConfig` (the open folder has a configuration).
