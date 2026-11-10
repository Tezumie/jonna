// The `vscode` shim's `comments` (D257) on the IDE's comment controllers: VS Code's threads and
// comments over the IDE's (a Uri and 0-based Range for its path and 1-based lines), commenting
// ranges for a document, reactions. VS Code takes replies and edits through commands in the
// package's menus ("comments/commentThread/context" for Reply, "comments/comment/context" for an
// edit's Save): the IDE's reply and edit handlers run those commands with VS Code's arguments.
// DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type { ShimCommands } from "./commands";
import { fromRange, pathOf, toRange, uriOf } from "./convert";
import type { Documents } from "./document";
import { type MarkdownString, NONE_TOKEN, type Range, type Uri } from "./types";

type IdeController = ReturnType<WorkerApi["comments"]["createCommentController"]>;
type IdeThread = ReturnType<IdeController["createCommentThread"]>;
type IdeComment = IdeThread["comments"][number];

/** VS Code's CommentThread over the IDE's. */
export interface ShimThread {
  readonly uri: Uri;
  range: Range;
  comments: readonly VsComment[];
  collapsibleState: number;
  canReply: boolean;
  contextValue: string | undefined;
  label: string | undefined;
  state: number | undefined;
  dispose(): void;
}

/** VS Code's Comment (a plain object the extension makes). */
export interface VsComment {
  body: string | MarkdownString;
  mode?: number;
  author: { name: string; iconPath?: unknown };
  contextValue?: string;
  reactions?: { label: string; count?: number; authorHasReacted?: boolean; iconPath?: unknown }[];
  label?: string;
  timestamp?: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The first command the package puts in one of VS Code's comment menus. */
function menuCommand(packageJSON: Record<string, unknown>, menu: string): string | undefined {
  const contributes = isRecord(packageJSON.contributes) ? packageJSON.contributes : {};
  const menus = isRecord(contributes.menus) ? contributes.menus : {};
  const list = Array.isArray(menus[menu]) ? (menus[menu] as unknown[]) : [];
  for (const item of list)
    if (isRecord(item) && typeof item.command === "string") return item.command;
  return undefined;
}

export function createComments(
  ide: WorkerApi,
  docs: Documents,
  commands: ShimCommands,
  packageJSON: Record<string, unknown>,
) {
  const replyCommand = menuCommand(packageJSON, "comments/commentThread/context");
  const saveCommand = menuCommand(packageJSON, "comments/comment/context");

  const createCommentController = (id: string, label: string) => {
    const c = ide.comments.createCommentController(id, label);
    const vsComments = new WeakMap<IdeComment, VsComment>();
    const threads = new WeakMap<IdeThread, ShimThread>();

    const toIde = (v: VsComment): IdeComment => {
      const body = typeof v.body === "string" ? v.body : { value: v.body.value };
      const out: IdeComment = {
        body,
        author: { name: v.author?.name ?? "" },
        ...(v.label && { label: v.label }),
        ...(v.timestamp && { timestamp: v.timestamp }),
        ...(v.reactions && {
          reactions: v.reactions.map((r) => ({
            label: r.label,
            ...(r.count !== undefined && { count: r.count }),
            ...(r.authorHasReacted !== undefined && { authorHasReacted: r.authorHasReacted }),
          })),
        }),
      };
      vsComments.set(out, v);
      return out;
    };
    /** A comment the IDE made (the user's reply) as VS Code's. */
    const toVs = (i: IdeComment): VsComment =>
      vsComments.get(i) ?? {
        body: typeof i.body === "string" ? i.body : i.body.value,
        author: { name: i.author.name },
        ...(i.label && { label: i.label }),
      };

    function threadShim(t: IdeThread): ShimThread {
      const known = threads.get(t);
      if (known) return known;
      const shim = {
        uri: uriOf(t.path) as Uri,
        get range(): Range {
          return toRange(t.range);
        },
        set range(r: Range) {
          t.range = fromRange(r);
        },
        get comments(): readonly VsComment[] {
          return t.comments.map(toVs);
        },
        set comments(list: readonly VsComment[]) {
          t.comments = list.map(toIde);
        },
        get collapsibleState(): number {
          return t.collapsibleState === "expanded" || t.collapsibleState === 1 ? 1 : 0;
        },
        set collapsibleState(v: number) {
          t.collapsibleState = v === 1 ? 1 : 0;
        },
        get canReply(): boolean {
          return t.canReply;
        },
        set canReply(v: boolean) {
          t.canReply = v;
        },
        get contextValue(): string | undefined {
          return t.contextValue;
        },
        set contextValue(v: string | undefined) {
          t.contextValue = v;
        },
        get label(): string | undefined {
          return t.label;
        },
        set label(v: string | undefined) {
          t.label = v;
        },
        get state(): number | undefined {
          return t.state === "resolved" || t.state === 1
            ? 1
            : t.state === undefined
              ? undefined
              : 0;
        },
        set state(v: number | undefined) {
          t.state = v === undefined ? undefined : v === 1 ? 1 : 0;
        },
        dispose: () => t.dispose(),
      };
      threads.set(t, shim);
      return shim;
    }

    if (replyCommand)
      c.replyHandler = ({ thread, text }) =>
        commands.executeCommand(replyCommand, { thread: threadShim(thread), text });
    if (saveCommand)
      c.editHandler = ({ thread, comment, text }) => {
        const vs = toVs(comment);
        vs.body = text;
        vs.mode = 1;
        threadShim(thread);
        return commands.executeCommand(saveCommand, vs);
      };

    let commentingRangeProvider: unknown;
    let reactionHandler: ((comment: VsComment, reaction: unknown) => unknown) | undefined;
    return {
      id,
      label,
      options: undefined as unknown,
      get commentingRangeProvider() {
        return commentingRangeProvider;
      },
      set commentingRangeProvider(p: unknown) {
        commentingRangeProvider = p;
        const provider = p as
          | { provideCommentingRanges(document: unknown, token: unknown): unknown }
          | undefined;
        c.commentingRangeProvider = provider
          ? {
              provideCommentingRanges: async (doc) => {
                const document = await docs.sync(doc.path, doc.languageId);
                if (!document) return null;
                const r = (await provider.provideCommentingRanges(document, NONE_TOKEN)) as
                  | Range[]
                  | { ranges?: Range[] }
                  | undefined;
                const ranges = Array.isArray(r) ? r : (r?.ranges ?? []);
                return ranges.map(fromRange);
              },
            }
          : undefined;
      },
      get reactionHandler() {
        return reactionHandler;
      },
      set reactionHandler(h: ((comment: VsComment, reaction: unknown) => unknown) | undefined) {
        reactionHandler = h;
        c.reactionHandler = h ? (comment, reaction) => h(toVs(comment), reaction) : undefined;
      },
      createCommentThread: (uri: Uri, range: Range, comments: readonly VsComment[]) =>
        threadShim(c.createCommentThread(pathOf(uri), fromRange(range), comments.map(toIde))),
      dispose: () => c.dispose(),
    };
  };

  return { createCommentController };
}
