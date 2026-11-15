// Node only. The questions a run asks the person at the terminal, and their answers given back
// through the same commands any front end uses: a permission (once / always / deny), the agent's
// own questions (ask_user), the host's prompts (an MCP server's input, a sign-in again, a
// confirmation), and the services' pickers and text boxes.
import { SKIPPED } from "../../core/agent/askUser";
import { effect } from "../../core/reactive/index";
import type { Brain, HeadlessPolicy, SessionEvent } from "../run";
import type { Prompter } from "./prompter";
import { clip, type Style, sanitize } from "./style";

type PermissionEvent = Extract<SessionEvent, { type: "permission.request" }>;
type QuestionEvent = Extract<SessionEvent, { type: "question" }>;

const yes = (answer: string | null): boolean => /^(y|yes)$/i.test((answer ?? "").trim());

/** What was typed, as a permission answer; null when it isn't one. */
export function permissionAnswer(
  typed: string | null,
  always: boolean,
): "once" | "always" | "deny" | null {
  const text = (typed ?? "n").trim().toLowerCase();
  if (text === "" || /^(n|no|d|deny)$/.test(text)) return "deny";
  if (/^(y|yes|o|once)$/.test(text)) return "once";
  if (/^(a|always)$/.test(text)) return always ? "always" : "once";
  return null;
}

/**
 * What was typed for one question of a card: numbers pick options (several, separated by commas
 * or spaces, when the question takes several), anything else is the person's own answer, and
 * nothing skips it.
 */
export function questionAnswer(
  typed: string | null,
  options: readonly { label: string }[],
  multi: boolean,
): string {
  const text = (typed ?? "").trim();
  if (!text) return SKIPPED;
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.every((p) => /^\d+$/.test(p) && options[Number(p) - 1])) {
    const picked = parts.map((p) => options[Number(p) - 1]?.label ?? "");
    return multi ? [...new Set(picked)].join(", ") : (picked[0] ?? SKIPPED);
  }
  return text;
}

export class Asks {
  /** Permission requests being asked, by id: answered elsewhere, the question goes away. */
  private readonly open = new Set<string>();

  constructor(
    private readonly prompter: Prompter,
    private readonly style: Style,
  ) {}

  private say(text: string): void {
    this.prompter.line(text);
  }

  /** Asks a permission request and answers it on the chat. */
  async permission(brain: Brain, event: PermissionEvent): Promise<void> {
    const { style } = this;
    this.open.add(event.id);
    const lines = [
      "",
      `${style.yellow(style.glyph("?", "?"))} ${style.bold(sanitize(event.heading ?? event.title))}${event.danger ? style.red("  (risky)") : ""}`,
    ];
    if (event.heading && event.title !== event.heading) lines.push(`  ${sanitize(event.title)}`);
    if (event.code)
      for (const l of sanitize(event.code).split("\n")) lines.push(`    ${style.cyan(l)}`);
    if (event.detail)
      lines.push(`  ${style.dim(clip(sanitize(event.detail), 600, style.unicode))}`);
    this.say(lines.join("\n"));
    const choices = `[y] yes, once  ${event.always ? `[a] always (${clip(event.always, 40, style.unicode)})  ` : ""}[n] no`;
    let answer: "once" | "always" | "deny" | null = null;
    while (answer === null) {
      const typed = await this.prompter.ask(`  ${style.dim(choices)} ${style.bold(">")} `);
      if (!this.open.has(event.id)) return; // decided elsewhere meanwhile
      answer = typed === null ? "deny" : permissionAnswer(typed, !!event.always);
    }
    this.open.delete(event.id);
    await brain
      .execute("agent.respondPermission", { session: event.session, id: event.id, answer })
      .catch(() => {}); // gone already: the turn was stopped
  }

  /** A request was decided (here or elsewhere): a question still waiting for it is dropped. */
  decided(id: string | undefined): void {
    if (id) this.open.delete(id);
  }

  /** Asks the agent's question card and answers it. */
  async question(brain: Brain, event: QuestionEvent): Promise<void> {
    const { style } = this;
    const answers: Record<string, string> = {};
    let any = false;
    for (const [index, q] of event.questions.entries()) {
      const lines = [
        "",
        `${style.yellow("?")} ${style.bold(sanitize(q.question || q.header || `Question ${index + 1}`))}`,
      ];
      q.options.forEach((o, n) => {
        lines.push(
          `  ${style.bold(String(n + 1))}. ${sanitize(o.label)}${o.description ? style.dim(` - ${sanitize(o.description)}`) : ""}`,
        );
      });
      this.say(lines.join("\n"));
      const hint = q.options.length
        ? q.multiSelect
          ? "numbers (several: 1,3), or your own answer; Enter skips"
          : "a number, or your own answer; Enter skips"
        : "your answer; Enter skips";
      const typed = await this.prompter.ask(`  ${style.dim(hint)} ${style.bold(">")} `);
      const answer = questionAnswer(typed, q.options, q.multiSelect === true);
      if (answer !== SKIPPED) any = true;
      answers[String(index + 1)] = answer;
    }
    await brain
      .execute(
        "agent.answer",
        any && event.questions.length
          ? { session: event.session, item: event.id, answers }
          : { session: event.session, item: event.id, skip: true },
      )
      .catch(() => {});
  }

  /** A yes or no. */
  async confirm(message: string, title?: string): Promise<boolean> {
    const { style } = this;
    this.say(
      `\n${style.yellow("?")} ${style.bold(sanitize(title || "Confirm"))}\n  ${sanitize(message)}`,
    );
    return yes(await this.prompter.ask(`  ${style.dim("[y] yes  [n] no")} ${style.bold(">")} `));
  }

  /** One of a list, by number or name; undefined when nothing was chosen. */
  async pick(
    placeholder: string,
    items: readonly { id: string; label: string; description?: string }[],
  ): Promise<string | undefined> {
    const { style } = this;
    if (!items.length) return undefined;
    const lines = ["", `${style.yellow("?")} ${style.bold(sanitize(placeholder || "Choose"))}`];
    items.slice(0, 40).forEach((item, n) => {
      lines.push(
        `  ${style.bold(String(n + 1))}. ${sanitize(item.label)}${item.description ? style.dim(` - ${clip(sanitize(item.description), 80, style.unicode)}`) : ""}`,
      );
    });
    if (items.length > 40) lines.push(style.dim(`  … ${items.length - 40} more: type a name`));
    this.say(lines.join("\n"));
    const typed = (
      (await this.prompter.ask(
        `  ${style.dim("a number or a name; Enter cancels")} ${style.bold(">")} `,
      )) ?? ""
    ).trim();
    if (!typed) return undefined;
    if (/^\d+$/.test(typed)) return items[Number(typed) - 1]?.id;
    const lower = typed.toLowerCase();
    return (
      items.find((i) => i.id.toLowerCase() === lower || i.label.toLowerCase() === lower) ??
      items.find((i) => i.label.toLowerCase().includes(lower))
    )?.id;
  }

  /** A line of text (`secret`: not shown as typed); undefined when cancelled. */
  async text(
    prompt: string,
    options: { secret?: boolean; value?: string } = {},
  ): Promise<string | undefined> {
    const { style } = this;
    this.say(
      `\n${style.yellow("?")} ${style.bold(sanitize(prompt))}${options.value ? style.dim(` (Enter: ${options.value})`) : ""}`,
    );
    const typed = await this.prompter.ask(`  ${style.bold(">")} `, {
      ...(options.secret && { secret: true }),
    });
    if (typed === null) return undefined;
    return typed === "" && options.value !== undefined ? options.value : typed;
  }

  /**
   * Asks each host prompt that waits (ide://agent/hostPrompts) as it appears and answers it with
   * `agent.answerHostPrompt`. Returns what stops it.
   */
  watchHostPrompts(brain: Brain): { dispose(): void } {
    const asked = new Set<string>();
    return effect(() => {
      for (const entry of brain.prompts.pending.value) {
        if (asked.has(entry.id)) continue;
        asked.add(entry.id);
        void this.hostPrompt(brain, entry).catch(() => {});
      }
      return undefined;
    });
  }

  private async hostPrompt(
    brain: Brain,
    entry: Brain["prompts"]["pending"]["value"][number],
  ): Promise<void> {
    const answer = (input: Record<string, unknown>) =>
      brain.execute("agent.answerHostPrompt", { id: entry.id, ...input }).catch(() => {});
    const from = "server" in entry.prompt && entry.prompt.server ? `${entry.prompt.server}: ` : "";
    switch (entry.kind) {
      case "text": {
        for (;;) {
          const typed = await this.text(`${from}${entry.prompt.prompt}`, {
            ...(entry.prompt.password && { secret: true }),
            ...(entry.prompt.value !== undefined &&
              !entry.prompt.password && { value: entry.prompt.value }),
          });
          if (typed === undefined || typed === "") {
            await answer({ dismiss: true });
            return;
          }
          const problem = entry.prompt.validate?.(typed);
          if (!problem) {
            await answer({ text: typed });
            return;
          }
          this.say(this.style.red(`  ${problem}`));
        }
      }
      case "choice": {
        const id = await this.pick(`${from}${entry.prompt.placeholder}`, entry.prompt.choices);
        await answer(id ? { choice: id } : { dismiss: true });
        return;
      }
      case "review": {
        this.say(
          `\n${this.style.yellow("?")} ${this.style.bold(sanitize(`${from}${entry.prompt.title}`))}\n  ${sanitize(entry.prompt.message)}\n${this.style.dim(sanitize(entry.prompt.text))}`,
        );
        const ok = yes(
          await this.prompter.ask(
            `  ${this.style.dim("[y] send it  [n] reject")} ${this.style.bold(">")} `,
          ),
        );
        await answer(ok ? { text: entry.prompt.text } : { reject: true });
        return;
      }
      case "confirm": {
        const ok = await this.confirm(entry.prompt.message, entry.prompt.title);
        await answer({ confirm: ok });
        return;
      }
    }
  }

  /** The services' own questions (a destructive command's confirmation, pickers, text boxes). */
  servicePolicy(): HeadlessPolicy {
    return {
      confirm: (message, title) => this.confirm(message, title),
      quickInput: {
        pick: ({ placeholder, items }) => this.pick(placeholder, items),
        prompt: (options) =>
          this.text(options.prompt, {
            // A key or a password is never shown as typed, whether or not the asker said so.
            ...((options.password || /api key|password|token|secret/i.test(options.prompt)) && {
              secret: true,
            }),
            ...(options.value !== undefined && { value: options.value }),
          }),
      },
    };
  }
}
