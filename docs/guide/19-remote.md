# Remote development

The IDE can work on a folder that isn't on your computer: on another machine over SSH, inside a
dev container, or (on Windows) inside a WSL distribution. The window stays on your computer;
the files, terminals, git, tasks, language servers and the agent's commands run where the folder
is. This page covers connecting over SSH, forwarding ports, dev containers and WSL folders, and
what doesn't work remotely yet.

## Work on another machine over SSH

You need `ssh` on your computer and a Linux machine (x86_64 or ARM) you can reach with it.

1. Run **Remote: Connect to host…** from the command palette.
2. Pick a host from your `~/.ssh/config`, or choose **Enter user@host…** and type one
   (`user@host:2222` for another port).
3. Answer what ssh asks, in the window: a password, a key's passphrase, or whether to trust a new
   host (with its fingerprint).
4. The connection opens in a new window. Choose **Open folder…** there: it browses the remote's
   folders.

The window then works on that machine's files: the explorer, search, quick access, git,
terminals, tasks, language servers you have there, debug adapters and the agent's commands all
run on it.

- Your keys and `ssh` settings are used as they are. Nothing is asked again for the programs the
  window runs: they all go through the one connection.
- Programs on the remote see the PATH your login profile sets there (nvm, cargo, pyenv).
- Recent remote folders show as "app [SSH: host]" on the Welcome page and in **File → Open
  recent**, and open in a window of their own.

[Connect to host](command:remote.connect)

### The server it copies

The first time you connect, the IDE copies a small server to the remote, into a folder of its own
in your home folder (about 3 MB, a static Linux build for x86_64 or ARM, so no library versions
need to match). Later connections reuse it, and a new version of the IDE replaces it. It stops
when the window disconnects, and everything it started stops with it.

### The remote menu

In a remote window, the status bar shows **SSH: host** at its left. Click it for the
connection's menu:

| Menu item | What it does |
|---|---|
| **Open folder…** | Opens another folder on the remote |
| **Forward a port…** | Makes a port on the remote reachable on your computer |
| **Stop forwarding** *port* | Stops one forwarded port |
| **Reconnect** | Connects again after the connection was lost |
| **Show log** | What the connection and the server reported |
| **Close remote connection** | Disconnects the window |

When the connection is lost, a notice says why and offers **Reconnect**.

### Forward a port

A dev server running on the remote can be opened on your computer:

- In a remote window, the browser pane's `localhost:<port>` is forwarded to the remote by
  itself, on the same port number locally when it's free. Open `http://localhost:3000` in the
  browser pane and you see the remote's server.
- **Forward a port…** lists the ports listening on the remote (with the program behind each, where
  it can tell) or takes another port number.

See [Browser preview](11-browser.md).

### What isn't supported yet

In a remote window, these aren't available yet (the IDE says so when you try):

- Several folders in one window.
- Local history of files.
- Dragging files in from your system, or out of the explorer.
- Interactive rebase.
- The browser's static preview of a remote folder.
- Detecting a project's own formatter (the editor's or a language server's formatter applies).

Git's sign-in prompts don't cross the connection: the remote's own credential setup is used.

## Develop in a dev container

A folder with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`, or
`.devcontainer/<name>/devcontainer.json`), the format VS Code and GitHub Codespaces use, can be
opened inside its container.

You need Docker (Docker Desktop on Windows and macOS). `remote.containers.dockerPath` names
another program, such as podman.

### Reopen a folder in its container

1. Open the folder.
2. Choose **Reopen in container** in the notice that offers it, or run **Dev containers: Reopen
   in container** from the command palette.

The IDE then:

1. Runs `initializeCommand` on your computer.
2. Finds the folder's container, or starts it: pulling its `image`, or building its
   `Dockerfile`.
3. Mounts the folder at `workspaceFolder` (`/workspaces/<folder>` by default).
4. Runs `onCreateCommand`, `updateContentCommand`, `postCreateCommand` and `postStartCommand`
   in the container, then `postAttachCommand` once the window is in.
5. Forwards the configuration's `forwardPorts`.

A status bar item shows the step it's on. The window then works inside the container as an SSH
window works on its machine: files, terminals, git, tasks, language servers and the agent's
commands run in the container.

Containers are found by the same labels VS Code uses, so either one finds a container the other
started.

> **Note:** Docker Compose configurations and `features` need the Dev Containers CLI
> (`npm install -g @devcontainers/cli`). When it's installed, the IDE uses it for every container.

### Rebuild, reopen locally, attach

In a container window, the remote menu (click **Dev container: …** at the left of the status
bar) has:

- **Rebuild container**: after changing `devcontainer.json` or its Dockerfile.
- **Reopen folder locally**: back to the folder on your computer.

**Dev containers: Attach to running container…** opens a window in any running container you
pick, with or without a configuration. **Dev containers: Show the dev containers log** has what
docker printed.

| Command | What it does |
|---|---|
| Dev containers: Reopen in container | Opens the folder inside its container |
| Dev containers: Rebuild container | Builds the container again and reopens the folder in it |
| Dev containers: Reopen folder locally | Goes back to the folder on your computer |
| Dev containers: Attach to running container… | Opens a window in a running container |
| Dev containers: Show the dev containers log | What docker printed |

## WSL folders (Windows)

On Windows, **File → Open WSL folder…** opens a folder inside a WSL distribution:

1. Pick a distribution (when you have more than one).
2. Pick a folder; the dialog starts at its home folder.

Files are read through Windows' path to the distribution (`\\wsl.localhost\<distro>\…`).
Terminals, tasks, the agent's commands and git run inside the distribution, and tasks.json's
`linux` blocks apply. The status bar shows **WSL: distro**.

- Changes to files are found by checking every 2 seconds, since change notifications don't cross
  into Windows.
- The browser preview works unchanged: WSL 2 forwards `localhost`.
- git uses the distribution's own credential setup.

If no distribution is installed, the IDE says so: install one with `wsl --install` in PowerShell.

[Open a WSL folder](command:workspace.openWslFolder)

## Commands and settings

| Command | What it does |
|---|---|
| Remote: Connect to host… | Opens a window on a machine over SSH |
| Remote: Open folder on the remote… | Opens a folder on the connected machine |
| Remote: Forward a port… | Forwards a remote port to your computer |
| Remote: Stop forwarding a port | Stops a forwarded port |
| Remote: Reconnect to the remote | Connects again |
| Remote: Show the remote connection's log | The connection's log |
| Remote: Close remote connection | Disconnects |
| File: Open WSL folder… | Opens a folder in WSL (Windows) |

| Setting | Default | Description |
|---|---|---|
| `remote.containers.dockerPath` | `""` | The docker program dev containers use: empty for docker on PATH, or a path (podman works too) |
| `remote.containers.showReopenNotice` | `true` | When a folder with a dev container configuration opens and Docker is installed, offer to reopen it in its container |

## Common questions

### Which remote machines can I connect to?

Linux on x86_64 or ARM (64-bit), reached with `ssh`. macOS and Windows remotes aren't supported.

### Do I need to install anything on the remote?

No. The IDE copies its server the first time, and uses the programs already there (git, your
shell, language servers, debuggers).

### Can I use the agent in a remote window?

Yes. The agent's commands run on the remote, like the terminals.

## Next steps

- [Terminal](10-terminal.md): terminals and shells.
- [Browser preview](11-browser.md): open a remote dev server.
- [Workspaces and trust](20-workspaces.md): folders, workspaces and restricted mode.
