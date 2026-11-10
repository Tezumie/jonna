// A group chat's composer parts (D231): the members pill (their faces; a click lists them to
// mention, and edits who's in the chat) and the @-mention list that opens when "@" is typed, in
// every chat (D389): the agents matching what follows the "@", then files, @problems, @git and the
// other context mentions, web addresses and symbols (agent.mentionItems, loaded as you type),
// picked with ↑/↓ and Enter or Tab (the caret stays in the box), and "Browse files and context…"
// for the full picker. The matching of agents is core/agent/groupChat.ts.

import { everyoneWords, matchMembers, mentionQuery } from "../../../core/agent/groupChat";
import { DM_PREFIX } from "../../../core/agent/rooms";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { agentFace } from "../../../ui/AgentFace";
import { icon, knownIcon } from "../../../ui/Icon";
import { showMenu } from "../../../ui/Menu";
import { setTooltip } from "../../../ui/Tooltip";
import {
  groupFaces,
  knownAgents,
  memberInfo,
  memberNames,
  membersOf,
  soloSpeaker,
} from "../groupChat";
import type { AgentSession } from "../session";

export const GROUP_PLACEHOLDER = "Message the group, @ to call on an agent";

/** One thing "@" can add (agent.mentionItems' rows). */
export interface MentionItem {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface MemberMentionsHost {
  session: AgentSession;
  input: HTMLTextAreaElement;
  /** Files, context mentions and symbols for what follows the "@" (D389). */
  items(query: string): Promise<readonly MentionItem[]>;
  /** Where the list opens (above the box). */
  anchor: HTMLElement;
  /** The ordinary @ picker (files, problems, terminal…). */
  mention(): void;
  run(command: string, input?: unknown): void;
  /** The text changed (the composer resizes). */
  changed(): void;
}

export class MemberMentions implements Disposable {
  /** The members pill for the composer's footer (hidden outside group chats). */
  readonly pill: HTMLButtonElement;
  private readonly store = new DisposableStore();
  private readonly list = h("div", {
    class: "agent-suggest-list agent-member-list",
    role: "listbox",
    "aria-label": "Mention an agent",
    hidden: true,
  });
  private start = -1;
  /** The mention Esc closed the list on (it stays closed while that "@" is being typed). */
  private dismissed = -1;
  private active = 0;
  private rows: { run(): void; el: HTMLElement }[] = [];
  /** Files and context per query, as they came back (D389); a pending one is a promise. */
  private readonly items = new Map<string, readonly MentionItem[] | Promise<void>>();

  constructor(private readonly host: MemberMentionsHost) {
    const { session, input } = host;
    this.pill = h("button", {
      class: "agent-pill agent-members-pill",
      type: "button",
      hidden: true,
    }) as HTMLButtonElement;
    host.anchor.append(this.list);
    this.store.add(
      effect(() => {
        const names = session.members.value;
        this.pill.hidden = names.length === 0;
        if (!names.length) {
          this.close();
          return undefined;
        }
        this.pill.replaceChildren(groupFaces(names, 16), h("span", null, `${names.length} agents`));
        setTooltip(this.pill, `In this chat: ${memberNames(names)}`);
        return undefined;
      }),
    );
    this.store.add(on(this.pill, "click", () => this.membersMenu()));
    // Typing after "@" narrows the list; leaving the mention closes it.
    this.store.add(on(input, "input", () => this.refresh()));
    // Closed a moment after the box loses focus (a click on a row keeps it: mousedown).
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    this.store.add(
      on(input, "blur", () => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => this.close(), 120);
      }),
    );
    this.store.add({ dispose: () => clearTimeout(blurTimer) });
    this.store.add(on(input, "click", () => this.refresh()));
    // In the capture phase: the composer's own Enter (send) and ↑ (last message) come after.
    this.store.add(
      on(
        input,
        "keydown",
        (e) => {
          if (this.list.hidden) return;
          const key = (e as KeyboardEvent).key;
          if (key === "ArrowDown" || key === "ArrowUp") {
            this.move(key === "ArrowDown" ? 1 : -1);
          } else if ((key === "Enter" || key === "Tab") && !(e as KeyboardEvent).isComposing) {
            this.rows[this.active]?.run();
          } else if (key === "Escape") {
            this.dismissed = this.start;
            this.close();
          } else return;
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        { capture: true },
      ),
    );
  }

  /** "@" was typed at `at` in a group chat: the list opens there (the "@" stays). */
  open(at: number): void {
    if (this.dismissed === at) this.dismissed = -1;
    this.start = -1;
    this.refresh();
  }

  /**
   * Who "@" can call on: in a group chat its members, then the other agents (mentioning one
   * brings it in); in a chat with one agent, every other agent (D233: the mention makes it a
   * group chat).
   */
  private candidates(): { name: string; label: string; role?: string; joins: boolean }[] {
    const session = this.host.session;
    const members = session.members.peek();
    const inChat = members.length ? members : [soloSpeaker(session.chatMode.peek())];
    const own = members.length ? membersOf(session).map((m) => ({ ...m, joins: false })) : [];
    const others = knownAgents()
      .filter((a) => !inChat.includes(a.name))
      .map((a) => ({ name: a.name, label: a.label, ...(a.role && { role: a.role }), joins: true }));
    return [...own, ...others];
  }

  /** Whether "@" lists agents here (any besides the one the chat is with). */
  hasAgents(): boolean {
    return this.candidates().length > 0;
  }

  /** The list for the `@query` at the caret (typed, pasted or come back to), or closed. */
  private refresh(): void {
    const candidates = this.candidates();
    const group = this.host.session.members.peek().length > 0;
    const { input } = this.host;
    const q = mentionQuery(input.value, input.selectionStart ?? 0);
    if (!q || q.start === this.dismissed) {
      this.close();
      return;
    }
    const members = matchMembers(q.query, candidates);
    const found = this.itemsFor(q.query);
    // Past the name (nothing matches what follows the "@" any more): not a mention being typed.
    // "@Forge " (a name and a space): done, unless a longer name goes on ("@Test " → Test runner).
    const spaced = /\s$/.test(q.query);
    const typing = q.query.toLowerCase();
    // @channel in a channel, @everyone in another group chat (D273, D274); the others work too.
    const room = this.host.session.room;
    const inChannel = !!room && !room.startsWith(DM_PREFIX);
    const everyone =
      group && !spaced ? everyoneWords(inChannel).find((w) => w.startsWith(typing)) : undefined;
    if (
      (q.query && !members.length && !everyone && found !== null && !found.length) ||
      (spaced && !members.some((m) => m.label.toLowerCase().startsWith(typing)))
    ) {
      this.close();
      return;
    }
    if (q.start !== this.start) {
      this.start = q.start;
      this.active = 0;
    }
    const pick = (label: string) => {
      const caret = input.selectionStart ?? input.value.length;
      const text = `@${label} `;
      input.value = input.value.slice(0, this.start) + text + input.value.slice(caret);
      const at = this.start + text.length;
      input.setSelectionRange(at, at);
      this.close();
      this.host.changed();
      input.focus();
    };
    const agentRows = members.map((m) => ({
      el: h(
        "div",
        { class: "agent-suggest-row agent-member-row", role: "option", "data-member": m.name },
        agentFace(memberInfo(m.name).face, { size: 18 }),
        h("span", { class: "agent-member-name" }, m.label),
        m.role ? h("span", { class: "agent-member-role" }, m.role) : null,
        candidates.find((c) => c.name === m.name)?.joins
          ? h("span", { class: "agent-member-joins" }, "joins the chat")
          : null,
      ),
      run: () => pick(m.label),
    }));
    // Files, @problems, @git… and symbols (D389): the "@" and what followed it give way to the
    // mention's card (agent.mention asks what it needs: a commit, a chat, an address).
    const itemRows = (found ?? []).slice(0, 30).map((item) => ({
      el: h(
        "div",
        { class: "agent-suggest-row agent-member-row", role: "option", "data-mention": item.id },
        icon(knownIcon(item.icon ?? "file")),
        h("span", { class: "agent-member-name" }, item.label),
        item.description && item.description !== item.label
          ? h("span", { class: "agent-member-role" }, item.description)
          : null,
      ),
      run: () => {
        const caret = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, this.start) + input.value.slice(caret);
        input.setSelectionRange(this.start, this.start);
        this.close();
        this.host.changed();
        this.host.run("agent.mention", { mention: item.id, session: this.host.session.id });
      },
    }));
    const filesRow = {
      el: h(
        "div",
        { class: "agent-suggest-row agent-member-row is-other", role: "option" },
        icon("at-sign"),
        h("span", { class: "agent-member-name" }, "Browse files and context…"),
      ),
      run: () => {
        // The "@" and what followed it give way to the ordinary picker's choice.
        const caret = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, this.start) + input.value.slice(caret);
        input.setSelectionRange(this.start, this.start);
        this.close();
        this.host.changed();
        this.host.mention();
      },
    };
    // @channel (D245, D273): in a group chat, every member answers at once.
    const allRows = everyone
      ? [
          {
            el: h(
              "div",
              {
                class: "agent-suggest-row agent-member-row is-other",
                role: "option",
                "data-member": everyone,
              },
              icon("users"),
              h("span", { class: "agent-member-name" }, everyone),
              h("span", { class: "agent-member-role" }, "Everyone answers at once"),
            ),
            run: () => pick(everyone),
          },
        ]
      : [];
    // In a chat with one agent "@" was the files picker: it stays first there (Enter keeps
    // doing what it did); in a group chat, the members come first.
    // In a group chat the members come first; elsewhere what "@" always offered (files and
    // context) does, with the other agents after it.
    this.rows = group
      ? [...agentRows, ...allRows, ...itemRows, filesRow]
      : [...itemRows, ...agentRows, filesRow];
    this.active = Math.min(this.active, this.rows.length - 1);
    this.list.replaceChildren(...this.rows.map((r) => r.el));
    this.rows.forEach((r, i) => {
      r.el.addEventListener("mousedown", (e) => {
        // Keeps the caret in the box.
        e.preventDefault();
        r.run();
      });
      r.el.addEventListener("mousemove", () => {
        if (this.active !== i) {
          this.active = i;
          this.paint();
        }
      });
    });
    this.list.hidden = false;
    this.paint();
  }

  /**
   * What "@query" offers besides agents: the rows when they're in, else null while they load (the
   * list redraws when they come back, if that "@" is still being typed).
   */
  private itemsFor(query: string): readonly MentionItem[] | null {
    const key = query.trim();
    const known = this.items.get(key);
    if (known && !(known instanceof Promise)) return known;
    if (!known)
      this.items.set(
        key,
        this.host
          .items(key)
          .catch(() => [] as readonly MentionItem[])
          .then((rows) => {
            this.items.set(key, rows);
            const q = mentionQuery(this.host.input.value, this.host.input.selectionStart ?? 0);
            if (q && q.query.trim() === key && this.start >= 0) this.refresh();
          }),
      );
    return null;
  }

  private move(delta: number): void {
    if (!this.rows.length) return;
    this.active = (this.active + delta + this.rows.length) % this.rows.length;
    this.paint();
    // The list scrolls past a dozen rows: ↑/↓ keep the chosen one in view (as the / list does).
    this.rows[this.active]?.el.scrollIntoView({ block: "nearest" });
  }

  private paint(): void {
    this.rows.forEach((r, i) => {
      r.el.classList.toggle("is-active", i === this.active);
      r.el.setAttribute("aria-selected", String(i === this.active));
    });
  }

  private close(): void {
    this.items.clear();
    this.start = -1;
    this.list.hidden = true;
    this.list.replaceChildren();
    this.rows = [];
  }

  /** The pill's menu: each member (a click mentions it), then who's in the chat. */
  private membersMenu(): void {
    const { session, input } = this.host;
    showMenu(
      this.pill,
      [
        ...session.members.peek().map((name) => {
          const m = memberInfo(name);
          return {
            label: m.role ? `${m.label} · ${m.role}` : m.label,
            iconElement: () => agentFace(m.face, { size: 16 }),
            run: () => {
              const caret = input.selectionStart ?? input.value.length;
              const before = input.value.slice(0, caret);
              const text = `${before && !/\s$/.test(before) ? " " : ""}@${m.label} `;
              input.value = before + text + input.value.slice(caret);
              input.setSelectionRange(caret + text.length, caret + text.length);
              this.host.changed();
              input.focus();
            },
          };
        }),
        {
          label: "Agents in this chat…",
          icon: "users",
          separatorBefore: true,
          run: () => this.host.run("agent.setGroupMembers", { session: session.id }),
        },
      ],
      "Agents in this chat",
    );
  }

  dispose(): void {
    this.close();
    this.list.remove();
    this.store.dispose();
  }
}
