// VS Code's Comments API on the worker side (`comments.createCommentController`) (D248): comment threads
// on ranges of files, shown in the editor (a mark in the gutter, the thread on hover and a line
// above it) and answered from there. VS Code takes replies through commands the extension puts in
// its `comments/commentThread/context` menu; here a controller's `replyHandler` gets them (and new
// threads the user starts on a line its `commentingRangeProvider` allows). A thread's changes go
// to the host once per turn. DOM-free, unit-tested.
import type { Disposable, TextRange } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

export interface CommentAuthor {
  name: string;
}

export interface Comment {
  /** Markdown (a string, or VS Code's MarkdownString `{ value }`). */
  body: string | { value: string };
  author: CommentAuthor;
  /** A short tag after the author ("Pending", "Edited"). */
  label?: string;
  timestamp?: Date | number;
  contextValue?: string;
  /** VS Code's CommentReaction (D255): an emoji or short label, how many, whether you're one. */
  reactions?: { label: string; count?: number; authorHasReacted?: boolean }[];
}

/** VS Code's CommentThreadCollapsibleState: Collapsed = 0, Expanded = 1 (or the names). */
export type CollapsibleState = "collapsed" | "expanded" | 0 | 1;

export interface CommentThread extends Disposable {
  readonly id: string;
  readonly path: string;
  range: TextRange;
  comments: readonly Comment[];
  collapsibleState: CollapsibleState;
  label?: string;
  /** Default true (when the controller has a replyHandler). */
  canReply: boolean;
  contextValue?: string;
  /** VS Code's CommentThreadState: Unresolved = 0, Resolved = 1 (or the names). */
  state?: "resolved" | "unresolved" | 0 | 1;
}

export interface CommentReply {
  thread: CommentThread;
  /** What the user wrote. */
  text: string;
}

export interface CommentingRangeProvider {
  provideCommentingRanges(document: {
    path: string;
    languageId: string;
  }): TextRange[] | null | undefined | Promise<TextRange[] | null | undefined>;
}

export interface CommentController extends Disposable {
  readonly id: string;
  readonly label: string;
  /** Where the user may start a thread ("Add comment" on that line). */
  commentingRangeProvider?: CommentingRangeProvider;
  /** A reply to a thread, or the first comment of a thread the user started. */
  replyHandler?: (reply: CommentReply) => unknown;
  /**
   * The user picked one of a comment's reactions (VS Code's reactionHandler, D255): add or take
   * back theirs, then update `comment.reactions`.
   */
  reactionHandler?: (
    comment: Comment,
    reaction: { label: string; count?: number; authorHasReacted?: boolean },
  ) => unknown;
  /**
   * The user edited a comment in place (D255; VS Code does it with a comment's `mode` and its
   * menu's commands): change `comment.body` and the thread's comments.
   */
  editHandler?: (edit: { thread: CommentThread; comment: Comment; text: string }) => unknown;
  createCommentThread(path: string, range: TextRange, comments: readonly Comment[]): CommentThread;
}

export interface CommentsApi {
  createCommentController(id: string, label: string): CommentController;
}

/** What the host gets for a thread. */
export interface ThreadData {
  id: string;
  path: string;
  range: TextRange;
  comments: {
    body: string;
    author: string;
    label?: string;
    timestamp?: number;
    reactions?: { label: string; count: number; mine: boolean }[];
  }[];
  collapsed: boolean;
  /** The controller takes reactions and edits (D255). */
  reacts?: boolean;
  edits?: boolean;
  label?: string;
  canReply: boolean;
  state?: "resolved" | "unresolved";
}

const MAX_THREADS = 1000;
const MAX_COMMENTS = 200;

function toThreadData(
  t: CommentThread,
  controllerReplies: boolean,
  handlers: { reacts: boolean; edits: boolean } = { reacts: false, edits: false },
): ThreadData {
  const state =
    t.state === 1 || t.state === "resolved"
      ? "resolved"
      : t.state === 0 || t.state === "unresolved"
        ? "unresolved"
        : undefined;
  return {
    id: t.id,
    path: t.path,
    range: t.range,
    comments: t.comments.slice(0, MAX_COMMENTS).map((c) => {
      const ts = c.timestamp instanceof Date ? c.timestamp.getTime() : c.timestamp;
      return {
        body: String(typeof c.body === "string" ? c.body : (c.body?.value ?? "")).slice(0, 20_000),
        author: String(c.author?.name ?? "").slice(0, 200),
        ...(typeof c.label === "string" && { label: c.label.slice(0, 100) }),
        ...(typeof ts === "number" && Number.isFinite(ts) && { timestamp: ts }),
        ...(Array.isArray(c.reactions) &&
          c.reactions.length && {
            reactions: c.reactions.slice(0, 20).map((r) => ({
              label: String(r?.label ?? "").slice(0, 40),
              count: Math.max(0, Math.floor(Number(r?.count) || 0)),
              mine: r?.authorHasReacted === true,
            })),
          }),
      };
    }),
    collapsed: !(t.collapsibleState === 1 || t.collapsibleState === "expanded"),
    ...(typeof t.label === "string" && { label: t.label.slice(0, 200) }),
    canReply: controllerReplies && t.canReply !== false,
    ...(state && { state }),
    ...(handlers.reacts && { reacts: true }),
    ...(handlers.edits && { edits: true }),
  };
}

export function createCommentsApi(request: Request, on: OnCall): CommentsApi {
  return {
    createCommentController(id, label) {
      const controllerId = String(id);
      const threads = new Map<string, CommentThread>();
      let threadSeq = 0;
      let scheduled = false;
      let disposed = false;
      let replyHandler: CommentController["replyHandler"];
      let reactionHandler: CommentController["reactionHandler"];
      let editHandler: CommentController["editHandler"];
      let rangeProvider: CommentingRangeProvider | undefined;
      const flush = () => {
        scheduled = false;
        if (disposed) return;
        void request("comments.set", {
          controller: controllerId,
          label: String(label),
          commenting: !!rangeProvider && typeof replyHandler === "function",
          threads: [...threads.values()].slice(0, MAX_THREADS).map((t) =>
            toThreadData(t, typeof replyHandler === "function", {
              reacts: typeof reactionHandler === "function",
              edits: typeof editHandler === "function",
            }),
          ),
        }).catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)));
      };
      const changed = () => {
        if (scheduled || disposed) return;
        scheduled = true;
        queueMicrotask(flush);
      };

      const createThread = (
        path: string,
        range: TextRange,
        comments: readonly Comment[],
      ): CommentThread => {
        const threadId = `t${++threadSeq}`;
        const fields: Omit<CommentThread, "dispose" | "id" | "path"> = {
          range: { ...range },
          comments: [...comments],
          collapsibleState: "collapsed",
          canReply: true,
        };
        const thread = {} as CommentThread;
        for (const key of [
          "range",
          "comments",
          "collapsibleState",
          "label",
          "canReply",
          "contextValue",
          "state",
        ] as const)
          Object.defineProperty(thread, key, {
            enumerable: true,
            get: () => fields[key],
            set: (v: never) => {
              fields[key] = v;
              changed();
            },
          });
        Object.defineProperty(thread, "id", { value: threadId, enumerable: true });
        Object.defineProperty(thread, "path", { value: String(path), enumerable: true });
        thread.dispose = () => {
          if (threads.delete(threadId)) changed();
        };
        threads.set(threadId, thread);
        changed();
        return thread;
      };

      /** A thread's comment by its place (the host names comments by index). */
      const commentAt = (args: { thread?: unknown; comment?: unknown }) => {
        const thread = threads.get(String(args?.thread ?? ""));
        if (!thread) throw new Error("That comment thread is gone.");
        const comment = thread.comments[Math.floor(Number(args?.comment))];
        if (!comment) throw new Error("That comment is gone.");
        return { thread, comment };
      };
      const offs = [
        on(
          `comments.${controllerId}.react`,
          async (args: { thread?: unknown; comment?: unknown; reaction?: unknown }) => {
            if (typeof reactionHandler !== "function") throw new Error("No reactions here.");
            const { comment } = commentAt(args);
            const label = String(args?.reaction ?? "");
            const reaction = comment.reactions?.find((r) => r.label === label) ?? { label };
            await reactionHandler(comment, reaction);
            changed();
            return null;
          },
        ),
        on(
          `comments.${controllerId}.edit`,
          async (args: { thread?: unknown; comment?: unknown; text?: unknown }) => {
            if (typeof editHandler !== "function") throw new Error("Comments aren't edited here.");
            const { thread, comment } = commentAt(args);
            await editHandler({ thread, comment, text: String(args?.text ?? "") });
            changed();
            return null;
          },
        ),
        on(`comments.${controllerId}.reply`, async (args: { thread?: unknown; text?: unknown }) => {
          const thread = threads.get(String(args?.thread ?? ""));
          if (!thread) throw new Error("That comment thread is gone.");
          if (typeof replyHandler !== "function") throw new Error("This thread takes no replies.");
          await replyHandler({ thread, text: String(args?.text ?? "") });
          return null;
        }),
        on(
          `comments.${controllerId}.ranges`,
          async (args: { path?: unknown; languageId?: unknown }) => {
            if (!rangeProvider) return [];
            const ranges = await rangeProvider.provideCommentingRanges({
              path: String(args?.path ?? ""),
              languageId: String(args?.languageId ?? ""),
            });
            return Array.isArray(ranges) ? ranges : [];
          },
        ),
        on(
          `comments.${controllerId}.create`,
          async (args: { path?: unknown; line?: unknown; text?: unknown }) => {
            if (typeof replyHandler !== "function")
              throw new Error("New threads aren't taken here.");
            const line = Math.max(1, Math.floor(Number(args?.line) || 1));
            const thread = createThread(String(args?.path ?? ""), { startLine: line }, []);
            thread.collapsibleState = "expanded";
            try {
              await replyHandler({ thread, text: String(args?.text ?? "") });
            } catch (err) {
              thread.dispose();
              throw err;
            }
            return { thread: thread.id };
          },
        ),
      ];

      const controller: CommentController = {
        id: controllerId,
        label: String(label),
        get commentingRangeProvider() {
          return rangeProvider;
        },
        set commentingRangeProvider(p) {
          rangeProvider = p;
          changed();
        },
        get replyHandler() {
          return replyHandler;
        },
        set replyHandler(h) {
          replyHandler = h;
          changed();
        },
        get reactionHandler() {
          return reactionHandler;
        },
        set reactionHandler(h) {
          reactionHandler = h;
          changed();
        },
        get editHandler() {
          return editHandler;
        },
        set editHandler(h) {
          editHandler = h;
          changed();
        },
        createCommentThread: (path, range, comments) => createThread(path, range, comments),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          for (const off of offs) off();
          threads.clear();
          void request("comments.dispose", { controller: controllerId }).catch(() => {});
        },
      };
      // Registered at once: the host knows the controller even before its first thread.
      changed();
      return controller;
    },
  };
}
