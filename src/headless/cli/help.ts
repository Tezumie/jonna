// The help texts, built from the flag table (args.ts) so the two can't drift. `name` is the
// launcher's name (the product's short name, lower-cased, from product.json). Pure.
import { flagsOf, type Subcommand } from "./args";

const flagLines = (command: Subcommand): string => {
  const rows = flagsOf(command).map((f) => {
    const value =
      f.kind === "boolean" ? "" : f.kind === "optional" ? ` [${f.value}]` : ` <${f.value}>`;
    return [`  ${f.short ? `-${f.short}, ` : "    "}--${f.name}${value}`, f.help] as const;
  });
  const width = Math.min(34, Math.max(...rows.map(([left]) => left.length)) + 2);
  return rows
    .map(([left, help]) =>
      left.length + 2 > width ? `${left}\n${" ".repeat(width)}${help}` : left.padEnd(width) + help,
    )
    .join("\n");
};

const EXIT_CODES = `Exit codes:
  0    the task finished
  1    the task failed (the model or a tool failed, a step, cost or time limit), or its
       chat was saved elsewhere meanwhile and this turn couldn't be saved to it
  2    bad usage or configuration (an unknown option, no model, no key, no host)
  3    a permission was refused
  130  interrupted (Ctrl+C; a second Ctrl+C quits at once)`;

/** The help of `command` ("main": the tool itself). */
export function helpText(name: string, command: Subcommand): string {
  switch (command) {
    case "main":
      return `${name}: the IDE's agent at the command line.

Usage:
  ${name} [options]                    a session in this terminal
  ${name} [options] "<prompt>"         the session, starting with this prompt
  ${name} -p "<prompt>" [options]      one shot: run the prompt, print the answer, exit
  ${name} exec "<prompt>" [options]    the same
  <command> | ${name} [options]        one shot, the prompt from standard input
  <command> | ${name} -p "<prompt>"    piped input as context for the prompt
  ${name} sessions list | show <id>    the saved chats (the ones the app shows)
  ${name} serve                        keep the agent running for a front end to attach
  ${name} acp                          run as an Agent Client Protocol agent on stdio
  ${name} help <command>               help for exec, sessions, serve or acp

Options:
${flagLines("main")}

In a session: /help lists the commands; a line ending in \\ continues on the next; Ctrl+C stops
the agent, and a second one quits.

Settings, keys, rules, skills, memory, hooks, MCP servers and chats are the app's own. API keys
come from the app's key store, else from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY,
OPENROUTER_API_KEY…), else from the settings.

${EXIT_CODES}`;
    case "exec":
      return `${name} exec: run one prompt and exit.

Usage:
  ${name} exec "<prompt>" [options]
  ${name} exec --prompt-file task.md [options]
  <command> | ${name} exec [-] [options]

The answer is printed on standard output; what the agent does on the way goes to standard error
(when that is a terminal, or with --verbose). Edits are accepted as they are made unless
--review keeps them for you to accept or reject; a question nobody can answer is refused (see
--permission-mode, --allow).

Options:
${flagLines("exec")}

${EXIT_CODES}`;
    case "sessions":
      return `${name} sessions: the saved chats, the same ones the app shows.

Usage:
  ${name} sessions list [--all] [--json]    this folder's chats, newest first
  ${name} sessions show <id> [--json]       one chat's conversation

Options:
${flagLines("sessions")}

Continue one with: ${name} --resume <id>`;
    case "serve":
      return `${name} serve: keep the agent running and let one front end attach.

Usage:
  ${name} serve [--port <n>] [--token <text>] [options]

Listens on 127.0.0.1 and prints one line of JSON when ready:
  {"type":"listening","host":"127.0.0.1","port":<n>,"token":"<secret>"}
A client sends newline-delimited JSON requests ({"id","method","params"}): hello (with the
token) first, then execute, state, chats, open, subscribe, send, stop, shutdown. Chat events
arrive as {"event":{…}} lines. Permission requests wait for the client
(agent.respondPermission, agent.answer, agent.answerHostPrompt through execute) unless
--non-interactive. Ctrl+C, or the shutdown request, ends it.

Options:
${flagLines("serve")}`;
    case "acp":
      return `${name} acp: an Agent Client Protocol agent (version 1) on standard input and output.

Usage:
  ${name} acp [options]

For editors that run ACP agents: configure "${name}" with the argument "acp" as the agent's
command. Sessions are the app's chats (session/load resumes one). Permission requests go to
the editor; --permission-mode sets the mode a session starts in (ask, accept-edits, auto,
full-access; plan is offered as a mode too).

Options:
${flagLines("acp")}`;
  }
}
