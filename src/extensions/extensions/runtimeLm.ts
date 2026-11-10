// The host side of an extension's language model requests and chat participants (rpcChat.ts, D248).
// AI is opt-in outside the agent's chat (AGENTS.md rule 8): `lm` answers only while the user has
// turned on `extensions.languageModelAccess` (off by default), and each extension asks once (a
// dialog naming it; "Allow" is kept in `extensions.languageModelAllowed`). Requests use the user's
// own model through `services.languageModel` (the inline edit's model setting, else the agent's),
// one system prompt and the conversation as text; the answer streams back as `lm.chunk` calls.
// Chat participants are registered as "@name"s anyone can ask with extensions.askChatParticipant.
import { commandPrefix, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { showDialog } from "../../ui/Dialog";
import { promptOf } from "../../workbench/extensionHooks";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

export const LM_ACCESS = "extensions.languageModelAccess";
export const LM_ALLOWED = "extensions.languageModelAllowed";

/** At once, per extension. */
const MAX_REQUESTS = 4;
const MAX_PROMPT = 200_000;
const MAX_PARTICIPANTS = 10;
/** A participant's answer may take a model call or two. */
const PARTICIPANT_MS = 180_000;

export interface LmHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  worker(): Promise<ExtensionWorker>;
  running(): ExtensionWorker | null;
}

export class ExtensionLmHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly requests = new Map<string, AbortController>();
  private readonly participants = new Map<string, Disposable>();
  /** Denied in this session (asked again after a restart). */
  private denied = false;
  private asking: Promise<boolean> | null = null;

  constructor(private readonly deps: LmHostDeps) {
    this.store.add(toDisposable(() => this.workerGone()));
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "lm.model":
        return Promise.resolve(this.model());
      case "lm.sendRequest":
        return this.send(p);
      case "lm.cancel":
        this.requests.get(String(p.requestId ?? ""))?.abort();
        return Promise.resolve(undefined);
      case "chat.register":
        return Promise.resolve(this.register(p));
      case "chat.unregister": {
        const id = String(p.id ?? "");
        this.participants.get(id)?.dispose();
        this.participants.delete(id);
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  private get enabled(): boolean {
    return this.deps.services.settings.peek<boolean>(LM_ACCESS) === true;
  }

  /** The user's model, while extensions may use it (else none: selectChatModels gets []). */
  private model(): { id: string; name: string; family: string } | null {
    if (!this.enabled) return null;
    const key = this.deps.services.languageModel.model("edit");
    if (!key) return null;
    const name = key.split("/").pop() ?? key;
    return { id: key, name, family: name };
  }

  /** Asks the user once whether this extension may use their model. */
  private async consent(justification: string): Promise<boolean> {
    const { services, manifest } = this.deps;
    const allowed = services.settings.peek<unknown>(LM_ALLOWED);
    if (Array.isArray(allowed) && allowed.includes(manifest.id)) return true;
    if (this.denied) return false;
    this.asking ??= showDialog<"allow" | "deny">({
      title: `Let ${manifest.displayName} use your model?`,
      message: `${manifest.displayName} wants to send requests to your language model (${this.model()?.id ?? "none set up"}). Requests may cost money with a paid provider.${justification ? `\n\nIt says: ${justification.slice(0, 500)}` : ""}`,
      actions: [
        { label: "Don't allow", value: "deny" },
        { label: "Allow", value: "allow", variant: "primary" },
      ],
      cancelValue: "deny",
    }).then(async (answer) => {
      this.asking = null;
      if (answer !== "allow") {
        this.denied = true;
        return false;
      }
      const list = services.settings.peek<unknown>(LM_ALLOWED);
      const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
      if (!ids.includes(manifest.id))
        await services.settings.update(LM_ALLOWED, [...ids, manifest.id], "user");
      return true;
    });
    return this.asking;
  }

  private async send(p: Record<string, unknown>): Promise<void> {
    const { services, manifest } = this.deps;
    if (!this.enabled)
      throw new Error(
        `Extensions can't use your language model: turn on the ${LM_ACCESS} setting first.`,
      );
    const model = this.model();
    if (!model) throw new Error("No language model is set up.");
    if (typeof p.model === "string" && p.model !== model.id)
      throw new Error(`The model ${p.model} isn't available.`);
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error(`At most ${MAX_REQUESTS} language model requests at once.`);
    const justification = typeof p.justification === "string" ? p.justification : "";
    if (!(await this.consent(justification)))
      throw new Error(`The user didn't allow ${manifest.displayName} to use their language model.`);
    const requestId = String(p.requestId ?? "");
    const messages = (Array.isArray(p.messages) ? p.messages : []).map((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      return {
        role: r.role === "assistant" ? "assistant" : "user",
        content: String(r.content ?? ""),
      };
    });
    const prompt = promptOf(messages);
    if (!prompt.trim()) throw new Error("The request has no messages.");
    if (prompt.length > MAX_PROMPT) throw new Error("The request is too long.");
    const abort = new AbortController();
    this.requests.set(requestId, abort);
    let sent = 0;
    const post = (target: string, args: unknown) =>
      this.deps.running()?.notify("provider", target, args);
    // Started once this request has been answered (a turn later): its text then streams in.
    window.setTimeout(() => {
      void services.languageModel
        .generate({
          purpose: "edit",
          system: `You answer requests from the ${manifest.displayName} extension of the user's code editor.`,
          prompt,
          maxTokens: 4000,
          signal: abort.signal,
          onText: (text) => {
            if (text.length <= sent) return;
            post("lm.chunk", { requestId, text: text.slice(sent) });
            sent = text.length;
          },
        })
        .then(
          (text) => {
            if (text.length > sent) post("lm.chunk", { requestId, text: text.slice(sent) });
            post("lm.end", { requestId });
          },
          (err: unknown) =>
            post("lm.end", { requestId, error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => this.requests.delete(requestId));
    }, 0);
  }

  private register(p: Record<string, unknown>): void {
    const { manifest, services } = this.deps;
    const id = String(p.id ?? "");
    const owned = [`${manifest.id}.`, `${commandPrefix(manifest.id)}.`].some((prefix) =>
      id.startsWith(prefix),
    );
    if (!owned)
      throw new Error(`A chat participant's id starts with the extension's (${manifest.id}.…).`);
    const name = String(p.name ?? "");
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name))
      throw new Error(`"${name}" can't be a chat participant's name (letters, digits, - and _).`);
    if (!this.participants.has(id) && this.participants.size >= MAX_PARTICIPANTS)
      throw new Error(`At most ${MAX_PARTICIPANTS} chat participants per extension.`);
    this.participants.get(id)?.dispose();
    this.participants.set(
      id,
      services.extensionFeatures.hooks.addChatParticipant({
        owner: manifest.id,
        id,
        name,
        ...(typeof p.description === "string" && { description: p.description.slice(0, 300) }),
        request: async (prompt, command) => {
          const worker = await this.deps.worker();
          const answer = await worker.call<{ markdown?: unknown } | null>(
            "provider",
            `chat.${id}.request`,
            { prompt, ...(command && { command }) },
            undefined,
            PARTICIPANT_MS,
          );
          return { markdown: typeof answer?.markdown === "string" ? answer.markdown : "" };
        },
      }),
    );
  }

  /** The worker died: its requests stop, its participants go. */
  workerGone(): void {
    for (const a of this.requests.values()) a.abort();
    this.requests.clear();
    for (const d of this.participants.values()) d.dispose();
    this.participants.clear();
  }

  dispose(): void {
    this.store.dispose();
  }
}
