// Commands and state for what extensions add through runtimeHooks.ts (D248): turning off an extension's
// `type` override, opening a link to the IDE's scheme in an extension's URI handler, comment
// threads (show, reply, start one on a line), asking a chat participant, and
// `ide://extensions/hooks`. OS registration of the scheme (a link clicked in a browser starting
// the IDE) isn't there yet: `extensions.openUri` is how a link reaches its handler.
import type { DisposableStore } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import {
  type CommentThreadEntry,
  lineInRanges,
  parseIdeUri,
  threadKey,
} from "../../workbench/extensionHooks";
import type { WorkbenchServices } from "../../workbench/services";
import { addToSettingList, TYPE_BLOCKED } from "./runtimeHooks";
import { LM_ACCESS } from "./runtimeLm";

export function registerHookCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  register: WorkbenchServices["dispatcher"]["register"],
): void {
  const { hooks } = services.extensionFeatures;
  const { quickInput, state } = services;

  // Add comment in the editor's menu while an extension takes comments (D255, as VS Code's
  // editor menu has it); the extension's commenting ranges decide the line.
  sub.add(
    effect(() => {
      services.context.set(
        "extensionCommentingAvailable",
        hooks.commentingControllers.value.length > 0,
      );
      return undefined;
    }),
  );
  sub.add({ dispose: () => services.context.set("extensionCommentingAvailable", undefined) });
  sub.add(
    services.extensionFeatures.addMenus([
      {
        owner: "builtin.extensions",
        location: "editor/context",
        command: "extensions.addComment",
        title: "Add comment",
        icon: "plus",
        when: "extensionCommentingAvailable",
      },
    ]),
  );

  register({
    id: "extensions.turnOffTypeOverride",
    title: "Stop an extension from handling typing",
    description:
      "Gives typing in the editor back to the editor: the extension that overrides `type` (a Vim keymap) stops getting typed text, and won't again (it's added to extensions.typeOverride.blocked; take it out there to allow it again).",
    input: s.object({
      id: s
        .string()
        .describe("The extension's id (default: the one handling typing now)")
        .optional(),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ id }) => {
      const current = hooks.typeOwner.peek();
      const target = id ?? current?.owner;
      if (!target) return { turnedOff: null };
      if (current?.owner === target) hooks.releaseTyping();
      await addToSettingList(services, TYPE_BLOCKED, target);
      return { turnedOff: target };
    },
  });

  register({
    id: "extensions.openUri",
    title: "Open a link in an extension",
    description: `Hands a link to the IDE (\`${product.urlScheme}://<publisher.name>/path?query\`) to the URI handler of the extension it names (VS Code's registerUriHandler), starting the extension when it activates on "onUri". What the extension then does is up to it.`,
    input: s.object({ uri: s.string().describe(`A ${product.urlScheme}:// link`) }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ uri }) => {
      const parsed = parseIdeUri(uri, product.urlScheme);
      if (!parsed)
        throw new Error(`Not a link for an extension: ${product.urlScheme}://<publisher.name>/…`);
      if (!(await hooks.openUri(parsed)))
        throw new Error(`No extension ${parsed.authority} handles links (or it isn't running).`);
      return { handledBy: parsed.authority };
    },
  });

  const thread = (key: string): CommentThreadEntry => {
    const found = hooks.findThread(key);
    if (!found) throw new Error(`No comment thread ${key} (see ide://extensions/hooks).`);
    return found;
  };
  const reply = async (t: CommentThreadEntry, text: string | undefined) => {
    if (!t.reply) throw new Error("This thread takes no replies.");
    const last = t.comments[t.comments.length - 1];
    const body =
      text ??
      (await quickInput.prompt({
        prompt: last ? `Reply to ${last.author}` : "Reply",
        placeholder: t.label ?? t.controllerLabel,
      }));
    if (!body?.trim()) return { replied: false };
    await t.reply(body);
    return { replied: true };
  };
  const threadInput = s
    .string()
    .describe('A thread\'s key, "<extension>/<controller>/<thread>" (ide://extensions/hooks)');
  /** A comment's reactions as text ("👍 2 · 🎉 1"). */
  const reactionsText = (c: CommentThreadEntry["comments"][number]) =>
    (c.reactions ?? []).map((r) => `${r.label}${r.count ? ` ${r.count}` : ""}`).join(" · ");
  const react = async (t: CommentThreadEntry, index: number, reaction: string | undefined) => {
    if (!t.react) throw new Error("This thread takes no reactions.");
    const c = t.comments[index];
    if (!c) throw new Error(`No comment ${index} in this thread.`);
    const label =
      reaction ??
      (
        await quickInput.pick(
          (c.reactions ?? []).map((r) => ({
            id: r.label,
            label: r.label,
            description: `${r.count}${r.mine ? " · yours" : ""}`,
          })),
          { placeholder: `React to ${c.author}'s comment` },
        )
      )?.id;
    if (!label) return { reacted: false };
    await t.react(index, label);
    return { reacted: true };
  };
  const edit = async (t: CommentThreadEntry, index: number, text: string | undefined) => {
    if (!t.edit) throw new Error("This thread's comments aren't edited here.");
    const c = t.comments[index];
    if (!c) throw new Error(`No comment ${index} in this thread.`);
    const body = text ?? (await quickInput.prompt({ prompt: "Edit comment", value: c.body }));
    if (body === undefined || body === null || !body.trim()) return { edited: false };
    await t.edit(index, body);
    return { edited: true };
  };

  register({
    id: "extensions.showCommentThread",
    title: "Show a comment thread",
    description:
      "Lists an extension's comment thread (its comments, newest last) in the quick pick; choosing Reply… asks for a reply. Returns the comments.",
    input: s.object({ thread: threadInput }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ thread: key }, ctx) => {
      const t = thread(key);
      const comments = t.comments.map((c) => ({
        author: c.author,
        body: c.body,
        ...(c.reactions?.length && { reactions: c.reactions }),
      }));
      if (ctx.caller.kind !== "user") return { thread: key, comments };
      const picked = await quickInput.pick(
        [
          ...t.comments.map((c, i) => ({
            id: `c${i}`,
            label: c.body.split("\n").find((l) => l.trim()) ?? "",
            description: [c.author, c.label, reactionsText(c)].filter(Boolean).join(" · "),
            detail: c.body,
            ...(i === 0 && { separator: t.label ?? t.controllerLabel }),
          })),
          ...(t.reply ? [{ id: "reply", label: "Reply…", icon: "pencil" as const }] : []),
          // D255: a comment's reactions and editing it, when the controller takes them.
          ...(t.react
            ? t.comments.flatMap((c, i) =>
                c.reactions?.length
                  ? [
                      {
                        id: `react${i}`,
                        label: `React to ${c.author}'s comment…`,
                        icon: "star" as const,
                      },
                    ]
                  : [],
              )
            : []),
          ...(t.edit
            ? t.comments.map((c, i) => ({
                id: `edit${i}`,
                label: `Edit ${c.author}'s comment…`,
                icon: "pencil" as const,
              }))
            : []),
        ],
        { placeholder: `${t.comments.length} comment${t.comments.length === 1 ? "" : "s"}` },
      );
      if (picked?.id === "reply") await reply(t, undefined);
      else if (picked?.id.startsWith("react"))
        await react(t, Number(picked.id.slice(5)), undefined);
      else if (picked?.id.startsWith("edit")) await edit(t, Number(picked.id.slice(4)), undefined);
      return { thread: key, comments };
    },
  });

  register({
    id: "extensions.replyToComment",
    title: "Reply to a comment thread",
    description:
      "Sends a reply to an extension's comment thread (VS Code's comment reply); without `text` the user is asked for it.",
    input: s.object({
      thread: threadInput,
      text: s.string().describe("The reply (Markdown)").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: ({ thread: key, text }) => reply(thread(key), text),
  });

  register({
    id: "extensions.reactToComment",
    title: "React to a comment",
    description:
      "Adds or takes back the user's reaction (one of the comment's own, by its label) on comment `comment` (its place, 0 first) of an extension's thread (VS Code's comment reactions); without `reaction` the user picks one.",
    input: s.object({
      thread: threadInput,
      comment: s.integer({ min: 0 }),
      reaction: s.string().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: ({ thread: key, comment, reaction }) => react(thread(key), comment, reaction),
  });

  register({
    id: "extensions.editComment",
    title: "Edit a comment",
    description:
      "Replaces comment `comment` (its place, 0 first) of an extension's thread with `text` (the extension's editHandler takes it); without `text` the user edits it.",
    input: s.object({
      thread: threadInput,
      comment: s.integer({ min: 0 }),
      text: s.string().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: ({ thread: key, comment, text }) => edit(thread(key), comment, text),
  });

  register({
    id: "extensions.addComment",
    title: "Add comment",
    description:
      "Starts a comment thread on a line (default: the active editor's cursor line) with an extension whose comment controller takes comments there; without `text` the user is asked for it.",
    input: s.object({
      path: s.string().describe("The file (default: the active editor's)").optional(),
      line: s.integer({ min: 1 }).describe("1-based (default: the cursor's)").optional(),
      text: s.string().describe("The first comment (Markdown)").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    when: "editorFocus",
    run: async ({ path, line, text }) => {
      const active = state.has("ide://editors/active")
        ? ((await state.get("ide://editors/active")).value as {
            absolutePath?: string | null;
            language?: string;
            cursor?: { line: number };
          } | null)
        : null;
      const file = path ?? active?.absolutePath ?? null;
      const at = line ?? active?.cursor?.line;
      if (!file || !at) throw new Error("Open a file first (or give a path and a line).");
      const language = active?.language ?? "";
      const controllers = [];
      for (const c of hooks.commentingControllers.peek()) {
        const ranges = await c.ranges(file, language).catch(() => []);
        if (lineInRanges(at, ranges)) controllers.push(c);
      }
      if (!controllers.length) throw new Error("No extension takes comments on this line.");
      let controller = controllers[0];
      if (controllers.length > 1) {
        const picked = await quickInput.pick(
          controllers.map((c, i) => ({ id: String(i), label: c.label, description: c.owner })),
          { placeholder: "Comment with" },
        );
        controller = picked ? controllers[Number(picked.id)] : undefined;
      }
      if (!controller) return { added: false };
      const body = text ?? (await quickInput.prompt({ prompt: `Comment on line ${at}` }));
      if (!body?.trim()) return { added: false };
      await controller.create(file, at, body);
      return { added: true };
    },
  });

  register({
    id: "extensions.askChatParticipant",
    title: "Ask an extension's chat participant",
    description:
      "Sends a prompt to an extension's chat participant (\"@name\", VS Code's chat participants) and returns the Markdown it wrote. Its own model calls need extensions.languageModelAccess.",
    input: s.object({
      name: s.string().describe('The participant\'s name, without "@"'),
      prompt: s.string(),
      command: s.string().describe('A slash command, without "/"').optional(),
    }),
    effects: ["network"],
    agent: "hidden",
    palette: false,
    run: async ({ name, prompt, command }) => {
      const wanted = name.replace(/^@/, "").toLowerCase();
      const participant = hooks.chatParticipants
        .peek()
        .find((p) => p.name.toLowerCase() === wanted);
      if (!participant)
        throw new Error(`No chat participant @${wanted} (see ide://extensions/hooks).`);
      return participant.request(prompt, command);
    },
  });

  sub.add(
    state.register("ide://extensions/hooks", {
      description:
        "What extensions hook into: who handles typing (the `type` override) and the cursor style it set, URI handlers (links to the IDE's scheme), comment threads (key, file, line, comments, whether they take replies), controllers that take new comments, chat participants (@name) and whether extensions may use the language model.",
      get: () => ({
        typing: hooks.typeOwner.peek()
          ? { owner: hooks.typeOwner.peek()?.owner, name: hooks.typeOwner.peek()?.name }
          : null,
        cursorStyle: hooks.cursorStyle.peek(),
        uriScheme: product.urlScheme,
        uriHandlers: hooks.uriHandlerOwners(),
        commentThreads: hooks.commentThreads.peek().map((t) => ({
          key: threadKey(t),
          path: t.path,
          line: t.range.startLine,
          comments: t.comments.map((c) => ({ author: c.author, body: c.body.slice(0, 500) })),
          collapsed: t.collapsed,
          canReply: t.canReply,
          ...(t.state && { state: t.state }),
        })),
        commenting: hooks.commentingControllers
          .peek()
          .map((c) => ({ owner: c.owner, controller: c.controller, label: c.label })),
        chatParticipants: hooks.chatParticipants.peek().map((p) => ({
          owner: p.owner,
          id: p.id,
          name: p.name,
          ...(p.description && { description: p.description }),
        })),
        languageModelAccess: services.settings.peek<boolean>(LM_ACCESS) === true,
      }),
    }),
  );
}
