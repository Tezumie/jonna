// The host side of an extension's comment threads (rpcComments.ts, VS Code's Comments API) (D248): the
// threads go into `extensionFeatures.hooks.commentThreads` (and `ide://extensions/hooks`), and show
// in the editor with what the editor already draws for extensions: a mark in the gutter with the
// thread on hover (a decoration type), and a line above the range (code lenses: the thread's
// latest comment or its count, and "Reply"). Replies and new threads go back to the extension's
// controller. "fs.read": the threads are about the folder's files.
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { normalizeDecorationType } from "../../workbench/extensionDecorationTypes";
import {
  type CommentEntry,
  type CommentThreadEntry,
  lensesFor,
  threadMarkdown,
} from "../../workbench/extensionHooks";
import { toTextRange } from "../../workbench/extensionProviders";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

/** Decoration type ids for comment marks: apart from runtimeApi's (one per extension). */
let markSeq = 1_000_000;
const MAX_CONTROLLERS = 20;
const MAX_THREADS = 1000;
/** How long a reply or a new thread may take the extension. */
const REPLY_MS = 30_000;

export interface CommentsHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  need(permission: string, what: string): void;
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
}

export class ExtensionCommentsHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly controllers = new Set<string>();
  /** Files that have its marks now (cleared when their last thread goes). */
  private marked = new Set<string>();
  private readonly markId = ++markSeq;
  private readonly markStyle = normalizeDecorationType({ gutterColor: "muted", isWholeLine: true });
  private lenses: Disposable | null = null;
  private redraw = 0;

  constructor(private readonly deps: CommentsHostDeps) {
    this.store.add(toDisposable(() => this.clearAll()));
  }

  private get hooks() {
    return this.deps.services.extensionFeatures.hooks;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "comments.set":
        this.deps.need("fs.read", "show comments in files");
        this.set(p);
        return Promise.resolve(undefined);
      case "comments.dispose": {
        const controller = String(p.controller ?? "");
        this.controllers.delete(controller);
        this.hooks.clearThreads(this.deps.manifest.id, controller);
        this.hooks.setCommenting(this.deps.manifest.id, controller, null);
        this.scheduleRedraw();
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  private set(p: Record<string, unknown>): void {
    const owner = this.deps.manifest.id;
    const controller = String(p.controller ?? "").slice(0, 100);
    if (!controller) throw new Error("A comment controller needs an id.");
    if (!this.controllers.has(controller) && this.controllers.size >= MAX_CONTROLLERS)
      throw new Error(`At most ${MAX_CONTROLLERS} comment controllers per extension.`);
    this.controllers.add(controller);
    const controllerLabel = String(p.label ?? controller).slice(0, 200);
    const call = (op: string, args: unknown) =>
      this.deps
        .worker()
        .then((w) => w.call("provider", `comments.${controller}.${op}`, args, undefined, REPLY_MS));
    const threads = (Array.isArray(p.threads) ? p.threads : [])
      .slice(0, MAX_THREADS)
      .flatMap((raw): CommentThreadEntry[] => {
        const t = (raw ?? {}) as Record<string, unknown>;
        const range = toTextRange(t.range);
        let path: string;
        try {
          path = this.deps.workspacePath(t.path);
        } catch {
          return [];
        }
        if (!range || typeof t.id !== "string") return [];
        const id = t.id;
        const canReply = t.canReply === true;
        return [
          {
            owner,
            controller,
            controllerLabel,
            id,
            path,
            range,
            comments: (Array.isArray(t.comments) ? t.comments : []).flatMap(toComment),
            collapsed: t.collapsed !== false,
            ...(typeof t.label === "string" && { label: t.label }),
            canReply,
            ...((t.state === "resolved" || t.state === "unresolved") && { state: t.state }),
            ...(canReply && {
              reply: (text: string) => call("reply", { thread: id, text }).then(() => undefined),
            }),
            ...(t.reacts === true && {
              react: (comment: number, reaction: string) =>
                call("react", { thread: id, comment, reaction }).then(() => undefined),
            }),
            ...(t.edits === true && {
              edit: (comment: number, text: string) =>
                call("edit", { thread: id, comment, text }).then(() => undefined),
            }),
          },
        ];
      });
    this.hooks.setThreads(owner, controller, threads);
    this.hooks.setCommenting(
      owner,
      controller,
      p.commenting === true
        ? {
            owner,
            controller,
            label: controllerLabel,
            ranges: async (path, languageId) => {
              const list = await call("ranges", { path, languageId });
              return (Array.isArray(list) ? list : []).flatMap((r) => {
                const range = toTextRange(r);
                return range ? [range] : [];
              });
            },
            create: (path, line, text) =>
              call("create", { path, line, text }).then(() => undefined),
          }
        : null,
    );
    this.scheduleRedraw();
  }

  /** Marks and lenses follow the threads (several changes in a turn are one redraw). */
  private scheduleRedraw(): void {
    if (this.redraw) return;
    this.redraw = window.setTimeout(() => {
      this.redraw = 0;
      if (!this.store.isDisposed) this.draw();
    }, 50);
  }

  private mine(): CommentThreadEntry[] {
    return this.hooks.commentThreads.peek().filter((t) => t.owner === this.deps.manifest.id);
  }

  private draw(): void {
    const features = this.deps.services.extensionFeatures;
    const owner = this.deps.manifest.id;
    // The marks' owner is apart from the extension's own decorations (its clearDecorations()
    // mustn't take them).
    const marks = `${owner}#comments`;
    const threads = this.mine();
    const byPath = new Map<string, CommentThreadEntry[]>();
    for (const t of threads) byPath.set(t.path, [...(byPath.get(t.path) ?? []), t]);
    for (const path of this.marked)
      if (!byPath.has(path))
        features.setDecorations({
          owner: marks,
          key: "comments",
          path,
          style: "custom",
          ranges: [],
        });
    for (const [path, list] of byPath)
      features.setDecorations({
        owner: marks,
        key: "comments",
        path,
        style: "custom",
        custom: { id: this.markId, style: this.markStyle },
        ranges: list.map((t) => ({
          startLine: t.range.startLine,
          ...(t.range.endLine !== undefined && { endLine: t.range.endLine }),
          hover: threadMarkdown(t),
        })),
      });
    this.marked = new Set(byPath.keys());
    // The lines above the threads: a language feature with code lenses, added again so the
    // editor asks for them again.
    this.lenses?.dispose();
    this.lenses = threads.length
      ? features.addLanguageFeature({
          owner,
          languages: ["*"],
          codeLens: async ({ path }) => lensesFor(this.mine(), path),
        })
      : null;
  }

  private clearAll(): void {
    window.clearTimeout(this.redraw);
    this.redraw = 0;
    const owner = this.deps.manifest.id;
    this.hooks.clearThreads(owner);
    for (const controller of this.controllers) this.hooks.setCommenting(owner, controller, null);
    this.controllers.clear();
    this.deps.services.extensionFeatures.clearDecorations(`${owner}#comments`);
    this.marked.clear();
    this.lenses?.dispose();
    this.lenses = null;
  }

  /** The worker died: its threads can't be answered any more. */
  workerGone(): void {
    this.clearAll();
  }

  dispose(): void {
    this.store.dispose();
  }
}

function toComment(raw: unknown): CommentEntry[] {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.body !== "string") return [];
  return [
    {
      body: c.body.slice(0, 20_000),
      author: typeof c.author === "string" && c.author ? c.author.slice(0, 200) : "Unknown",
      ...(typeof c.label === "string" && { label: c.label.slice(0, 100) }),
      ...(typeof c.timestamp === "number" && { timestamp: c.timestamp }),
      ...(Array.isArray(c.reactions) && {
        reactions: c.reactions.slice(0, 20).flatMap((r) => {
          const x = (r ?? {}) as Record<string, unknown>;
          return typeof x.label === "string" && x.label
            ? [
                {
                  label: x.label.slice(0, 40),
                  count: typeof x.count === "number" ? Math.max(0, Math.floor(x.count)) : 0,
                  mine: x.mine === true,
                },
              ]
            : [];
        }),
      }),
    },
  ];
}
