// Child processes: terminals (pty), agents' one-shot commands (exec), and the stdio JSON-RPC host
// (language servers, MCP servers, ACP agents).
import { Emitter } from "../events/index";
import type { Transport } from "../lsp/jsonrpc";
import { Channel, call } from "./invoke";
import { orderedSender } from "./ordered";
import {
  isVirtualPty,
  killVirtualPty,
  resizeVirtualPty,
  spawnVirtualPty,
  writeVirtualPty,
} from "./virtualPty";

export interface PtyInfo {
  id: number;
  pid: number | null;
  shell: string;
  cwd: string;
  /** Shell integration scripts were loaded (bash, zsh, fish, PowerShell). */
  integration: boolean;
  /** The secret in the scripts' command-line marks (D192). */
  nonce?: string | null;
  /** A Windows bash (Git Bash): folders as `/c/…`, POSIX paths typed (D204). */
  msys?: boolean;
  /** The secret a reloaded page gives back to reattach it (`ptyIpc.attach`); Rust ptys only. */
  key?: string;
}

/** What `ptyIpc.attach` returns: the terminal as started, and where the replayed output starts. */
export interface PtyAttached {
  info: PtyInfo;
  /** Output offset of the first byte that arrives (the replay, then live output). */
  from: number;
  /** The replay starts exactly at the offset asked for (the saved screen can be drawn first). */
  complete: boolean;
  /** The console's size now. */
  cols: number;
  rows: number;
  /** A command was running (shell integration). */
  running: boolean;
}

/**
 * This page's token (VS Code's process revival): Rust keeps the terminals a page started or
 * reattached when that page reports its load, and detaches the previous page's for this one.
 */
const PAGE_TOKEN = (() => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
})();

/** A shell found on this machine (Rust: pty/profiles.rs). */
export interface DetectedProfile {
  name: string;
  path: string;
  args: string[];
  /** The VS Code `source` it answers to ("PowerShell", "Git Bash"). */
  source?: string;
  /** "powershell", "cmd", "bash", "linux" or "terminal". */
  icon: string;
}

/** A terminal profile to start: candidate programs (first existing wins), args, env. */
export interface ProfileSpec {
  path: string[];
  /** Omitted: the IDE's own arguments (shell integration, login flags). */
  args?: string[];
  /** null removes a variable. */
  env?: Record<string, string | null>;
  /** An extension's pseudoterminal instead of a program (virtualPty.ts, D233). */
  virtual?: string;
}

export interface TerminalShells {
  profiles: DetectedProfile[];
  /** Windows: "bundled" (a conpty.dll next to the app) or "system"; null elsewhere. */
  conpty: "bundled" | "system" | null;
}

/** One command seen through shell integration (OSC 633/133). */
export interface CommandRecord {
  id: number;
  command: string;
  cwd: string | null;
  startedMs: number;
  endedMs: number | null;
  exitCode: number | null;
  /** Output without escape sequences (at most 64 KB). */
  output: string;
  outputTruncated: boolean;
}

export interface TerminalCommands {
  integrationActive: boolean;
  cwd: string | null;
  running: CommandRecord | null;
  commands: CommandRecord[];
}

/**
 * A task to run in a terminal instead of an interactive shell (D134): a command line through a
 * shell, or a program with arguments; the terminal's process ends with it.
 */
export interface RunSpec {
  kind: "shell" | "process";
  /** The command line (shell) or the program (process). */
  command: string;
  args?: string[];
  /** A shell other than the default one (tasks.json `options.shell`). */
  shell?: { executable: string; args?: string[] };
  /** null removes a variable (an automation profile's `env: { "X": null }`, D209). */
  env?: Record<string, string | null>;
  /** An extension's custom task: its pseudoterminal serves the terminal (virtualPty.ts, D233). */
  virtual?: string;
}

export interface PtyHandlers {
  /** Raw output bytes. Call `ptyIpc.ack(id, bytes.length)` once rendered (flow control). */
  onData(bytes: Uint8Array): void;
  onExit(code: number): void;
}

export const ptyIpc = {
  spawn: (
    cwd: string | null,
    cols: number,
    rows: number,
    handlers: PtyHandlers,
    shellIntegration = true,
    run?: RunSpec,
    profile?: ProfileSpec,
    /** Variables for an interactive shell too (a JavaScript debug terminal, D204). */
    env?: Record<string, string>,
  ): Promise<PtyInfo> => {
    const virtual = run ? run.virtual : profile?.virtual;
    if (virtual) return spawnVirtualPty(virtual, cols, rows, handlers);
    const channel = new Channel<ArrayBuffer | { exit: number }>((message) => {
      if (message instanceof ArrayBuffer) handlers.onData(new Uint8Array(message));
      else handlers.onExit(message.exit);
    });
    return call<PtyInfo>("pty_spawn", {
      cwd,
      cols,
      rows,
      onOutput: channel,
      shellIntegration,
      run: run ?? null,
      profile: profile ?? null,
      env: env ?? null,
      page: PAGE_TOKEN,
    });
  },
  /**
   * Takes back a terminal the previous page had (after a reload): `since` is the output offset
   * its saved screen reflects; output after it arrives first, then the live output. `size` null
   * keeps the console's. Rejects with "Gone" (it ended, or another run of the IDE) or
   * "AlreadyAttached" (a page shows it).
   */
  attach: (
    id: number,
    key: string,
    since: number | null,
    size: { cols: number; rows: number } | null,
    handlers: PtyHandlers,
  ): Promise<PtyAttached> => {
    const channel = new Channel<ArrayBuffer | { exit: number }>((message) => {
      if (message instanceof ArrayBuffer) handlers.onData(new Uint8Array(message));
      else handlers.onExit(message.exit);
    });
    return call<PtyAttached>("pty_attach", {
      id,
      key,
      onOutput: channel,
      since,
      cols: size?.cols ?? null,
      rows: size?.rows ?? null,
      page: PAGE_TOKEN,
    });
  },
  /** Lets a terminal go without ending it: a page can reattach it within the grace period. */
  detach: (id: number): Promise<void> =>
    isVirtualPty(id) ? Promise.resolve() : call<void>("pty_detach", { id }),
  /** Ends the terminals no page holds (revival off after a reload); returns how many. */
  killDetached: (): Promise<number> => call<number>("pty_kill_detached"),
  /** The shells installed here (VS Code's detected profiles) and the ConPTY in use. */
  profiles: (): Promise<TerminalShells> => call<TerminalShells>("pty_profiles"),
  /** Program names on PATH (command suggestions; cached in Rust). */
  pathCommands: (): Promise<string[]> => call<string[]>("pty_path_commands"),
  /** What terminal `id`'s shell prints for its aliases and functions (suggest.ts parses it). */
  shellGlobals: (id: number): Promise<string> =>
    isVirtualPty(id) ? Promise.resolve("") : call<string>("pty_shell_globals", { id }),
  /** Entry names of a folder, absolute or relative to terminal `id`'s current folder. */
  listDir: (id: number, dir: string, hidden = false): Promise<{ name: string; dir: boolean }[]> =>
    isVirtualPty(id)
      ? Promise.resolve([])
      : call<{ name: string; dir: boolean }[]>("pty_list_dir", { id, dir, hidden }),
  // An extension's pseudoterminal (D233) is answered in the page, never by Rust.
  write: (id: number, data: string): Promise<void> =>
    isVirtualPty(id)
      ? Promise.resolve(writeVirtualPty(id, data))
      : call<void>("pty_write", { id, data }),
  resize: (id: number, cols: number, rows: number): Promise<void> =>
    isVirtualPty(id)
      ? Promise.resolve(resizeVirtualPty(id, cols, rows))
      : call<void>("pty_resize", { id, cols, rows }),
  ack: (id: number, bytes: number): Promise<void> =>
    isVirtualPty(id) ? Promise.resolve() : call<void>("pty_ack", { id, bytes }),
  kill: (id: number): Promise<void> =>
    isVirtualPty(id) ? Promise.resolve(killVirtualPty(id)) : call<void>("pty_kill", { id }),
  commands: (id: number, limit = 50): Promise<TerminalCommands> =>
    isVirtualPty(id)
      ? Promise.resolve({ integrationActive: false, cwd: null, running: null, commands: [] })
      : call<TerminalCommands>("pty_commands", { id, limit }),
};

// Non-interactive commands for agents (Rust: src-tauri/src/exec).
export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** It ran in the command sandbox (D336). */
  sandboxed?: boolean;
  /** Hosts the sandbox's network filter refused (D350). */
  blockedHosts?: string[];
  /** What the sandbox couldn't set up (a secret it couldn't hide, D349). */
  sandboxNotes?: string[];
}

/** What the command sandbox does on this system (Rust: exec/sandbox.rs, D336). */
export interface SandboxInfo {
  mechanism: string | null;
  limitsWrites: boolean;
  limitsNetwork: boolean;
  limitsReads?: boolean;
  network?: "blocked" | "proxy" | "open";
  note: string;
}

/** What a sandboxed command may not read and may reach besides its folder (D349, D350). */
export interface ExecSandboxPolicy {
  denyRead: string[];
  allowWrite: string[];
  allowHosts: string[];
}

/** Sent by exec_run after the last output chunk (src-tauri/src/ipc/process.rs). */
const EXEC_END = "\u0000end";

/** The project's own formatter's output (D140). */
export interface ProjectFormatted {
  /** "prettier", "biome", "ruff", "black", "rustfmt", "gofmt", "clang-format". */
  formatter: string;
  text: string;
}

export const formatIpc = {
  /** Formats `text` (file `path`) with the project's formatter; null when it has none. */
  project: (path: string, text: string): Promise<ProjectFormatted | null> =>
    call<ProjectFormatted | null>("format_project", { path, text }),
};

export const execIpc = {
  run: (
    id: string,
    command: string,
    /** `stdin`: written to the command's input, then closed (hooks read JSON there, D227). */
    /**
     * `sandbox`: in the command sandbox (D336; not for a remote or WSL folder), with its policy
     * when one is given (D349, D350).
     */
    options: {
      cwd?: string;
      timeoutMs?: number;
      stdin?: string;
      env?: Record<string, string>;
      sandbox?: boolean | ExecSandboxPolicy;
    },
    onOutput: (chunk: string) => void,
  ): Promise<ExecResult> =>
    // Resolves once all output arrived: the result can overtake the last chunks (EXEC_END).
    new Promise<ExecResult>((resolve, reject) => {
      let result: ExecResult | undefined;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (!result || !ended) return;
        clearTimeout(timer);
        resolve(result);
      };
      const channel = new Channel<string>((chunk) => {
        if (chunk === EXEC_END) {
          ended = true;
          finish();
        } else onOutput(chunk);
      });
      call<ExecResult>("exec_run", {
        id,
        command,
        cwd: options.cwd ?? null,
        timeoutMs: options.timeoutMs ?? null,
        stdin: options.stdin ?? null,
        env: options.env ?? null,
        sandbox: options.sandbox ? true : null,
        sandboxPolicy: typeof options.sandbox === "object" ? options.sandbox : null,
        onOutput: channel,
      }).then((r) => {
        result = r;
        finish();
        timer = setTimeout(() => resolve(r), 2000);
      }, reject);
    }),
  cancel: (id: string): Promise<void> => call<void>("exec_cancel", { id }),
  /** The hosts a running sandboxed command was refused so far (D372). */
  blockedHosts: (id: string): Promise<string[]> => call<string[]>("exec_blocked_hosts", { id }),
  /** What the command sandbox does on this system (D336). */
  sandboxInfo: (): Promise<SandboxInfo> => call<SandboxInfo>("exec_sandbox_info"),
  /** Windows: the secrets the sandbox hid get their labels from before back (D349); the paths. */
  sandboxUnhide: (): Promise<string[]> => call<string[]>("exec_sandbox_unhide"),
  /**
   * Cancels what this window's previous page left running (a reload mid-turn): the agent's model
   * requests and commands (D163). Its terminals wait for this page to take them back
   * (`ptyIpc.attach`, m7.12); the ones this page already has stay with it.
   */
  pageLoaded: (): Promise<void> => call<void>("page_loaded", { page: PAGE_TOKEN }),
  /** Which of these programs are installed (Ollama, agent CLIs; D164). */
  installed: (names: readonly string[]): Promise<boolean[]> =>
    call<boolean[]>("programs_installed", { names }),
};

// Stdio JSON-RPC host (Rust: src-tauri/src/lsp): spawn a language server, MCP server or ACP agent,
// exchange framed messages, stop it. The protocols live in src/core/{lsp,mcp,acp}.
export interface ServerSpec {
  command: string;
  args: string[];
  /** Absolute working directory inside the workspace (usually its root). */
  cwd: string;
  env?: Record<string, string>;
  /**
   * "lsp" (Content-Length headers, default), "ndjson" (one message per line: MCP, ACP), or
   * "lines" (a program's output, every line, empty ones too; `${env:NAME}` filled into `env`:
   * the debugger's captured programs), or "chunks" (as "lines", but stdout and stderr come as
   * they are written, line breaks kept: a line without its end isn't held back).
   */
  framing?: "lsp" | "ndjson" | "lines" | "chunks";
}

export type LspEvent =
  | { kind: "message"; body: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null };

/** Messages to one program stay in order (see ordered.ts). */
const lspSender = orderedSender((id, body) => call<void>("lsp_send", { id, body }));

export const lspIpc = {
  /** Starts server `id` (replacing one with that id); returns its process id. */
  start: (id: string, spec: ServerSpec, onEvent: (e: LspEvent) => void): Promise<number> => {
    lspSender.reset(id);
    return call<number>("lsp_start", { id, spec, onEvent: new Channel<LspEvent>(onEvent) });
  },
  /** One message, after the ones sent to `id` before it. */
  send: (id: string, body: string): Promise<void> => lspSender.send(id, body),
  stop: (id: string): Promise<void> => call<void>("lsp_stop", { id }),
  /** Closes its input (it reads end-of-file). */
  closeStdin: (id: string): Promise<void> => call<void>("lsp_close_stdin", { id }),
  /** Ctrl+C (SIGINT); refused on Windows. */
  interrupt: (id: string): Promise<void> => call<void>("lsp_interrupt", { id }),
};

// A process on the Rust stdio host as a JSON-RPC transport (MCP servers, ACP agents; the LSP
// manager uses the same pieces). Stderr lines and exit are reported separately.
export interface StdioProcess {
  transport: Transport;
  pid: number;
  stop(): Promise<void>;
}

export async function startStdioProcess(
  id: string,
  spec: ServerSpec,
  handlers: { stderr?(line: string): void; exit?(): void },
): Promise<StdioProcess> {
  const messages = new Emitter<string>();
  const pid = await lspIpc.start(id, spec, (event) => {
    if (event.kind === "message") messages.fire(event.body);
    else if (event.kind === "stderr") handlers.stderr?.(event.line);
    else handlers.exit?.();
  });
  return {
    pid,
    transport: {
      send: (body) => void lspIpc.send(id, body).catch(() => {}),
      onMessage: messages.event,
    },
    stop: async () => {
      await lspIpc.stop(id).catch(() => {});
      messages.dispose();
    },
  };
}

// Debugger inspector sockets (Rust: src-tauri/src/debug, D143): local ws:// addresses only.
export type DebugSocketEvent =
  | { kind: "message"; body: string }
  | { kind: "closed"; reason: string };

export const debugSocketIpc = {
  connect: (id: string, url: string, onEvent: (e: DebugSocketEvent) => void): Promise<void> =>
    call<void>("debug_socket_connect", {
      id,
      url,
      onEvent: new Channel<DebugSocketEvent>(onEvent),
    }),
  send: (id: string, body: string): Promise<void> => call<void>("debug_socket_send", { id, body }),
  close: (id: string): Promise<void> => call<void>("debug_socket_close", { id }),
  /** The inspector's targets at host:port (`/json/list`) as JSON text. */
  targets: (host: string, port: number): Promise<string> =>
    call<string>("debug_inspector_targets", { host, port }),
  /** A text file from a server on this machine (http://localhost…; a page's source map). */
  get: (url: string): Promise<string> => call<string>("debug_local_get", { url }),
  /**
   * A debug adapter listening on host:port of this machine (Delve's `dlv dap`, D204): each DAP
   * message's JSON arrives as a "message"; `send` writes one (framed in Rust).
   */
  dapConnect: (
    id: string,
    host: string,
    port: number,
    onEvent: (e: DebugSocketEvent) => void,
  ): Promise<void> =>
    call<void>("debug_dap_connect", {
      id,
      host,
      port,
      onEvent: new Channel<DebugSocketEvent>(onEvent),
    }),
  /**
   * Where Chrome or Edge is installed (Rust looks: the page's fs access can't see Program
   * Files), or null.
   */
  findBrowser: (kind: "chrome" | "edge"): Promise<string | null> =>
    call<string | null>("debug_find_browser", { kind }),
  /** The browser pane's debugging port for the next start (WebView2 only; 0: off). */
  setPanePort: (port: number): Promise<void> => call<void>("debug_set_pane_port", { port }),
  /** Every process on this machine, as `ps` or PowerShell printed it (debug/processes.ts). */
  listProcesses: (): Promise<{ format: "ps" | "windows"; text: string }> =>
    call<{ format: "ps" | "windows"; text: string }>("debug_list_processes", {}),
};

/** Auto-attach registrations (D204, Rust: src-tauri/src/debug/autoattach.rs). */
export const debugAttachIpc = {
  /** A fresh registration folder and the bootloader's path. */
  prepare: (): Promise<{ id: string; dir: string; bootloader: string }> =>
    call<{ id: string; dir: string; bootloader: string }>("debug_autoattach_prepare", {}),
  /** Registrations (JSON texts) since the last call; keeps the folder alive. */
  take: (id: string): Promise<string[]> => call<string[]>("debug_autoattach_take", { id }),
  dispose: (id: string): Promise<void> => call<void>("debug_autoattach_dispose", { id }),
};
