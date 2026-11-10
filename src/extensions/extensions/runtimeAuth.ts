// An extension's authentication providers, sessions and secrets (D233, rpcAuthFs.ts on the
// worker side; VS Code's `authentication` and `SecretStorage`).
// - A provider signs the user in to its service. Without its own getSessions, the IDE keeps the
//   sessions it creates in the OS keychain (the provider extension's secrets, as the IDE's own
//   keys are kept: src-tauri/src/ai/secrets.rs) and forgets them on sign-out.
// - `getSession`: an extension gets its own provider's sessions freely; another's only after the
//   user says so in a dialog (remembered per account until the IDE restarts), and signing in for
//   another extension is asked first too. `silent` never asks.
// - Secrets are the extension's own: the backend builds the keychain id from its id
//   (`ext.<id>::<key>`), so no extension reaches another's or the IDE's keys.

import { Emitter } from "../../core/events/index";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import {
  type AuthProviderEntry,
  type AuthSession,
  hasScopes,
} from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { checkSession, sessionDecision } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

const MAX_PROVIDERS = 5;
const MAX_SESSIONS = 50;

export interface AuthHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  worker(): Promise<ExtensionWorker>;
  /** Whether that worker is running now (change listeners don't start one). */
  running(): ExtensionWorker | null;
}

interface Provider {
  entry: AuthProviderEntry;
  changed: Emitter<void>;
  off: Disposable;
}

export class ExtensionAuthHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly providers = new Map<string, Provider>();
  /** Sessions of other extensions' providers the user let this one use: "<provider>|<account>". */
  private readonly allowedAccounts = new Set<string>();
  private listening: Disposable | null = null;

  constructor(private readonly deps: AuthHostDeps) {}

  private get owner(): string {
    return this.deps.manifest.id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "auth.register":
        return Promise.resolve(this.register(p));
      case "auth.unregister": {
        const id = String(p.id);
        this.providers.get(id)?.off.dispose();
        this.providers.delete(id);
        return Promise.resolve(undefined);
      }
      case "auth.changed":
        this.providers.get(String(p.id))?.changed.fire();
        return Promise.resolve(undefined);
      case "auth.listen":
        this.listen();
        return Promise.resolve(undefined);
      case "auth.getSession":
        return this.getSession(p);
      case "secrets.get":
        return extIpc.secretGet(this.owner, String(p.key ?? ""));
      case "secrets.store":
        return extIpc.secretSet(this.owner, String(p.key ?? ""), String(p.value ?? ""));
      case "secrets.delete":
        return extIpc.secretSet(this.owner, String(p.key ?? ""), null);
      default:
        return UNHANDLED;
    }
  }

  // ---- Providers -----------------------------------------------------------------------------

  private register(p: Record<string, unknown>): void {
    const registry = this.deps.services.extensionFeatures.authentication;
    const id = String(p.id ?? "");
    if (!/^[\w.-]{1,60}$/.test(id))
      throw new Error("An authentication provider's id is letters, digits and . - _.");
    const taken = registry.get(id);
    if (taken && taken.owner !== this.owner)
      throw new Error(`Another extension provides "${id}" sign-ins.`);
    // Registered again: the old one goes first (it no longer counts toward the limit).
    this.providers.get(id)?.off.dispose();
    this.providers.delete(id);
    if (this.providers.size >= MAX_PROVIDERS)
      throw new Error(`An extension can have at most ${MAX_PROVIDERS} authentication providers.`);
    const label = String(p.label ?? id).slice(0, 60) || id;
    const stores = p.storesSessions === true;
    const call = async (part: string, args: unknown) =>
      (await this.deps.worker()).call<unknown>(
        "provider",
        `auth.${id}.${part}`,
        args,
        undefined,
        0,
      );
    const changed = new Emitter<void>();
    const store = new DisposableStore();
    store.add(changed);
    const entry: AuthProviderEntry = {
      owner: this.owner,
      id,
      label,
      supportsMultipleAccounts: p.supportsMultipleAccounts === true,
      sessions: async (scopes) => {
        const list = stores
          ? await this.stored(id)
          : (
              await call("getSessions", { ...(scopes && { scopes: [...scopes] }) }).then((r) =>
                Array.isArray(r) ? r : [],
              )
            ).flatMap((s) => checkSession(s) ?? []);
        return scopes ? list.filter((s) => hasScopes(s, scopes)) : list;
      },
      // Signing in may take as long as the user does (a browser page, a pasted token).
      createSession: async (scopes) => {
        const session = checkSession(await call("createSession", { scopes: [...scopes] }));
        if (!session) throw new Error(`${label} didn't return a session.`);
        if (stores) {
          const list = (await this.stored(id)).filter((s) => s.id !== session.id);
          await this.saveStored(id, [...list, session].slice(-MAX_SESSIONS));
        }
        changed.fire();
        return session;
      },
      removeSession: async (sessionId) => {
        await call("removeSession", { sessionId });
        if (stores)
          await this.saveStored(
            id,
            (await this.stored(id)).filter((s) => s.id !== sessionId),
          );
        changed.fire();
      },
      onDidChange: changed.event,
    };
    store.add(registry.add(entry));
    this.providers.set(id, { entry, changed, off: store });
  }

  /** Sessions the IDE keeps for provider `id` (in this extension's keychain secrets). */
  private async stored(id: string): Promise<AuthSession[]> {
    const text = await extIpc.secretGet(this.owner, `auth.sessions.${id}`).catch(() => null);
    if (!text) return [];
    try {
      const list = JSON.parse(text) as unknown;
      return (Array.isArray(list) ? list : []).flatMap((s) => checkSession(s) ?? []);
    } catch {
      return [];
    }
  }

  private saveStored(id: string, sessions: AuthSession[]): Promise<void> {
    return extIpc.secretSet(
      this.owner,
      `auth.sessions.${id}`,
      sessions.length ? JSON.stringify(sessions) : null,
    );
  }

  /** Tells the worker when any provider's sessions change (`onDidChangeSessions`). */
  private listen(): void {
    if (this.listening) return;
    const registry = this.deps.services.extensionFeatures.authentication;
    const subs = new DisposableStore();
    this.listening = this.store.add(subs);
    subs.add(
      effect(() => {
        const inner = new DisposableStore();
        for (const provider of registry.all.value)
          inner.add(
            provider.onDidChange(() =>
              this.deps
                .running()
                ?.notify("provider", "auth.didChange", { providerId: provider.id }),
            ),
          );
        return () => inner.dispose();
      }),
    );
  }

  // ---- Sessions for this extension -----------------------------------------------------------

  private async getSession(p: Record<string, unknown>): Promise<AuthSession | null> {
    const { services, manifest } = this.deps;
    const providerId = String(p.providerId ?? "");
    const provider = services.extensionFeatures.authentication.get(providerId);
    if (!provider) throw new Error(`No authentication provider "${providerId}" is available.`);
    const scopes = (Array.isArray(p.scopes) ? p.scopes : [])
      .filter((s): s is string => typeof s === "string")
      .slice(0, 50);
    const mine = provider.owner === this.owner;
    const sessions = await provider.sessions(scopes);
    const allowed = (s: AuthSession) => this.allowedAccounts.has(`${providerId}|${s.account.id}`);
    const session = sessions.find(allowed) ?? sessions[0];
    const decision = sessionDecision(
      {
        mine,
        silent: p.silent === true,
        createIfNone: p.createIfNone === true,
        forceNewSession: p.forceNewSession === true,
      },
      session,
      allowed,
    );
    const name = manifest.displayName;
    switch (decision) {
      case "give":
        return session ?? null;
      case "none":
        return null;
      case "ask": {
        if (!session) return null;
        const yes = await this.ask(
          `Let ${name} use your ${provider.label} account?`,
          `${name} wants to use the account “${session.account.label}” of ${provider.label}, which another extension signed in.`,
          "Allow",
        );
        if (!yes) return null;
        this.allowedAccounts.add(`${providerId}|${session.account.id}`);
        return session;
      }
      case "askSignIn":
        if (
          !(await this.ask(
            `Sign in with ${provider.label}?`,
            `${name} wants to sign in using ${provider.label}.`,
            "Sign in",
          ))
        )
          return null;
        break;
      case "signIn":
        break;
    }
    const created = await provider.createSession(scopes);
    this.allowedAccounts.add(`${providerId}|${created.account.id}`);
    return created;
  }

  private ask(title: string, message: string, action: string): Promise<boolean> {
    return showDialog<boolean>({
      title,
      message,
      actions: [
        { label: "Cancel", value: false },
        { label: action, value: true, variant: "primary" },
      ],
      cancelValue: false,
    });
  }

  dispose(): void {
    for (const p of this.providers.values()) p.off.dispose();
    this.providers.clear();
    this.store.dispose();
  }
}
