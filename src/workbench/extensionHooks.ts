// More of what extensions plug into the workbench, beside extensionRegistries.ts (D248): the `type`
// command override (an extension takes over the characters typed in the editor, as Vim keymaps
// do) and its cursor style, will-save participants (edits before a save), URI handlers (a link
// to the IDE's scheme for an extension), comment threads in files and chat participants. The
// extensions host fills these; the editor and the commands read them. Every entry has an owner
// (the extension's id): stopping it removes what it added. DOM-free and unit-tested.
import { Emitter } from "../core/events/index";
import type { ProviderQuery } from "../core/extensions/providerQuery";
import { type Disposable, toDisposable } from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import type { TextRange } from "./extensionFeatures";
import type { CodeLensEntry } from "./extensionProviders";
import type { RangeEdit } from "./textEdits";

// ---- The `type` override -----------------------------------------------------------------------

/** The extension that gets what's typed in the editor (one at a time). */
export interface TypeOwner {
  owner: string;
  /** Its display name (the notice, the status). */
  name: string;
  /** Hands it one typed text (a character, or what an input method composed). */
  type(text: string): Promise<void>;
}

/** Monaco's cursor styles (VS Code's TextEditorCursorStyle, by name). */
export const CURSOR_STYLES = [
  "line",
  "block",
  "underline",
  "line-thin",
  "block-outline",
  "underline-thin",
] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];

/** VS Code's numeric TextEditorCursorStyle (1 = Line … 6 = UnderlineThin), or a name. */
export function toCursorStyle(raw: unknown): CursorStyle | null {
  if (typeof raw === "number") return CURSOR_STYLES[raw - 1] ?? null;
  if (typeof raw !== "string") return null;
  const name = raw.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return (CURSOR_STYLES as readonly string[]).includes(name) ? (name as CursorStyle) : null;
}

// ---- Will-save participants --------------------------------------------------------------------

export type SaveReason = "manual" | "afterDelay" | "focusOut";

export interface WillSaveContext {
  path: string;
  /** A text file's language, or a notebook's type. */
  languageId: string;
  reason: SaveReason;
}

export interface WillSaveParticipant {
  owner: string;
  kind: "text" | "notebook";
  /** Edits to the text before it's written (a notebook's participant changes cells itself: []). */
  run(context: WillSaveContext): Promise<RangeEdit[]>;
}

/** VS Code gives each onWillSave listener 1.5 s; a slower one is skipped for this save. */
export const WILL_SAVE_MS = 1500;

// ---- URI handlers --------------------------------------------------------------------------------

/** A link to the IDE (`<scheme>://<publisher.name>/path?query#fragment`), as VS Code's Uri parts. */
export interface IdeUri {
  scheme: string;
  /** The extension's id (lower case). */
  authority: string;
  path: string;
  query: string;
  fragment: string;
  /** The whole link. */
  text: string;
}

/** Parses a link to the IDE's scheme; null for anything else (another scheme, no extension id). */
export function parseIdeUri(text: string, scheme: string): IdeUri | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(
    text.trim(),
  );
  if (!m || m[1]?.toLowerCase() !== scheme.toLowerCase()) return null;
  const authority = (m[2] ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*(\.[a-z0-9][a-z0-9-_]*)+$/.test(authority)) return null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return {
    scheme: scheme.toLowerCase(),
    authority,
    path: decode(m[3] || "/"),
    // The query stays encoded (VS Code's Uri.query): its values are the handler's to split.
    query: m[4] ?? "",
    fragment: decode(m[5] ?? ""),
    text: text.trim(),
  };
}

export interface UriHandlerEntry {
  owner: string;
  handle(uri: IdeUri): Promise<void>;
}

// ---- Comments ------------------------------------------------------------------------------------

export interface CommentEntry {
  /** Markdown. */
  body: string;
  author: string;
  /** A short tag after the author ("Pending", "Edited"). */
  label?: string;
  /** Milliseconds since 1970. */
  timestamp?: number;
  /** Its reactions (D255): label, how many, whether the user is one. */
  reactions?: { label: string; count: number; mine: boolean }[];
}

/** A comment thread on a range of a file (VS Code's CommentThread). */
export interface CommentThreadEntry {
  owner: string;
  /** The controller's id (unique in the extension) and label. */
  controller: string;
  controllerLabel: string;
  /** Unique in the controller. */
  id: string;
  path: string;
  range: TextRange;
  comments: readonly CommentEntry[];
  /** Collapsed: the editor shows that there's a thread; expanded: its latest comment too. */
  collapsed: boolean;
  label?: string;
  /** The controller takes replies (it has a reply handler, and the thread allows them). */
  canReply: boolean;
  state?: "resolved" | "unresolved";
  /** Sends a reply to the extension (when it takes them). */
  reply?(text: string): Promise<void>;
  /** Toggles the user's reaction on comment `index` (when the controller takes reactions, D255). */
  react?(index: number, reaction: string): Promise<void>;
  /** Replaces comment `index`'s text (when the controller takes edits, D255). */
  edit?(index: number, text: string): Promise<void>;
}

/** A controller where the user may start threads (its commentingRangeProvider). */
export interface CommentingController {
  owner: string;
  controller: string;
  label: string;
  /** The ranges of `path` that take comments. */
  ranges(path: string, languageId: string): Promise<TextRange[]>;
  /** Starts a thread on `line` with the user's first comment. */
  create(path: string, line: number, text: string): Promise<void>;
}

/** Whether `line` is in one of `ranges` (no end line: the start line only). */
export function lineInRanges(line: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((r) => line >= r.startLine && line <= (r.endLine ?? r.startLine));
}

/** A thread's key in commands and state: "<extension id>/<controller>/<thread>". */
export function threadKey(t: Pick<CommentThreadEntry, "owner" | "controller" | "id">): string {
  return `${t.owner}/${t.controller}/${t.id}`;
}

/** What a thread's code lens says: its count, or (expanded) its latest comment. */
export function threadSummary(t: CommentThreadEntry): string {
  const n = t.comments.length;
  const count = `${n} comment${n === 1 ? "" : "s"}`;
  const last = t.comments[n - 1];
  if (t.collapsed || !last) return t.label ? `${t.label} (${count})` : count;
  const line = last.body.split("\n").find((l) => l.trim()) ?? "";
  const preview = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return `${last.author}: ${preview}${n > 1 ? ` (${count})` : ""}`;
}

/** The thread as Markdown (its hover). */
export function threadMarkdown(t: CommentThreadEntry): string {
  const head = `**${t.label ?? t.controllerLabel}**${t.state ? ` · ${t.state}` : ""}`;
  return [
    head,
    ...t.comments.map((c) => `**${c.author}**${c.label ? ` (${c.label})` : ""}: ${c.body}`),
  ].join("\n\n");
}

/** A thread's lines above its range: what it says (opens it), and "Reply" when it takes replies. */
export function lensesFor(threads: readonly CommentThreadEntry[], path: string): CodeLensEntry[] {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return threads
    .filter((t) => norm(t.path) === norm(path))
    .flatMap((t) => {
      const range: TextRange = { startLine: t.range.startLine };
      const thread = threadKey(t);
      return [
        {
          range,
          title: threadSummary(t),
          command: { id: "extensions.showCommentThread", input: { thread } },
        },
        ...(t.canReply
          ? [
              {
                range,
                title: "Reply",
                command: { id: "extensions.replyToComment", input: { thread } },
              },
            ]
          : []),
      ];
    });
}

// ---- Chat participants ---------------------------------------------------------------------------

export interface ChatParticipantEntry {
  owner: string;
  /** Its id (starts with the extension's id or prefix). */
  id: string;
  /** What the user types after "@". */
  name: string;
  description?: string;
  /** Asks it; resolves with the Markdown it wrote. */
  request(prompt: string, command?: string): Promise<{ markdown: string }>;
}

/** The conversation as one prompt (the IDE's generate takes a system prompt and one message). */
export function promptOf(messages: readonly { role: string; content: string }[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") return messages[0].content;
  return messages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
}

// ---- The registry --------------------------------------------------------------------------------

export class ExtensionHooks {
  /** Who gets typed characters now (null: the editor types them). */
  readonly typeOwner: Signal<TypeOwner | null> = signal<TypeOwner | null>(null);
  /** An extension's cursor style for every editor (null: the editor.cursorStyle setting). */
  readonly cursorStyle: Signal<{ owner: string; style: CursorStyle } | null> = signal<{
    owner: string;
    style: CursorStyle;
  } | null>(null);
  readonly commentThreads: Signal<readonly CommentThreadEntry[]> = signal<
    readonly CommentThreadEntry[]
  >([]);
  readonly chatParticipants: Signal<readonly ChatParticipantEntry[]> = signal<
    readonly ChatParticipantEntry[]
  >([]);
  readonly commentingControllers: Signal<readonly CommentingController[]> = signal<
    readonly CommentingController[]
  >([]);
  /**
   * Types as the editor would without the override (`default:type`); the editor sets it. Called
   * directly, not through a command: it's the owner's half of a keystroke.
   */
  typeDefault: ((text: string) => Promise<boolean>) | null = null;
  /**
   * Asks every language provider of the editor about a document, merging their answers (VS
   * Code's `vscode.execute…Provider`); the editor sets it. The query is checked by the caller.
   */
  executeProvider: ((query: ProviderQuery) => Promise<unknown>) | null = null;
  private readonly willSave: WillSaveParticipant[] = [];
  private readonly uriHandlers = new Map<string, UriHandlerEntry>();
  private readonly uriWanted = new Emitter<string>();
  private readonly uriAdded = new Emitter<string>();
  /** A link came for an extension without a handler yet: it starts (activation "onUri"). */
  readonly onWillNeedUriHandler = this.uriWanted.event;

  /** Takes over typing; throws when another extension has it. */
  claimTyping(owner: TypeOwner): Disposable {
    const current = this.typeOwner.peek();
    if (current && current.owner !== owner.owner)
      throw new Error(`${current.name} already handles typing in the editor.`);
    this.typeOwner.value = owner;
    return toDisposable(() => {
      if (this.typeOwner.peek() === owner) this.typeOwner.value = null;
    });
  }

  /** The user turned the override off: typing goes to the editor again. */
  releaseTyping(): TypeOwner | null {
    const current = this.typeOwner.peek();
    this.typeOwner.value = null;
    if (current) this.setCursorStyle(current.owner, null);
    return current;
  }

  /** `style` null gives the cursor back to the setting (only its owner's call counts). */
  setCursorStyle(owner: string, style: CursorStyle | null): void {
    const current = this.cursorStyle.peek();
    if (style) this.cursorStyle.value = { owner, style };
    else if (current?.owner === owner) this.cursorStyle.value = null;
  }

  addWillSave(participant: WillSaveParticipant): Disposable {
    this.willSave.push(participant);
    return toDisposable(() => {
      const i = this.willSave.indexOf(participant);
      if (i >= 0) this.willSave.splice(i, 1);
    });
  }

  hasWillSave(kind: WillSaveParticipant["kind"]): boolean {
    return this.willSave.some((p) => p.kind === kind);
  }

  /**
   * Runs the participants of `kind` one after another (each sees the text as the one before left
   * it); each gets `ms`. A slow or failing one adds nothing. `apply` puts one's edits in.
   */
  async runWillSave(
    kind: WillSaveParticipant["kind"],
    context: WillSaveContext,
    apply: (edits: RangeEdit[], owner: string) => void | Promise<void>,
    ms = WILL_SAVE_MS,
  ): Promise<void> {
    for (const p of this.willSave.filter((x) => x.kind === kind)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const edits = await Promise.race([
        p.run(context).catch(() => [] as RangeEdit[]),
        new Promise<RangeEdit[]>((resolve) => {
          timer = setTimeout(() => resolve([]), ms);
        }),
      ]).finally(() => clearTimeout(timer));
      if (edits.length) await Promise.resolve(apply(edits, p.owner)).catch(() => {});
    }
  }

  /** One handler per extension (VS Code's registerUriHandler: a second one throws). */
  registerUriHandler(entry: UriHandlerEntry): Disposable {
    if (this.uriHandlers.has(entry.owner))
      throw new Error("The extension already has a URI handler.");
    this.uriHandlers.set(entry.owner, entry);
    this.uriAdded.fire(entry.owner);
    return toDisposable(() => {
      if (this.uriHandlers.get(entry.owner) === entry) this.uriHandlers.delete(entry.owner);
    });
  }

  uriHandlerOwners(): string[] {
    return [...this.uriHandlers.keys()];
  }

  /**
   * Hands a parsed link to its extension's handler; when there's none yet, asks for it (an
   * extension activating on "onUri" starts) and waits up to `ms`. False: nobody took it.
   */
  async openUri(uri: IdeUri, ms = 10_000): Promise<boolean> {
    let handler = this.uriHandlers.get(uri.authority);
    if (!handler) {
      const added = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          sub.dispose();
          resolve();
        }, ms);
        const sub = this.uriAdded.event((owner) => {
          if (owner !== uri.authority) return;
          clearTimeout(timer);
          sub.dispose();
          resolve();
        });
      });
      this.uriWanted.fire(uri.authority);
      await added;
      handler = this.uriHandlers.get(uri.authority);
    }
    if (!handler) return false;
    await handler.handle(uri);
    return true;
  }

  /** Replaces one controller's threads. */
  setThreads(owner: string, controller: string, threads: readonly CommentThreadEntry[]): void {
    const rest = this.commentThreads
      .peek()
      .filter((t) => !(t.owner === owner && t.controller === controller));
    this.commentThreads.value = [...rest, ...threads];
  }

  /** Every thread of `owner` (or of one of its controllers) goes. */
  clearThreads(owner: string, controller?: string): void {
    const kept = this.commentThreads
      .peek()
      .filter(
        (t) => t.owner !== owner || (controller !== undefined && t.controller !== controller),
      );
    if (kept.length !== this.commentThreads.peek().length) this.commentThreads.value = kept;
  }

  /** Replaces whether one controller takes new threads (null: it doesn't). */
  setCommenting(owner: string, controller: string, entry: CommentingController | null): void {
    const rest = this.commentingControllers
      .peek()
      .filter((c) => !(c.owner === owner && c.controller === controller));
    this.commentingControllers.value = entry ? [...rest, entry] : rest;
  }

  findThread(key: string): CommentThreadEntry | undefined {
    return this.commentThreads.peek().find((t) => threadKey(t) === key);
  }

  addChatParticipant(entry: ChatParticipantEntry): Disposable {
    if (this.chatParticipants.peek().some((p) => p.name.toLowerCase() === entry.name.toLowerCase()))
      throw new Error(`A chat participant named @${entry.name} is already registered.`);
    this.chatParticipants.value = [...this.chatParticipants.peek(), entry];
    return toDisposable(() => {
      this.chatParticipants.value = this.chatParticipants.peek().filter((p) => p !== entry);
    });
  }

  dispose(): void {
    this.uriWanted.dispose();
    this.uriAdded.dispose();
  }
}
