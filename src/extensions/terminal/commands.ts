// Terminal commands that build on shell integration and multiple terminals: rename,
// run a command and wait for its result, list command records; plus the per-terminal state
// path `ide://terminals/<id>/commands`.

import { type CommandRecord, ptyIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { TerminalService } from "./service";
import { TERMINAL_COLORS, TERMINAL_ICONS, type TerminalPane, type TerminalView } from "./view";

/** Output returned to callers of terminal.runCommand (the full record stays in state). */
const MAX_RETURNED_OUTPUT = 16 * 1024;
/** terminal.runCommand waits at most an hour, like the agent's own run tool. */
const MAX_WAIT_MS = 3_600_000;

export interface TerminalCommandHost {
  terminals: TerminalService;
  views: Map<string, TerminalPane>;
  tabs: Map<string, TerminalView>;
  /** The terminal for `id`, else the most recent one (its tab's active pane), else a new one. */
  target(id: number | undefined, create: boolean): Promise<TerminalPane>;
  /** Commands run in terminals, oldest first, without repeats (Run recent command). */
  history(): readonly string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trimOutput(r: CommandRecord): CommandRecord {
  if (r.output.length <= MAX_RETURNED_OUTPUT) return r;
  return { ...r, output: `…${r.output.slice(-MAX_RETURNED_OUTPUT)}`, outputTruncated: true };
}

export function registerTerminalCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  host: TerminalCommandHost,
): void {
  const { dispatcher, state, quickInput } = services;
  const { terminals } = host;
  const idInput = s
    .integer()
    .describe("Terminal id from ide://terminals (default: most recent)")
    .optional();

  // Tab color and icon (D120, VS Code's "Change color" / "Change icon"); asks when not given.
  sub.add(
    dispatcher.register({
      id: "terminal.setColor",
      title: "Change terminal color…",
      category: "Terminal",
      description: `Colors a terminal's tab icon (default: the most recent terminal): ${TERMINAL_COLORS.join(", ")} or "none". Kept across restarts.`,
      input: s.object({
        id: idInput,
        color: s.enum([...TERMINAL_COLORS, "none"] as const).optional(),
      }),
      effects: [],
      run: async ({ id, color }) => {
        const view = await host.target(id, false);
        const picked =
          color ??
          ((
            await quickInput.pick(
              [
                { id: "none", label: "Default" },
                ...TERMINAL_COLORS.map((c) => ({
                  id: c,
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                })),
              ],
              { placeholder: "Terminal color" },
            )
          )?.id as (typeof TERMINAL_COLORS)[number] | "none" | undefined);
        if (!picked) return { color: null };
        view.setAppearance({ color: picked === "none" ? null : picked });
        return { color: picked };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.setIcon",
      title: "Change terminal icon…",
      category: "Terminal",
      description: `Sets a terminal's tab icon (default: the most recent terminal): ${TERMINAL_ICONS.join(", ")}. Kept across restarts.`,
      input: s.object({ id: idInput, icon: s.enum(TERMINAL_ICONS).optional() }),
      effects: [],
      run: async ({ id, icon }) => {
        const view = await host.target(id, false);
        const picked =
          icon ??
          ((
            await quickInput.pick(
              TERMINAL_ICONS.map((i) => ({ id: i, label: i.replace(/-/g, " "), icon: i })),
              { placeholder: "Terminal icon" },
            )
          )?.id as (typeof TERMINAL_ICONS)[number] | undefined);
        if (!picked) return { icon: null };
        view.setAppearance({ icon: picked === "square-terminal" ? null : picked });
        return { icon: picked };
      },
    }),
  );

  // What a terminal shows (D211): any program's output, with or without shell integration (a dev
  // server's log, a REPL, cmd.exe). For agents (the built-in one and external ones over MCP) and
  // extensions; read-only.
  sub.add(
    dispatcher.register({
      id: "terminal.readOutput",
      title: "Read terminal output",
      category: "Terminal",
      description:
        "The text a terminal shows now: the last lines of its scrollback and screen (default 200, at most 2000), as plain text with escape codes removed. Works for any program, with or without shell integration. Default: the most recent terminal; ids from ide://terminals.",
      input: s.object({
        id: idInput,
        lines: s
          .integer({ min: 1, max: 2000 })
          .describe("How many lines, from the end (default 200)")
          .optional(),
      }),
      effects: ["read"],
      agent: "core",
      run: async ({ id, lines }) => {
        const view = await host.target(id, false);
        const t = view.instance;
        if (!t) throw new Error("That terminal has no process yet.");
        return { id: t.id, title: t.title.peek(), ...t.renderer.readText(lines ?? 200) };
      },
    }),
  );

  // ide://terminals/<id>/commands and /output for every terminal while it lives.
  sub.add(
    terminals.onDidCreate((t) => {
      t.store.add(
        state.register(`ide://terminals/${t.id}/output`, {
          description: `What terminal ${t.id} shows now: the last lines of its scrollback and screen as plain text (any program, with or without shell integration).`,
          get: async ({ budget }) => t.renderer.readText(budget > 4000 ? 200 : 60),
        }),
      );
      t.store.add(
        state.register(`ide://terminals/${t.id}/commands`, {
          description: `Commands run in terminal ${t.id} (shell integration): command, cwd, exit code, timing and output (escape codes removed).`,
          get: async ({ budget }) => {
            const r = await ptyIpc.commands(t.id, budget > 4000 ? 50 : 10);
            const cap = budget > 4000 ? 4000 : 1000;
            const cut = (c: CommandRecord) =>
              c.output.length > cap
                ? { ...c, output: `…${c.output.slice(-cap)}`, outputTruncated: true }
                : c;
            return { ...r, running: r.running && cut(r.running), commands: r.commands.map(cut) };
          },
        }),
      );
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.rename",
      title: "Rename terminal…",
      category: "Terminal",
      description: "Gives a terminal a fixed tab title (empty name = automatic 'shell · folder').",
      input: s.object({ id: idInput, name: s.string().describe("New name").optional() }),
      effects: [],
      run: async ({ id, name }) => {
        const view = await host.target(id, false);
        const t = await view.ready;
        const chosen =
          name ??
          (await quickInput.prompt({
            prompt: "Terminal name",
            value: t.name.peek() ?? t.title.peek(),
          }));
        if (chosen === undefined) return { renamed: false };
        terminals.rename(t.id, chosen);
        return { id: t.id, title: t.title.peek() };
      },
    }),
  );

  // Clipboard and "last command" for the context menu (and keys, agents).
  const clip = async (text: string) => {
    const { clipboardIpc } = await import("../../core/ipc/system");
    await clipboardIpc.writeText(text);
  };
  const simple = (
    id: string,
    title: string,
    description: string,
    run: (t: Awaited<TerminalPane["ready"]>) => unknown,
    agent: "hidden" | "discoverable" = "hidden",
  ) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Terminal",
        description,
        input: s.object({ id: idInput }),
        effects: [],
        agent,
        run: async ({ id: which }) => run(await (await host.target(which, false)).ready),
      }),
    );
  simple("terminal.copySelection", "Copy", "Copies the terminal's selected text.", async (t) => {
    const text = t.renderer.getSelection();
    if (text) await clip(text);
    return { copied: text.length };
  });
  simple(
    "terminal.paste",
    "Paste",
    "Pastes the clipboard into the terminal (several lines are confirmed first when the program didn't ask for bracketed paste).",
    async (t) => {
      const { clipboardIpc } = await import("../../core/ipc/system");
      const text = await clipboardIpc.readText();
      if (text) await t.renderer.paste(text);
      t.renderer.focus();
    },
  );
  simple("terminal.selectAll", "Select all", "Selects everything in the terminal.", (t) =>
    t.renderer.selectAll(),
  );
  const commandInput = s
    .integer({ min: 1 })
    .describe("A command's number in the terminal (its dot's menu); default: the last one")
    .optional();
  /** The command `seq` (or the last finished one) with its output. */
  const pick = (
    t: Awaited<TerminalPane["ready"]>,
    seq: number | undefined,
  ): { command: string; output: string; exitCode?: number } => {
    const c = seq !== undefined ? t.renderer.command(seq) : t.renderer.lastCommand();
    if (!c)
      throw new Error(
        seq !== undefined
          ? "That command is no longer in the terminal."
          : "No finished command yet (needs shell integration).",
      );
    return c;
  };

  sub.add(
    dispatcher.register({
      id: "terminal.fixWithAgent",
      title: "Fix with agent",
      category: "Terminal",
      description:
        "Sends a failed command (default: the terminal's last one), its exit code and the end of its output to the agent to find out why and fix it (D124). The active chat if it's idle, else a new one.",
      input: s.object({ id: idInput, command: commandInput }),
      effects: [],
      agent: "hidden",
      run: async ({ id: which, command }) => {
        const t = await (await host.target(which, false)).ready;
        const last = pick(t, command);
        if (!last.exitCode) throw new Error("That command didn't fail.");
        const output = last.output.trim();
        const tail = output.length > 6000 ? `…\n${output.slice(-6000)}` : output;
        const fence = "`".repeat(
          Math.max(3, ...(tail.match(/`+/g) ?? []).map((m) => m.length + 1)),
        );
        const message = `This command failed in the terminal (exit code ${last.exitCode}):\n\n${fence}\n${last.command}\n${fence}\n\nIts output:\n\n${fence}\n${tail || "(no output)"}\n${fence}\n\nFind out why and fix it.`;
        try {
          await dispatcher.execute("agent.send", { message, wait: false });
        } catch (err) {
          // The active chat is busy: a new one.
          if (!/still working/i.test(err instanceof Error ? err.message : String(err))) throw err;
          await dispatcher.execute("agent.newSession");
          await dispatcher.execute("agent.send", { message, wait: false });
        }
        return { sent: true, command: last.command, exitCode: last.exitCode };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.copyLastCommand",
      title: "Copy last command",
      category: "Terminal",
      description:
        "Copies a command run in the terminal (default: the last one; shell integration).",
      input: s.object({ id: idInput, command: commandInput }),
      effects: [],
      agent: "hidden",
      run: async ({ id: which, command }) => {
        const c = pick(await (await host.target(which, false)).ready, command);
        await clip(c.command);
        return { command: c.command };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.copyLastOutput",
      title: "Copy last command output",
      category: "Terminal",
      description:
        "Copies the output of a command run in the terminal (default: the last one; shell integration).",
      input: s.object({ id: idInput, command: commandInput }),
      effects: [],
      agent: "hidden",
      run: async ({ id: which, command }) => {
        const c = pick(await (await host.target(which, false)).ready, command);
        await clip(c.output);
        return { lines: c.output.split("\n").length };
      },
    }),
  );

  // Command navigation (VS Code's Ctrl+Up / Ctrl+Down) and Run recent command (Ctrl+Alt+R).
  for (const [id, title, direction] of [
    ["terminal.scrollToPreviousCommand", "Scroll to previous command", -1],
    ["terminal.scrollToNextCommand", "Scroll to next command", 1],
  ] as const)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Terminal",
        description: `Scrolls the terminal to the ${direction < 0 ? "previous" : "next"} command's line (shell integration).`,
        input: s.object({ id: idInput }),
        effects: [],
        agent: "hidden",
        run: async ({ id: which }) => {
          const t = await (await host.target(which, false)).ready;
          return { scrolled: t.renderer.scrollToCommand(direction) };
        },
      }),
    );
  sub.add(
    dispatcher.register({
      id: "terminal.runRecentCommand",
      title: "Run recent command…",
      category: "Terminal",
      description:
        "Picks a command run before (in any terminal, this session and earlier ones) and runs it in the terminal (default: the most recent).",
      input: s.object({
        id: idInput,
        command: s.string().describe("Run this one without asking").optional(),
      }),
      effects: ["exec"],
      agent: "hidden",
      run: async ({ id: which, command }) => {
        let chosen = command;
        if (!chosen) {
          const history = host.history();
          if (!history.length) throw new Error("No commands yet (needs shell integration).");
          const picked = await quickInput.pick(
            [...history]
              .reverse()
              .map((c, i) => ({ id: String(i), label: c, icon: "history" as const })),
            { placeholder: "Run a recent command (newest first)" },
          );
          chosen = picked?.label;
        }
        if (!chosen) return { ran: null };
        const view = await host.target(which, true);
        const t = await view.ready;
        await t.typeCommand(chosen);
        view.focus();
        return { ran: chosen, terminalId: t.id };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.find",
      title: "Find in terminal",
      category: "Terminal",
      description:
        "Finds text in a terminal's output and scrollback (default: the most recent terminal), selecting the next match (`previous`: the one before). Returns the match number and count.",
      input: s.object({
        id: idInput,
        query: s.string().optional(),
        previous: s.boolean().optional(),
      }),
      effects: [],
      run: async ({ id, query, previous }) => {
        const view = await host.target(id, false);
        return view.find(query, previous ?? false);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.clear",
      title: "Clear terminal",
      category: "Terminal",
      description: "Clears a terminal's screen and scrollback (default: the most recent one).",
      input: s.object({ id: idInput }),
      effects: [],
      run: async ({ id }) => {
        const view = await host.target(id, false);
        (await view.ready).renderer.clear();
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.runCommand",
      title: "Run command in terminal",
      category: "Terminal",
      description:
        "Runs a command line in a terminal (default: the most recent, created if needed) and, with shell integration (bash, zsh, fish, PowerShell), waits for it to finish and returns exit code and output.",
      input: s.object({
        command: s.string().describe("Command line"),
        id: idInput,
        timeoutMs: s
          // No schema maximum: a model asking for a long wait (installs) should get the cap, not
          // a validation error the user sees as a failed command.
          .integer({ min: 100 })
          .describe("Wait at most this long (default 30000; longer than 3600000 waits 3600000)")
          .optional(),
      }),
      effects: ["exec"],
      agent: "core",
      run: async ({ command, id, timeoutMs }) => {
        const view = await host.target(id, true);
        const t = await view.ready;
        // A new terminal: typed only once its shell's first prompt is up (D254). Before it, the
        // first characters could go astray (ConPTY reads its cursor-position answer from the same
        // input: `cp …` ran as `p …`). Without shell integration, a few seconds at most.
        const ready = Date.now() + 8000;
        while (!t.promptReady.peek() && Date.now() < ready && t.exitCode.peek() === null)
          await sleep(100);
        const before = await ptyIpc.commands(t.id, 1);
        const lastId = before.commands.at(-1)?.id ?? before.running?.id ?? 0;
        await t.typeCommand(command);
        const deadline = Date.now() + Math.min(timeoutMs ?? 30000, MAX_WAIT_MS);
        for (let attempt = 0; Date.now() < deadline; attempt++) {
          await sleep(attempt < 10 ? 100 : 250);
          const now = await ptyIpc.commands(t.id, 5);
          const done = now.commands.find((c) => c.id > lastId);
          if (done) return { terminalId: t.id, finished: true, ...trimOutput(done) };
          if (!now.integrationActive && attempt > 20)
            return {
              terminalId: t.id,
              finished: null,
              note: "This shell has no shell integration; the command was sent but its result can't be tracked.",
            };
        }
        const still = (await ptyIpc.commands(t.id, 1)).running;
        return {
          id: t.id,
          finished: false,
          note: "Still running when the timeout passed.",
          running: still && trimOutput(still),
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "terminal.commands",
      title: "List terminal commands",
      category: "Terminal",
      description:
        "Returns recent commands of a terminal (shell integration): command, cwd, exit code, output.",
      input: s.object({
        id: idInput,
        limit: s.integer({ min: 1, max: 200 }).describe("Default 20").optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ id, limit }) => {
        const view = await host.target(id, false);
        const t = await view.ready;
        const r = await ptyIpc.commands(t.id, limit ?? 20);
        return { terminalId: t.id, ...r, commands: r.commands.map(trimOutput) };
      },
    }),
  );
}
