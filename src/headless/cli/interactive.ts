// Node only. The session at a terminal: a prompt with line editing and history, the answer as
// it streams, tool calls with their outcome, questions asked inline, slash commands, a status
// line after each turn. Ctrl+C stops the agent; a second one quits. Lines only: no screen is
// taken over, so it works in every console and over a pipe (`--interactive`).
import { product } from "../../core/product";
import { modeSettings } from "../../extensions/agent/unattended";
import type {
  AccessMode,
  BrainChat,
  HostedBrain,
  RunResult,
  SavedChat,
  UnattendedPolicy,
} from "../run";
import { ACCESS_MODE_NAMES, type CliArgs } from "./args";
import { Asks } from "./asks";
import { limitsOf, policyOf } from "./config";
import { countsText, diffCounts, unifiedDiff } from "./diffText";
import type { Io } from "./io";
import { ConfigError, openChat, start } from "./launch";
import { cliName } from "./name";
import { EXIT, endNote, money, tokens } from "./output";
import { Prompter } from "./prompter";
import { EventRenderer } from "./render";
import { ago, chatLines } from "./sessionsCommand";
import { FRONT_COMMANDS, MultiLine, parseLine, pick } from "./slash";
import { clip, sanitize } from "./style";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The access mode the settings and a chat's edit mode amount to. */
export function accessModeOf(runCommands: string | undefined, autoApply: boolean): AccessMode {
  if (runCommands === "full") return "full-access";
  if (runCommands === "auto") return "auto";
  return autoApply ? "accept-edits" : "ask";
}

interface AppSlashCommand {
  name: string;
  description: string;
  source: string;
  argumentHint?: string;
}

export async function runInteractive(args: CliArgs, io: Io): Promise<number> {
  const style = io.style("stdout", args.color);
  const prompter = new Prompter({ input: io.stdin, output: io.stdout });
  const asks = new Asks(prompter, style);
  const say = (text = "") => prompter.line(text);
  const policy: UnattendedPolicy = policyOf(args, true);
  const name = cliName();

  let brain: HostedBrain;
  let folder: string;
  try {
    const started = await start(args, {
      frontend: "cli",
      policy,
      services: asks.servicePolicy(),
      ...(args.verbose && { log: (text: string) => io.err(text) }),
    });
    brain = started.brain;
    folder = started.folder;
    say(`${style.bold(name)} ${style.dim(`${product.version} · ${folder}`)}`);
    // A folder nobody decided about: asked once, at a terminal, and remembered as the app does.
    if (brain.services.trust.state.peek() === "unknown" && prompter.isTTY) {
      const trust = await asks.confirm(
        "Its own hooks, MCP servers, tasks and settings would apply. Trust only folders whose contents you know. Remembered either way (change it with --trust, or in the app).",
        `Trust this folder? ${folder}`,
      );
      await brain.execute("workspace.setTrust", { trusted: trust }).catch((err) => {
        say(style.red(`Couldn't save that: ${messageOf(err)}`));
      });
    } else for (const note of started.notes) say(style.dim(note));
  } catch (err) {
    prompter.close();
    throw err;
  }

  let chat: BrainChat;
  const events: { current: { dispose(): void } | null } = { current: null };
  const renderer = new EventRenderer((text) => prompter.print(text), {
    style,
    verbose: args.verbose,
    answer: true,
    columns: () => prompter.columns,
  });
  let busy = false;
  let turnAbort: AbortController | null = null;
  let quitting = false;
  let exitCode: number = EXIT.ok;
  let lastInterrupt = 0;
  /** The last Ctrl+C stopped a turn (and nothing was typed since). */
  let stoppedTurn = false;
  let hostGone: string | null = null;
  const multi = new MultiLine();

  const attach = (next: BrainChat): void => {
    events.current?.dispose();
    chat = next;
    events.current = next.onEvent((event) => {
      renderer.handle(event);
      if (event.type === "permission.request") void asks.permission(brain, event);
      else if (event.type === "permission.decision") asks.decided(event.id);
      else if (event.type === "question") void asks.question(brain, event);
      else if (event.type === "turn.end") prompter.cancelAsks();
    });
  };

  const settings = <T>(key: string): T | undefined => brain.services.settings.peek<T>(key);
  const modelName = (): string =>
    chat.session.model.peek() ?? brain.agent.providers.defaultModel()?.key ?? "no model";
  const accessMode = (): AccessMode =>
    accessModeOf(settings<string>("agent.runCommands"), chat.session.autoApply.peek());
  const chatModeName = (): string => {
    const mode = chat.session.chatMode.peek();
    const work = chat.session.work();
    return mode.startsWith("custom:")
      ? `${mode.slice(7)}${work === "agent" ? "" : ` (${work})`}`
      : work;
  };

  const statusLine = (): string => {
    const usage = chat.session.usage.peek();
    const cost = chat.session.cost.peek();
    const parts = [
      modelName(),
      chatModeName(),
      accessMode(),
      ...(cost !== null ? [money(cost)] : []),
      ...(usage?.limit ? [`context ${Math.round((usage.tokens / usage.limit) * 100)}%`] : []),
    ];
    return style.dim(parts.join(" · "));
  };

  const pendingNote = (): void => {
    const files = chat.session.changeset.files.peek();
    if (!files.length) return;
    say(
      style.yellow(
        `${files.length} file${files.length === 1 ? "" : "s"} wait${files.length === 1 ? "s" : ""} for review: /diff shows the changes, /accept keeps them, /reject puts the old text back.`,
      ),
    );
  };

  /** Sends one message and waits for the work it starts to end. */
  const runTurn = async (text: string): Promise<void> => {
    busy = true;
    turnAbort = new AbortController();
    let result: RunResult | null = null;
    try {
      result = await chat.send(text, { ...limitsOf(args), signal: turnAbort.signal });
    } catch (err) {
      renderer.flush();
      say(style.red(messageOf(err)));
    } finally {
      busy = false;
      turnAbort = null;
    }
    renderer.flush();
    prompter.cancelAsks();
    if (!result) return;
    if (result.command) {
      commandResult(result.command);
      return;
    }
    const note = endNote({ ...result, denied: [] });
    if (note && result.reason !== "error") say(style.yellow(note));
    pendingNote();
    say(statusLine());
  };

  /** What a slash command of the app answered instead of a turn. */
  const commandResult = (command: Record<string, unknown>): void => {
    if (typeof command.compacted === "number")
      say(style.dim(`Summarized ${command.compacted} messages.`));
    else if (typeof command.cleared === "string" && typeof command.session === "string") {
      void switchTo(command.session, "New chat.");
    } else if (Array.isArray(command.models)) {
      listModels();
    } else if (args.verbose) say(style.dim(JSON.stringify(command)));
  };

  const switchTo = async (id: string | undefined, said: string): Promise<void> => {
    const opened = await openChat(
      brain,
      { ...args, continue: false, resume: undefined, sessionId: undefined },
      false,
      id,
    );
    attach(opened.chat);
    say(style.dim(said));
    if (opened.resumed) recap();
  };

  /** A resumed chat's last exchange, so the person knows where it stands. */
  const recap = (): void => {
    const items = chat.session.items;
    const lastUser = items.findLast((i) => i.type === "user" && !i.auto);
    const lastReply = items.findLast((i) => i.type === "assistant" && i.text.trim());
    say(style.dim(`${sanitize(chat.session.title.peek())} · ${items.length} items · ${chat.id}`));
    if (lastUser?.type === "user")
      say(style.dim(`> ${clip(lastUser.text, prompter.columns - 4, style.unicode)}`));
    if (lastReply?.type === "assistant")
      say(style.dim(clip(lastReply.text, prompter.columns * 2, style.unicode)));
  };

  const models = (): string[] => [
    ...brain.agent.providers.models.peek().map((m) => m.key),
    ...Object.keys(settings<Record<string, unknown>>("agent.externalAgents") ?? {}).map(
      (agent) => `acp/${agent}`,
    ),
  ];

  const listModels = (): void => {
    const list = models();
    if (!list.length) {
      say(style.yellow("No models. Start Ollama, or add a provider and its key (see --help)."));
      return;
    }
    const current = modelName();
    say(
      list
        .map(
          (m, n) =>
            `${style.dim(String(n + 1).padStart(3))}  ${m}${m === current ? style.green("  (current)") : ""}`,
        )
        .join("\n"),
    );
    say(style.dim("Switch with /model <number or name>."));
  };

  const chatsHere = async (): Promise<SavedChat[]> => (await brain.chats()).filter((c) => c.here);

  const help = async (): Promise<void> => {
    const lines = [style.bold("This session")];
    for (const c of FRONT_COMMANDS)
      lines.push(
        `  ${`/${c.name}${c.hint ? ` ${c.hint}` : ""}`.padEnd(30)} ${style.dim(c.description)}`,
      );
    const listed = await brain
      .execute<{ commands: AppSlashCommand[] }>("agent.slash", { session: chat.id, pick: false })
      .catch(() => ({ commands: [] as AppSlashCommand[] }));
    const own = new Set(FRONT_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const app = listed.commands.filter((c) => !own.has(c.name));
    if (app.length) {
      lines.push("", style.bold("The agent's commands"));
      for (const c of app)
        lines.push(
          `  ${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`.padEnd(30)} ${style.dim(clip(c.description, Math.max(20, prompter.columns - 34), style.unicode))}`,
        );
    }
    lines.push(
      "",
      style.dim(
        "End a line with \\ to continue it on the next. Ctrl+C stops the agent; twice quits. Ctrl+D ends the session.",
      ),
    );
    say(lines.join("\n"));
  };

  /** One of the session's own commands. Returns false to end the session. */
  const front = async (command: string, rest: string): Promise<boolean> => {
    switch (command) {
      case "exit":
        return false;
      case "help":
        await help();
        return true;
      case "model": {
        await brain.agent.providers.refreshIfStale(5000, 5000);
        if (!rest) {
          listModels();
          return true;
        }
        const chosen = pick(rest, models(), (m) => [m, m.split("/").slice(1).join("/")]);
        if (!chosen) {
          say(style.red(`No model matches "${rest}". /model lists them.`));
          return true;
        }
        await brain.execute("agent.selectModel", { session: chat.id, model: chosen });
        say(style.dim(`Model: ${modelName()}`));
        return true;
      }
      case "mode": {
        if (!rest) {
          const custom =
            ((await brain.state("ide://agent/chatModes").catch(() => [])) as {
              id: string;
              name: string;
            }[]) ?? [];
          say(
            `Mode: ${style.bold(chatModeName())}\n${style.dim(`agent (reads, edits, runs commands), plan (read-only, writes a plan), ask (read-only answers)${custom.length ? `; your agents: ${custom.map((c) => c.name).join(", ")}` : ""}`)}`,
          );
          return true;
        }
        const builtIn = ["agent", "plan", "ask"].includes(rest.toLowerCase());
        await brain.execute("agent.setChatMode", {
          session: chat.id,
          mode: builtIn ? rest.toLowerCase() : rest.startsWith("custom:") ? rest : `custom:${rest}`,
        });
        say(style.dim(`Mode: ${chatModeName()}`));
        return true;
      }
      case "permissions": {
        if (!rest) {
          const allowed = settings<string[]>("agent.allowedCommands") ?? [];
          say(
            [
              `Access: ${style.bold(accessMode())}`,
              style.dim(
                "ask (edits wait for your review, commands ask) · accept-edits (edits are accepted, commands ask) · auto (commands run, risky ones ask) · full-access (nothing asks)",
              ),
              ...(policy.allow?.length ? [style.dim(`--allow: ${policy.allow.join(", ")}`)] : []),
              ...(policy.deny?.length ? [style.dim(`--deny: ${policy.deny.join(", ")}`)] : []),
              ...(allowed.length
                ? [style.dim(`Always allowed (settings): ${allowed.join(", ")}`)]
                : []),
            ].join("\n"),
          );
          return true;
        }
        const mode = pick(rest, ACCESS_MODE_NAMES, (m) => [m]);
        if (!mode) {
          say(style.red(`Access is one of ${ACCESS_MODE_NAMES.join(", ")}.`));
          return true;
        }
        const applied = modeSettings(mode);
        // For this session only, as --permission-mode: the settings files stay as they are.
        policy.mode = mode;
        brain.override(applied.settings);
        brain.agent.sessions.autoApply = applied.autoApply;
        chat.session.autoApply.value = applied.autoApply;
        say(style.dim(`Access: ${accessMode()}`));
        return true;
      }
      case "sessions": {
        const list = await chatsHere();
        say(
          list.length
            ? `${chatLines(list, style, Date.now(), false, prompter.columns)}\n${style.dim("Switch with /resume <number or id>.")}`
            : style.dim("No saved chats for this folder yet."),
        );
        return true;
      }
      case "resume": {
        const list = await chatsHere();
        const chosen = rest ? pick(rest, list, (c) => [c.id, c.title]) : await pickChat(list);
        if (!chosen) {
          if (rest) say(style.red(`No chat matches "${rest}". /sessions lists them.`));
          return true;
        }
        await switchTo(chosen.id, `Resumed (${ago(chosen.updated, Date.now())}).`);
        return true;
      }
      case "new": {
        // The app's /clear: the old chat ends (its hooks run) and stays saved.
        const result = await chat.send("/clear");
        const next = result.command?.session;
        await switchTo(typeof next === "string" ? next : undefined, "New chat.");
        return true;
      }
      case "compact":
        await runTurn(`/compact${rest ? ` ${rest}` : ""}`);
        return true;
      case "cost": {
        const totals = chat.session.totals.peek();
        const usage = chat.session.usage.peek();
        const cost = chat.session.cost.peek();
        say(
          [
            `Requests: ${totals.requests}`,
            `Tokens: ${tokens(totals.input)} in, ${tokens(totals.output)} out${totals.cacheRead ? `, ${tokens(totals.cacheRead)} from cache` : ""}`,
            usage?.limit
              ? `Context: ${tokens(usage.tokens)} of ${tokens(usage.limit)} (${Math.round((usage.tokens / usage.limit) * 100)}%)`
              : "Context: not measured yet",
            `Cost: ${cost === null ? "not known for this model" : money(cost)}`,
          ].join("\n"),
        );
        return true;
      }
      case "status": {
        say(
          [
            `Folder: ${folder} (${brain.services.trust.state.peek()})`,
            `Chat: ${chat.id}  ${style.dim(sanitize(chat.session.title.peek()))}`,
            `Model: ${modelName()}`,
            `Mode: ${chatModeName()}`,
            `Access: ${accessMode()}`,
            `Host: ${brain.host?.version ?? "?"} (${brain.host?.os ?? "?"})`,
          ].join("\n"),
        );
        return true;
      }
      case "key": {
        const providers = brain.agent.providers.statuses.peek();
        if (!providers.length) {
          say(style.yellow("No provider is set up. Add one in the settings (agent.providers)."));
          return true;
        }
        const chosen = rest
          ? pick(rest, providers, (p) => [p.id, p.name])
          : providers.length === 1
            ? providers[0]
            : null;
        if (!chosen) {
          say(
            `${rest ? style.red(`No provider matches "${rest}". `) : ""}Providers: ${providers.map((p) => `${p.id}${p.state === "ok" ? "" : style.dim(` (${p.state})`)}`).join(", ")}
${style.dim("Store a key with /key <provider>. Keys in the environment (ANTHROPIC_API_KEY…) work without this.")}`,
          );
          return true;
        }
        // The app's own command: the key goes to its store (the keychain where there is one),
        // typed unseen, and is never shown again.
        const stored = await brain.execute<{ stored?: boolean } | null>("agent.setApiKey", {
          provider: chosen.id,
        });
        say(
          style.dim(
            stored === null
              ? "Nothing changed."
              : stored.stored
                ? `Key stored for ${chosen.id}.`
                : `Key removed for ${chosen.id}.`,
          ),
        );
        return true;
      }
      case "diff": {
        const files = chat.session.changeset.files.peek();
        if (!files.length) {
          say(style.dim("No edits wait for review."));
          return true;
        }
        for (const f of files) {
          const after = f.deleted ? null : f.proposed;
          say(
            `${style.bold(sanitize(f.path))}  ${countsText(diffCounts(f.original, after), style)}`,
          );
          prompter.print(unifiedDiff(f.path, f.original, after, style, { maxLines: 200 }));
        }
        return true;
      }
      case "accept":
      case "reject": {
        const input = { session: chat.id, ...(rest && { paths: [rest] }) };
        const done = await brain.execute<{ accepted?: string[]; rejected?: string[] }>(
          command === "accept" ? "agent.acceptAll" : "agent.rejectAll",
          input,
        );
        const list = done.accepted ?? done.rejected ?? [];
        say(
          style.dim(
            list.length
              ? `${command === "accept" ? "Kept" : "Dropped"}: ${list.join(", ")}`
              : "Nothing to do.",
          ),
        );
        return true;
      }
      default:
        return true;
    }
  };

  const pickChat = async (list: readonly SavedChat[]): Promise<SavedChat | null> => {
    if (!list.length) {
      say(style.dim("No saved chats for this folder yet."));
      return null;
    }
    say(chatLines(list.slice(0, 30), style, Date.now(), false, prompter.columns));
    const typed = await prompter.ask(
      `${style.dim("Resume which? (number or id; Enter: none)")} ${style.bold(">")} `,
    );
    return typed ? pick(typed, list, (c) => [c.id, c.title]) : null;
  };

  const quit = (code: number): void => {
    if (quitting) return;
    quitting = true;
    exitCode = code;
    turnAbort?.abort();
    prompter.cancelAsks();
    prompter.close();
  };

  prompter.onInterrupt = () => {
    const now = Date.now();
    const again = now - lastInterrupt < 3000;
    lastInterrupt = now;
    if (quitting) {
      // Already leaving, and asked again: at once. The host ends when its input closes.
      process.exit(EXIT.interrupted);
    }
    if (busy) {
      if (again) {
        say(style.dim("Quitting."));
        quit(EXIT.interrupted);
        return;
      }
      say(style.dim("Stopping… (Ctrl+C again to quit)"));
      prompter.cancelAsks();
      stoppedTurn = true;
      chat.stop("you pressed Ctrl+C");
      return;
    }
    if (prompter.asking) {
      prompter.cancelAsks();
      return;
    }
    if (prompter.typed || multi.open) {
      multi.reset();
      prompter.clearTyped();
      lastInterrupt = 0;
      return;
    }
    // Right after stopping a turn, the second one is the "twice" that quits an interrupted run.
    if (again) quit(stoppedTurn ? EXIT.interrupted : EXIT.ok);
    else say(style.dim("(Ctrl+C again to quit, or /exit)"));
  };
  // A signal from outside (kill, a closed terminal) ends the session in order.
  const onSignal = () => (busy ? prompter.onInterrupt() : quit(EXIT.interrupted));
  process.on("SIGINT", prompter.onInterrupt);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  prompter.onBrokenOutput = () => quit(EXIT.failed);
  brain.onHostExit((code, signal) => {
    if (quitting) return;
    hostGone = `The host program ended unexpectedly (${signal ?? `exit code ${code}`}). The session can't go on; your chat was saved up to the last finished step.`;
    io.err(`\n${hostGone}\n`);
    quit(EXIT.failed);
    // Whatever was waiting on the host never comes back.
    setTimeout(() => process.exit(EXIT.failed), 500);
  });

  try {
    try {
      let session: string | undefined;
      if (args.resume === true) session = (await pickChat(await chatsHere()))?.id;
      const opened = await openChat(brain, args, false, session);
      attach(opened.chat);
      if (opened.resumed) recap();
    } catch (err) {
      if (
        err instanceof ConfigError &&
        !args.model &&
        !args.agent &&
        /No model/.test(err.message)
      ) {
        // A session can still start: the person may pick a model, or fix the setup and retry.
        say(style.yellow(err.message));
        const { chat: empty } = await brain.open().then((c) => ({ chat: c }));
        attach(empty);
      } else throw err;
    }
    const hostPrompts = asks.watchHostPrompts(brain);
    say(
      `${statusLine()}\n${style.dim("/help lists the commands. Ctrl+C stops the agent; twice quits.")}`,
    );

    let first = args.prompt;
    for (;;) {
      if (quitting) break;
      let line: string | null;
      if (first !== undefined) {
        line = first;
        first = undefined;
        say(`${style.bold(style.cyan(">"))} ${line}`);
      } else {
        line = await prompter.readLine(
          multi.open ? style.dim("… ") : `${style.bold(style.cyan(">"))} `,
        );
      }
      if (line === null) break;
      stoppedTurn = false;
      const message = multi.add(line);
      if (message === null) continue;
      if (message.includes("\n")) prompter.remember(message.replace(/\n/g, " "));
      const parsed = parseLine(message);
      try {
        if (parsed.kind === "empty") continue;
        if (parsed.kind === "front") {
          if (!(await front(parsed.command, parsed.args))) break;
        } else await runTurn(parsed.kind === "agent" ? parsed.text : parsed.text);
      } catch (err) {
        renderer.flush();
        say(style.red(messageOf(err)));
      }
    }
    hostPrompts.dispose();
  } finally {
    quitting = true;
    process.off("SIGINT", prompter.onInterrupt);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    const hurry = () => process.exit(EXIT.interrupted);
    process.on("SIGINT", hurry);
    events.current?.dispose();
    prompter.close();
    if (!hostGone) {
      const closing = brain.dispose().catch(() => {});
      await Promise.race([closing, new Promise((done) => setTimeout(done, 8000).unref())]);
    }
    process.off("SIGINT", hurry);
  }
  return hostGone ? EXIT.failed : exitCode;
}
