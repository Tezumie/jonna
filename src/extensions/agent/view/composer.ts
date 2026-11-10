// The composer (DESIGN.md §13.7, D131): attachment cards, then a compact message box (grows with
// the text) with the send button inside it, then a row of controls under it — + (attach), the
// review/auto-apply mode, reasoning and the model. Enter sends, Shift+Enter is
// a newline, ↑ in an empty box brings back the last message. Files dropped from the system,
// pasted images and files, and big pastes become cards.

import type { AcpSetting } from "../../../core/acp/client";
import { isBigPaste, MAX_UPLOADS, textUpload } from "../../../core/agent/attachments";
import { customModeId, EFFORT_VALUES, effortLabel } from "../../../core/agent/chatModes";
import { contextMentionCard } from "../../../core/agent/mentions";
import { budgetState, formatCost } from "../../../core/agent/prices";
import { splitSubmitWord } from "../../../core/agent/voice";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect, untracked } from "../../../core/reactive/index";
import { agentFace } from "../../../ui/AgentFace";
import { type IconName, icon } from "../../../ui/Icon";
import { type MenuItem, showMenu } from "../../../ui/Menu";
import { setTooltip } from "../../../ui/Tooltip";
import { cachedSettings } from "../acp";
import { extraMentionCard } from "../composerExtras";
import { customModes } from "../customModes";
import { memberInfo } from "../groupChat";
import { mainAgent } from "../mainAgent";
import type { AgentSession } from "../session";
import { addUploads, uploadsFromFiles } from "../uploads";
import { attachmentCard, openableCards } from "./attachCards";
import { GROUP_PLACEHOLDER, MemberMentions, type MentionItem } from "./memberMentions";
import { type SlashItem, SlashList } from "./slashList";
import { type Recording, VoiceRecorder } from "./voice";

const MENTION_LABELS: Record<string, [string, IconName]> = {
  "@problems": ["Problems", "circle-alert"],
  "@terminal": ["Terminal output", "square-terminal"],
  "@selection": ["Selection", "code"],
};

export interface ComposerHost {
  session: AgentSession;
  send(text: string): void;
  stop(): void;
  showModelMenu(anchor: HTMLElement): void;
  showModeMenu(anchor: HTMLElement): void;
  /** A group chat's effort pill: each agent's effort (D273). */
  showMembersEffort(anchor: HTMLElement): void;
  autoRunCommands(): boolean;
  /** Full access: nothing asks (agent.runCommands "full", D163); reactive. */
  fullAccess(): boolean;
  modelLabel(): string;
  /** The current model's provider or agent logo (reactive), or null. */
  modelMark(): HTMLElement | null;
  /** "@" typed: pick a file, problems, terminal output or the selection. */
  mention(): void;
  /** "/" typed in an empty box: pick a command (/compact, the folder's own commands). */
  slash(): void;
  /** Runs an IDE command (the + menu, reasoning settings). */
  run(command: string, input?: unknown): void;
  /** A command's result (the inline / and @ lists ask for theirs, D389). */
  query(command: string, input?: unknown): Promise<unknown>;
  /** A setting's value (reactive read). */
  setting(key: string): unknown;
  /** A problem to show (a file that couldn't be attached). */
  warn(message: string): void;
  /** Speech to text for voice input (D180); rejects with a readable error. */
  transcribe(recording: Recording): Promise<string>;
  /**
   * Whether a recording can start (D384): false when dictation isn't set up (the host has shown
   * the setup) or its model is still downloading.
   */
  prepareVoice(): Promise<boolean>;
  /** The chat's external agent when its program isn't installed (reactive), else null. */
  missingAgent(): {
    name: string;
    program: string;
    install: string;
    failed?: boolean;
    signIn?: string;
  } | null;
}

export class Composer implements Disposable {
  readonly element: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private readonly store = new DisposableStore();
  /** A group chat's members pill and @-mention list (D231). */
  private readonly members: MemberMentions;

  constructor(private readonly host: ComposerHost) {
    const { session } = host;
    this.input = h("textarea", {
      class: "agent-input",
      rows: 1,
      placeholder: "Ask anything, @ for context",
      "aria-label": "Message the agent",
      spellcheck: "true",
    });
    const model = h("button", { class: "agent-pill agent-model-pill", type: "button" });
    const mode = h("button", { class: "agent-pill agent-access", type: "button" });
    // Agent / Plan / Ask (D180, Cursor's modes): what the agent may do with this message.
    const chatMode = h("button", { class: "agent-pill agent-chat-mode", type: "button" });
    const reasoning = h("button", { class: "agent-pill agent-reasoning", type: "button" });
    const send = h("button", { class: "agent-send", type: "button" }) as HTMLButtonElement;
    this.sendButton = send;
    // Dictation has its own button, always at the end; Send shows to its left once there's
    // something to send, so typing and speaking mix (D384; D180 had one button for both).
    const mic = h("button", { class: "agent-mic", type: "button" }) as HTMLButtonElement;
    this.micButton = mic;
    const plus = h(
      "button",
      { class: "agent-plus", type: "button", "aria-label": "Add context" },
      icon("plus"),
    );
    setTooltip(plus, "Attach files, add project files or context");
    // What the chat has cost (D199) shows only near or over its budget (D291: the Usage page has
    // the costs and how full the context is).
    const cost = h("span", { class: "agent-cost is-high", hidden: true });
    this.store.add(
      effect(() => {
        const c = session.cost.value;
        const budget = session.chatBudget();
        cost.hidden = c === null || budget <= 0 || budgetState(c, budget) === "ok";
        if (cost.hidden || c === null) return undefined;
        cost.textContent = formatCost(c);
        setTooltip(
          cost,
          `This chat has cost about ${formatCost(c)} of its ${formatCost(budget)} budget (agent.budget.perChat).`,
        );
        return undefined;
      }),
    );
    // Attachments as cards above the box: uploads (files, images, big pastes) and project files /
    // @-mentions (paths).
    const cards = h("div", { class: "agent-attachments", hidden: true });
    this.store.add(
      effect(() => {
        const paths = session.attachments.value;
        const uploads = session.uploads.value;
        cards.hidden = paths.length === 0 && uploads.length === 0;
        cards.replaceChildren(
          // Click one to look at it (the viewer pages through the others, D158).
          ...openableCards(
            uploads.map((u) => ({
              kind: u.kind,
              name: u.name,
              ...(u.kind === "image" ? { image: u.data } : { preview: u.data, text: u.data }),
              ...(u.lines && { lines: u.lines }),
              ...(u.pasted && { pasted: true }),
            })),
            (i) => (session.uploads.value = session.uploads.peek().filter((x) => x !== uploads[i])),
            undefined,
            (i) => {
              const u = uploads[i];
              if (u) host.run("agent.addAttachmentToProject", { id: u.id, session: session.id });
            },
          ),
          ...paths.map((p) => {
            const removeIt = () =>
              (session.attachments.value = session.attachments.peek().filter((x) => x !== p));
            const web = p.startsWith("@web ") ? p.slice(5) : null;
            const other = contextMentionCard(p);
            // MCP resources and web searches (D200) name themselves.
            const special: [string, IconName] | undefined =
              extraMentionCard(p) ??
              (web
                ? [web.replace(/^https?:\/\//, "").replace(/\/$/, ""), "globe"]
                : other
                  ? [other.label, other.icon]
                  : MENTION_LABELS[p]);
            // A project file opens in the editor.
            return attachmentCard(
              special
                ? { kind: "mention", name: special[0], icon: special[1] }
                : { kind: "file", name: p },
              removeIt,
              special ? undefined : () => host.run("editor.openFile", { path: p }),
            );
          }),
        );
        return undefined;
      }),
    );
    // Voice input (D180): while recording, a waveform bar takes the text's place.
    this.voiceTime = h("span", { class: "agent-voice-time" }, "0:00");
    this.voiceStatus = h("span", { class: "agent-voice-status" });
    const voiceCancel = h(
      "button",
      { class: "icon-button agent-voice-cancel", type: "button", "aria-label": "Cancel recording" },
      icon("x"),
    );
    setTooltip(voiceCancel, "Cancel (Esc)");
    this.store.add(on(voiceCancel, "click", () => this.cancelVoice()));
    this.voiceBar = h(
      "div",
      { class: "agent-voice", hidden: true },
      voiceCancel,
      this.voiceSlot,
      this.voiceStatus,
      this.voiceTime,
    );
    const box = h("div", { class: "agent-box" }, this.input, this.voiceBar, send, mic);
    this.box = box;
    // An external agent that isn't installed (D190): said here, with the button that installs
    // it, before a message fails (VS Code's "Download the … agent" card).
    const missing = h("div", { class: "agent-missing", hidden: true });
    this.store.add(
      effect(() => {
        const m = host.missingAgent();
        missing.hidden = !m;
        if (!m) return undefined;
        if (m.signIn) {
          // Installed, not signed in: its own sign-in in a terminal, then try again (D192).
          const signIn = h(
            "button",
            { class: "button button-accent button-sm", type: "button" },
            "Sign in",
          );
          signIn.addEventListener("click", () => host.run("agent.signInAgent", { name: m.name }));
          missing.replaceChildren(
            h(
              "div",
              { class: "agent-missing-text" },
              h("strong", null, `Sign in to ${m.name}`),
              h(
                "span",
                null,
                `${m.name} uses its own account. Sign in runs `,
                h("code", null, m.signIn),
                " in a terminal; follow it there (a browser page opens), then press Retry here.",
              ),
            ),
            signIn,
          );
          return undefined;
        }
        const install = h(
          "button",
          { class: "button button-accent button-sm", type: "button" },
          m.failed ? "Update" : "Install",
        );
        install.addEventListener("click", () => {
          host.run("agent.installAgent", { name: m.name });
          // Looked for again while it installs: the card goes once the program is there.
          for (const ms of [15_000, 45_000, 90_000, 180_000]) {
            const timer = setTimeout(() => host.run("agent.detectTools", {}), ms);
            this.store.add({ dispose: () => clearTimeout(timer) });
          }
        });
        missing.replaceChildren(
          h(
            "div",
            { class: "agent-missing-text" },
            h("strong", null, `${m.failed ? "Update" : "Install"} ${m.name}`),
            h(
              "span",
              null,
              m.failed
                ? `The ${m.program} program didn't start as an agent (an older version?). This runs `
                : `It runs the ${m.program} program, which isn't on this computer yet. Install runs `,
              h("code", null, m.install),
              " in a terminal, then its sign-in.",
            ),
          ),
          install,
        );
        return undefined;
      }),
    );
    this.members = this.store.add(
      new MemberMentions({
        session,
        input: this.input,
        anchor: box,
        mention: () => host.mention(),
        run: (command, input) => host.run(command, input),
        items: async (query) => {
          const r = (await host.query("agent.mentionItems", { query })) as {
            items?: MentionItem[];
          } | null;
          return r?.items ?? [];
        },
        changed: () => {
          this.autosize();
          this.syncSend();
        },
      }),
    );
    // "/" at the start: the commands over the box, filtered as you type (D389).
    this.store.add(
      new SlashList({
        input: this.input,
        anchor: box,
        commands: async () => {
          const r = (await host.query("agent.slash", { session: session.id, pick: false })) as {
            commands?: SlashItem[];
          } | null;
          return r?.commands ?? [];
        },
        changed: () => {
          this.autosize();
          this.syncSend();
        },
        submit: () => this.submit(),
      }),
    );
    this.element = h(
      "div",
      { class: "agent-composer" },
      missing,
      cards,
      box,
      h(
        "div",
        { class: "agent-composer-footer" },
        plus,
        chatMode,
        this.members.pill,
        h("span", { class: "diff-spacer" }),
        cost,
        // Model, then its effort, then what the agent may do on its own (D227).
        model,
        reasoning,
        mode,
      ),
    );
    this.store.add(
      on(box, "mousedown", (e) => {
        // A click on the box's padding puts the caret in the text.
        if (e.target === box) {
          e.preventDefault();
          this.input.focus();
        }
      }),
    );
    this.store.add(on(plus, "click", () => this.plusMenu(plus)));
    this.store.add(
      on(reasoning, "click", () =>
        // A group chat: each agent has its own effort, like its model (D273).
        this.host.session.members.peek().length
          ? this.host.showMembersEffort(reasoning)
          : this.reasoningMenu(reasoning),
      ),
    );
    this.store.add(
      effect(() => {
        // An external agent's own reasoning level (Codex's, Claude Code's), when it has one.
        const level = this.agentLevel();
        if (level) {
          const now = level.options.find((o) => o.id === level.current);
          reasoning.hidden = false;
          reasoning.replaceChildren(h("span", null, now?.name ?? "Default"));
          reasoning.classList.remove("is-on");
          setTooltip(reasoning, `Reasoning: ${now?.name ?? "the agent's default"}`);
          return undefined;
        }
        if (session.members.value.length) {
          reasoning.hidden = false;
          reasoning.replaceChildren(h("span", null, "Effort"));
          reasoning.classList.remove("is-on");
          setTooltip(reasoning, "Each agent's reasoning effort");
          return undefined;
        }
        reasoning.hidden = session.model.value?.startsWith("acp/") === true;
        const thinking = String(host.setting("agent.thinking") ?? "auto");
        const effort = String(host.setting("agent.effort") ?? "default");
        const label =
          thinking === "off"
            ? "No thinking"
            : effort !== "default"
              ? effortLabel(effort)
              : thinking === "on"
                ? "Thinking"
                : "Default";
        reasoning.replaceChildren(h("span", null, label));
        reasoning.classList.toggle(
          "is-on",
          thinking !== "off" && (thinking === "on" || effort !== "default"),
        );
        setTooltip(
          reasoning,
          `Reasoning: ${thinking === "auto" ? "when the model supports it" : thinking}${effort !== "default" ? ` · effort ${effort}` : ""}`,
        );
        return undefined;
      }),
    );
    this.store.add(on(model, "click", () => host.showModelMenu(model)));
    this.store.add(on(mode, "click", () => host.showModeMenu(mode)));
    this.store.add(on(chatMode, "click", () => this.chatModeMenu(chatMode)));
    this.store.add(
      effect(() => {
        // Who answers and how (D249): the agent's face and name, then Plan or Ask when on.
        const current = session.chatMode.value;
        session.workMode.value;
        const agent = agentModes().find((x) => x.mode === current);
        const work = CHAT_MODES.find((x) => x.mode === session.work()) ?? CHAT_MODES[0];
        if (!work) return undefined;
        // The agent (D286); "· Plan" or "· Ask" only when it works other than its own way (the
        // main agent planning itself, an agent switched by a command).
        const main = mainAgent.value;
        if (agent)
          chatMode.replaceChildren(
            agentFace(memberInfo(agent.name).face, { size: 14 }),
            h(
              "span",
              null,
              work.mode === agent.works ? agent.label : `${agent.label} · ${work.label}`,
            ),
          );
        else
          chatMode.replaceChildren(
            agentFace(main.face, { size: 14 }),
            h("span", null, work.mode === "agent" ? main.label : `${main.label} · ${work.label}`),
          );
        chatMode.dataset.mode = current;
        chatMode.dataset.work = work.mode;
        setTooltip(
          chatMode,
          agent
            ? `${agent.label} (${agent.short}): ${work.detail}. Shift+Tab: the next agent`
            : `${main.label}: ${work.detail}. Shift+Tab: the next agent`,
        );
        // A group chat (D231): each agent answers in its own mode, so there's no mode to pick.
        const group = session.members.value.length > 0;
        chatMode.hidden = group;
        this.input.placeholder = group
          ? GROUP_PLACEHOLDER
          : agent && work.mode === "agent"
            ? agent.placeholder
            : work.placeholder;
        return undefined;
      }),
    );
    this.store.add(
      on(send, "click", () => {
        // Working: with text in the box the button sends it into the work (D151), else stops.
        if (send.dataset.mode === "stop") host.stop();
        else this.submit();
      }),
    );
    this.store.add(
      on(mic, "click", () => {
        if (this.voice === "recording") void this.finishVoice();
        else if (this.voice === "idle") void this.startVoice();
      }),
    );
    // Attaching or removing a file can make Send appear or go.
    this.store.add(
      effect(() => {
        session.uploads.value;
        session.attachments.value;
        this.syncSend();
        return undefined;
      }),
    );
    this.store.add(
      on(this.input, "input", (e) => {
        this.autosize();
        this.syncSend();
        // "@" at the start of a word opens the mention picker (the "@" itself isn't kept).
        const at = this.input.selectionStart - 1;
        if (
          (e as InputEvent).data === "@" &&
          (at === 0 || /\s/.test(this.input.value[at - 1] ?? ""))
        ) {
          // "@": the list over the box (D389): files, context and symbols as you type, and the
          // agents a group chat (D231) or any chat (D233) can call on.
          this.members.open(at);
        }
        // "/" as the first character: the inline list (SlashList) opens on its own (D389).
      }),
    );
    // Pasting an image (a screenshot) or files: cards. A big text paste becomes a "Pasted" card
    // instead of filling the box.
    this.store.add(
      on(this.input, "paste", (e) => {
        const data = (e as ClipboardEvent).clipboardData;
        const files = [...(data?.files ?? [])];
        if (files.length) {
          e.preventDefault();
          void this.addFiles(files);
          return;
        }
        const text = data?.getData("text/plain") ?? "";
        if (text && isBigPaste(text)) {
          e.preventDefault();
          if (session.uploads.peek().length >= MAX_UPLOADS)
            host.warn(`At most ${MAX_UPLOADS} attachments per message.`);
          else
            session.uploads.value = [
              ...session.uploads.peek(),
              textUpload("Pasted text", text, true),
            ];
        }
      }),
    );
    // A picked slash command arrives as a draft.
    this.store.add(
      effect(() => {
        const draft = session.draft.value;
        if (draft === null) return undefined;
        // A message coming back (a send that didn't start, queued ones after Stop) doesn't wipe
        // what's being typed: it goes in front of it.
        const typed = this.input.value.trim();
        this.input.value = !typed || typed === "/" ? draft : `${draft}\n\n${this.input.value}`;
        this.autosize();
        // Setting the value fires no input event: Send would stay hidden beside the text.
        // Untracked: what it reads mustn't run this again while the draft is still set.
        untracked(() => this.syncSend());
        this.input.focus();
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        queueMicrotask(() => (session.draft.value = null));
        return undefined;
      }),
    );
    this.store.add(
      on(this.input, "keydown", (e) => {
        // agent.submitWithCtrlEnter (D179): Ctrl/Cmd+Enter sends and Enter is a new line.
        const ctrlSends = host.setting("agent.submitWithCtrlEnter") === true;
        const sends = ctrlSends
          ? e.key === "Enter" && (e.ctrlKey || e.metaKey)
          : e.key === "Enter" && !e.shiftKey;
        if (this.voice !== "idle") {
          // Recording: Enter finishes, Esc throws it away.
          if (e.key === "Enter" && this.voice === "recording") void this.finishVoice();
          else if (e.key === "Escape") this.cancelVoice();
          if (e.key === "Enter" || e.key === "Escape") e.stopPropagation();
          // The hidden text box doesn't take typing meanwhile (Tab still moves focus).
          if (e.key !== "Tab") e.preventDefault();
          return;
        }
        if (sends && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          this.submit();
        } else if (e.key === "ArrowUp" && !this.input.value) {
          const last = [...session.items].reverse().find((i) => i.type === "user" && !i.auto);
          if (last?.type === "user") {
            e.preventDefault();
            this.input.value = last.text;
            this.autosize();
            this.syncSend();
          }
        } else if (
          e.key === "Tab" &&
          e.shiftKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !session.members.peek().length
        ) {
          // Shift+Tab steps through the main agent, your planner and your chat partner (D286:
          // Claude Code's Agent → Plan → Ask, as agents).
          e.preventDefault();
          const steps = cycleSteps();
          const chat = session.chatMode.peek();
          const agentNow = chat.startsWith("custom:") ? chat.slice("custom:".length) : "agent";
          const at = steps.findIndex((x) => x.agent === agentNow && x.work === session.work());
          const next = steps[(at + 1) % steps.length];
          if (next) {
            if (next.agent !== agentNow)
              host.run("agent.setChatAgent", { session: session.id, agent: next.agent });
            if (next.agent === "agent")
              host.run("agent.setChatMode", { session: session.id, mode: next.work });
          }
        } else if (e.key === "Escape" && session.status.peek() !== "idle") {
          e.preventDefault();
          host.stop();
        }
      }),
    );
    this.store.add(
      effect(() => {
        const status = session.status.value;
        session.model.value;
        this.busy = status !== "idle";
        this.syncSend();
        // The logo says which provider or agent; the label is the model alone ("Codex · gpt-5"
        // shows as the Codex logo and "gpt-5").
        const label = host.modelLabel();
        const mark = host.modelMark();
        const agent = session.model.value?.startsWith("acp/") ? session.model.value.slice(4) : "";
        const short =
          mark && agent && label.startsWith(`${agent} · `) ? label.slice(agent.length + 3) : label;
        model.replaceChildren(...(mark ? [mark] : []), h("span", null, short));
        setTooltip(model, `Model: ${label}`);
        const autoRun = host.autoRunCommands();
        const full = host.fullAccess();
        const apply = session.autoApply.value;
        // "Auto" is what other tools call never asking (D227); applying edits is "Accept edits".
        // Auto with Review edits picked after it says so (D273: an "Auto" that asked). A group
        // chat lists each agent's (D273), as it does their models.
        mode.replaceChildren(
          h(
            "span",
            null,
            session.members.value.length
              ? "Access"
              : full
                ? apply
                  ? "Auto"
                  : "Auto, review edits"
                : apply
                  ? "Accept edits"
                  : "Review",
          ),
        );
        mode.classList.toggle("is-autorun", autoRun);
        setTooltip(
          mode,
          full
            ? `Auto (full access): nothing asks — commands, IDE and browser actions, tools · ${session.autoApply.value ? "edits apply at once (checkpointed)" : "edits wait for your review"}`
            : `${session.autoApply.value ? "Edits apply at once (checkpointed)" : "Edits wait for your review"} · ${autoRun ? "commands run without asking (risky ones still ask)" : "commands ask first"}`,
        );
        return undefined;
      }),
    );
  }

  /** The composer's open menu (one at a time; closed with the composer). */
  private menu: { dispose(): void } | null = null;
  private openMenu(menu: { dispose(): void }): void {
    this.menu?.dispose();
    this.menu = menu;
  }

  private busy = false;
  private sendButton: HTMLButtonElement | null = null;
  private micButton: HTMLButtonElement | null = null;

  /**
   * Send: Stop while working with an empty box, Send otherwise (a message joins the work, D151).
   * With dictation on it shows only when there's something to send (or to stop); the mic stays
   * at the end either way (D384).
   */
  private syncSend(): void {
    const send = this.sendButton;
    const mic = this.micButton;
    if (!send || !mic) return;
    const text = !!this.input.value.trim();
    const { session } = this.host;
    const attached = session.uploads.peek().length + session.attachments.peek().length > 0;
    // An external (ACP) agent can't take messages mid-turn: Stop stays (D160).
    const stop = this.busy && (!text || !session.canQueue() || this.voice !== "idle");
    const voiceOn = this.host.setting("agent.voice.enabled") !== false;
    const key = stop ? "stop" : this.busy ? "queue" : "send";
    // While you speak, only Stop shows beside the mic: what's typed waits for the words.
    send.hidden = voiceOn && !stop && (this.voice !== "idle" || (!text && !attached));
    if (send.dataset.mode !== key) {
      send.dataset.mode = key;
      send.replaceChildren(icon(key === "stop" ? "square" : "corner-down-left"));
      send.classList.toggle("is-busy", stop);
      const label: Record<string, string> = {
        stop: "Stop (Esc)",
        queue: session.joinsTurn()
          ? "Send now: the agent reads it at its next step"
          : "Send: it goes as soon as the agent finishes what it's doing",
        send: "Send (Enter)",
      };
      send.setAttribute("aria-label", label[key] ?? "Send");
      setTooltip(send, label[key] ?? "Send");
    }
    const micKey =
      this.voice === "recording" ? "done" : this.voice === "transcribing" ? "wait" : "mic";
    mic.hidden = !voiceOn;
    if (mic.dataset.mode === micKey) return;
    mic.dataset.mode = micKey;
    mic.replaceChildren(
      icon(micKey === "done" ? "check" : micKey === "wait" ? "circle-dashed" : "mic"),
    );
    mic.classList.toggle("is-recording", micKey === "done");
    mic.disabled = micKey === "wait";
    const micLabel: Record<string, string> = {
      mic: "Dictate: speak, and the words are added to your message",
      done: "Done: turn the recording into text (Enter)",
      wait: "Turning speech into text…",
    };
    mic.setAttribute("aria-label", micLabel[micKey] ?? "Dictate");
    setTooltip(mic, micLabel[micKey] ?? "Dictate");
  }

  private submit(): void {
    const text = this.input.value.trim();
    const { session } = this.host;
    const attached = session.uploads.peek().length + session.attachments.peek().length > 0;
    if (!text && !attached) return;
    // While the agent works, a message is queued for its next step (agent.send decides).
    this.input.value = "";
    this.autosize();
    this.syncSend();
    this.host.send(text);
  }

  private autosize(): void {
    this.input.style.height = "auto";
    const max = 22 * 12 + 6;
    const full = this.input.scrollHeight;
    this.input.style.height = `${Math.min(full, max)}px`;
    // No scrollbar until the box stops growing.
    this.input.style.overflowY = full > max ? "auto" : "hidden";
  }

  /** Files pasted or dropped by the webview itself (images, text): cards. */
  async addFiles(files: readonly File[]): Promise<void> {
    const { uploads, problems } = await uploadsFromFiles(files);
    problems.push(...addUploads(this.host.session, uploads));
    if (problems.length) this.host.warn(problems.slice(0, 3).join(" "));
  }

  /**
   * Who answers (D286, as VS Code's agent picker): the main agent and yours, each checked when
   * it's the chat's, its own way of working beside it. Then Mode (D292): Agent, Plan or Ask for
   * whichever agent is answering, so the pill's "Jonna · Ask" is always one of the menu's checks.
   */
  private chatModeMenu(anchor: HTMLElement): void {
    const { session } = this.host;
    const current = session.chatMode.peek();
    const work = session.work();
    const main = mainAgent.peek();
    const agents = agentModes();
    const setAgent = (agent: string) =>
      this.host.run("agent.setChatAgent", { session: session.id, agent });
    const setWork = (mode: string) =>
      this.host.run("agent.setChatMode", { session: session.id, mode });
    const onMain = !current.startsWith("custom:");
    const workLabel = CHAT_MODES.find((m) => m.mode === work)?.label ?? "Agent";
    showMenu(
      anchor,
      [
        {
          label: main.label,
          iconElement: () => agentFace(main.face, { size: 16 }),
          keybinding: "Agent",
          checked: onMain,
          run: () => (onMain ? undefined : setAgent("agent")),
        },
        ...agents.map((a) => ({
          label: a.label,
          iconElement: () => agentFace(memberInfo(a.name).face, { size: 16 }),
          keybinding: a.short,
          checked: a.mode === current,
          run: () => setAgent(a.name),
        })),
        {
          label: "Mode",
          icon: "sliders-horizontal",
          keybinding: workLabel,
          separatorBefore: true,
          submenu: CHAT_MODES.map((m) => ({
            label: m.label,
            icon: m.icon,
            keybinding: m.short,
            checked: m.mode === work,
            run: () => setWork(m.mode),
          })),
        },
        {
          label: "New agent…",
          icon: "plus",
          separatorBefore: true,
          run: () => this.host.run("agent.newAgent", {}),
        },
        {
          label: "Agents…",
          icon: "bot",
          run: () => this.host.run("agent.showAgentConfig", {}),
        },
      ],
      "Agent",
    );
  }

  private plusMenu(anchor: HTMLElement): void {
    const { host } = this;
    const id = host.session.id;
    const items: MenuItem[] = [
      {
        label: "Upload from computer…",
        icon: "file-up",
        run: () => host.run("agent.attachFiles", { session: id }),
      },
      {
        label: "Add project file…",
        icon: "file",
        run: () => host.run("agent.mention", { session: id }),
      },
      {
        label: "Problems",
        icon: "circle-alert",
        separatorBefore: true,
        run: () => host.run("agent.mention", { session: id, mention: "@problems" }),
      },
      {
        label: "Terminal output",
        icon: "square-terminal",
        run: () => host.run("agent.mention", { session: id, mention: "@terminal" }),
      },
      {
        label: "Editor selection",
        icon: "code",
        run: () => host.run("agent.mention", { session: id, mention: "@selection" }),
      },
      {
        label: "Web page…",
        icon: "globe",
        run: () => host.run("agent.mention", { session: id, mention: "@web" }),
      },
      // D200: git, a past chat, the rules, a symbol.
      {
        label: "Git",
        icon: "git-branch",
        separatorBefore: true,
        submenu: [
          {
            label: "Uncommitted changes",
            icon: "git-compare",
            run: () => host.run("agent.mention", { session: id, mention: "@git" }),
          },
          {
            label: "A commit…",
            icon: "history",
            run: () => host.run("agent.mention", { session: id, mention: "@commit" }),
          },
          {
            label: "This branch's changes",
            icon: "git-branch",
            run: () => host.run("agent.mention", { session: id, mention: "@branch" }),
          },
        ],
      },
      {
        label: "Past chat…",
        icon: "scroll-text",
        run: () => host.run("agent.mention", { session: id, mention: "@chat" }),
      },
      {
        label: "Symbol…",
        icon: "braces",
        run: () => host.run("agent.mention", { session: id, mention: "@symbol" }),
      },
      {
        label: "Rules",
        icon: "book-open",
        run: () => host.run("agent.mention", { session: id, mention: "@rules" }),
      },
    ];
    this.openMenu(showMenu(anchor, items, "Add context"));
  }

  /** The chat's external agent's reasoning setting (live, else from its last start), or null. */
  private agentLevel(): AcpSetting | null {
    const { session } = this.host;
    const key = session.model.value;
    if (!key?.startsWith("acp/")) return null;
    const name = key.slice(4);
    const live = session.agentSettings.value;
    const settings = live?.agent === name ? live.settings : cachedSettings(name);
    const level = settings?.find((s) => s.category === "thought_level");
    if (!level || live?.agent === name) return level ?? null;
    const remembered = this.host.setting("agent.externalAgentChoices") as
      | Record<string, Record<string, string>>
      | undefined;
    return { ...level, current: remembered?.[name]?.thought_level ?? level.current };
  }

  private reasoningMenu(anchor: HTMLElement): void {
    const { host } = this;
    const level = this.agentLevel();
    if (level) {
      const items: MenuItem[] = level.options.map((o) => ({
        label: o.name,
        checked: o.id === level.current,
        run: () =>
          host.run("agent.setAgentModel", {
            setting: "thought_level",
            value: o.id,
            session: host.session.id,
          }),
      }));
      this.openMenu(showMenu(anchor, items, "Reasoning"));
      return;
    }
    const thinking = String(host.setting("agent.thinking") ?? "auto");
    const effort = String(host.setting("agent.effort") ?? "default");
    const set = (key: string, value: string) => () => host.run("settings.set", { key, value });
    const items: MenuItem[] = [
      {
        label: "Think when the model can",
        checked: thinking === "auto",
        run: set("agent.thinking", "auto"),
      },
      { label: "Always think", checked: thinking === "on", run: set("agent.thinking", "on") },
      { label: "Don't think", checked: thinking === "off", run: set("agent.thinking", "off") },
      {
        label: "Effort",
        separatorBefore: true,
        submenu: EFFORT_VALUES.map((e) => ({
          label: effortLabel(e),
          checked: effort === e,
          run: set("agent.effort", e),
        })),
      },
      {
        label: "Agent settings…",
        icon: "settings",
        separatorBefore: true,
        run: () => host.run("settings.open", { category: "Agent" }),
      },
    ];
    this.openMenu(showMenu(anchor, items, "Reasoning"));
  }

  focus(): void {
    this.input.focus();
  }

  // ---- Voice input (D180) ---------------------------------------------------------------------

  private voice: "idle" | "recording" | "transcribing" = "idle";
  private recorder: VoiceRecorder | null = null;
  private readonly voiceSlot = h("div", { class: "agent-voice-slot" });
  private voiceBar!: HTMLElement;
  private voiceTime!: HTMLElement;
  private voiceStatus!: HTMLElement;
  private box!: HTMLElement;

  private setVoice(state: "idle" | "recording" | "transcribing"): void {
    this.voice = state;
    this.voiceBar.hidden = state === "idle";
    this.box.classList.toggle("is-voice", state !== "idle");
    this.voiceStatus.textContent = state === "transcribing" ? "Turning it into text…" : "";
    this.syncSend();
  }

  /** Bumped by every start and cancel: an await that comes back to a newer one does nothing. */
  private voiceGeneration = 0;

  private async startVoice(): Promise<void> {
    if (this.voice !== "idle") return;
    // Nothing to turn speech into text: set it up before you talk, not after.
    const generation = ++this.voiceGeneration;
    const ready = await this.host.prepareVoice().catch(() => false);
    if (!ready || generation !== this.voiceGeneration || this.store.isDisposed) return;
    const recorder = new VoiceRecorder(
      (seconds) => {
        const s = Math.floor(seconds);
        this.voiceTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      },
      () => void this.finishVoice(),
    );
    this.recorder = recorder;
    this.voiceSlot.replaceChildren(recorder.canvas);
    this.voiceTime.textContent = "0:00";
    this.setVoice("recording");
    try {
      await recorder.start();
      if (generation !== this.voiceGeneration) {
        recorder.dispose();
        return;
      }
      this.input.focus();
    } catch (err) {
      recorder.dispose();
      if (generation !== this.voiceGeneration) return;
      this.recorder = null;
      this.setVoice("idle");
      this.host.warn(err instanceof Error ? err.message : String(err));
    }
  }

  /** Throws the recording (or the text it's turning into) away. */
  private cancelVoice(): void {
    this.voiceGeneration++;
    this.recorder?.dispose();
    this.recorder = null;
    this.setVoice("idle");
    this.input.focus();
  }

  private async finishVoice(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || this.voice !== "recording") return;
    const generation = this.voiceGeneration;
    this.setVoice("transcribing");
    const recording = await recorder.stop();
    recorder.dispose();
    if (this.store.isDisposed || generation !== this.voiceGeneration) return;
    this.recorder = null;
    if (!recording || recording.seconds < 0.4) {
      this.setVoice("idle");
      return;
    }
    let text = "";
    try {
      text = await this.host.transcribe(recording);
    } catch (err) {
      if (generation === this.voiceGeneration)
        this.host.warn(err instanceof Error ? err.message : String(err));
    }
    // Cancelled (Esc, ×) while it was turning into text: the text is dropped.
    if (this.store.isDisposed || generation !== this.voiceGeneration) return;
    this.setVoice("idle");
    if (!text.trim()) return;
    // "…, submit": the spoken submit word sends the message (agent.voice.submitWords).
    const words = this.host.setting("agent.voice.submitWords");
    const { text: spoken, submit } = splitSubmitWord(
      text,
      Array.isArray(words) ? words.filter((w): w is string => typeof w === "string") : [],
    );
    const before = this.input.value;
    this.input.value = before.trim() ? `${before.replace(/\s+$/, "")} ${spoken}` : spoken;
    this.autosize();
    this.input.focus();
    this.syncSend();
    if (submit) this.submit();
  }

  dispose(): void {
    this.recorder?.dispose();
    this.menu?.dispose();
    this.store.dispose();
  }
}

/**
 * The agents a chat can be with (D230, D249): the user's agents, and the modes from
 * .github/chatmodes and agent.customModes, which VS Code now calls custom agents. Reactive.
 */
function agentModes(): {
  mode: string;
  name: string;
  label: string;
  short: string;
  placeholder: string;
  /** How it works (its file's `mode:`): Agent unless it plans or answers. */
  works: "agent" | "plan" | "ask";
}[] {
  return customModes.value.map((c) => ({
    mode: customModeId(c.name),
    name: c.name,
    label: c.agent?.label ?? c.name,
    short: c.agent?.role || "Custom",
    placeholder: `Message ${c.agent?.label ?? c.name}, @ for context`,
    works: c.startMode ?? "agent",
  }));
}

/**
 * Shift+Tab's steps (D286), Claude Code's Agent → Plan → Ask as agents: the main agent, your
 * planner, your agent that answers. Without such an agent the main agent plans or answers itself.
 */
function cycleSteps(): { agent: string; work: "agent" | "plan" | "ask" }[] {
  const agents = agentModes();
  // The team's own first (Plato, Gabby), so Explore and Review, which answer too, aren't picked.
  const planner =
    agents.find((a) => a.name === "planner" && a.works === "plan") ??
    agents.find((a) => a.works === "plan");
  const asker =
    agents.find((a) => a.name === "chat" && a.works === "ask") ??
    agents.find((a) => a.works === "ask");
  return [
    { agent: "agent", work: "agent" },
    planner ? { agent: planner.name, work: "plan" } : { agent: "agent", work: "plan" },
    asker ? { agent: asker.name, work: "ask" } : { agent: "agent", work: "ask" },
  ];
}

/** The composer's modes, in Shift+Tab order (D180). */
const CHAT_MODES: readonly {
  mode: string;
  label: string;
  icon: IconName;
  short: string;
  detail: string;
  placeholder: string;
}[] = [
  {
    mode: "agent",
    label: "Agent",
    icon: "agent",
    short: "Does the work",
    detail: "it reads, edits files and runs commands to do the task",
    placeholder: "Ask anything, @ for context",
  },
  {
    mode: "plan",
    label: "Plan",
    icon: "list-tree",
    short: "Plans first",
    detail: "it researches without changing anything and writes a plan; Build carries it out",
    placeholder: "Describe what to plan, @ for context",
  },
  {
    mode: "ask",
    label: "Ask",
    icon: "message-circle-question",
    short: "Read-only",
    detail: "it reads and explains, without changing files or running commands",
    placeholder: "Ask a question, @ for context",
  },
];
