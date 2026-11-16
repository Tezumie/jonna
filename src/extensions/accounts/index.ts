// Accounts (D140), VS Code's person icon above the gear: the IDE's own account (sign in through
// the browser, in a build that names an accounts server: product.json `accountsUrl`,
// docs/own-services.md; a build without one has no such entry, command or setting), GitHub
// through the GitHub CLI (`gh auth login` in a terminal; pull requests use it), model providers,
// and settings backup (export / import a profile; syncing is the Sync tab, where the build has
// it). State: ide://accounts.
import type { BuiltinExtension } from "../../core/extensions/index";
import { type AccountProfile, accountsIpc } from "../../core/ipc/accounts";
import { githubIpc } from "../../core/ipc/git";
import { openerIpc } from "../../core/ipc/system";
import { MutableDisposable } from "../../core/lifecycle/index";
import { accountsServer, hasAccounts, hasPlanPage, hasSync } from "../../core/ownServices";
import { product } from "../../core/product";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import { type MenuItem, showMenu } from "../../ui/Menu";
import { withTimeout } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import {
  accountsManifest,
  backupTitle,
  type GitHubLogin,
  parseGhAuth,
  signInProviders,
} from "./model";

/** Whether this build has an account of its own, and Sync (product.json, docs/own-services.md). */
const ideAccount = hasAccounts();
const syncBuiltIn = hasSync();

/** An extension's authentication provider in the Accounts menu (D233). */
interface ExtensionAccounts {
  providerId: string;
  label: string;
  owner: string;
  accounts: { id: string; label: string }[];
}

export const accountsExtension: BuiltinExtension<WorkbenchServices> = {
  manifest: accountsManifest(manifest, { accounts: ideAccount, sync: syncBuiltIn }),
  activate({ subscriptions: sub, services }) {
    const { dispatcher, state, notifications, settings } = services;
    /** The accounts server; "" in a build without one. */
    const server = () => accountsServer(settings.peek<string | undefined>("accounts.serverUrl"));
    const profile = signal<AccountProfile | null>(null);
    const github = signal<GitHubLogin[]>([]);
    /** "gh isn't installed" and the like; null when gh answered. */
    const githubProblem = signal<string | null>(null);
    const signingIn = signal(false);
    const menu = sub.add(new MutableDisposable());

    /** When the accounts were last read (gh is a process start plus a network check). */
    let checkedAt = 0;
    let checking: Promise<void> | null = null;
    /** Re-reads the accounts when older than `maxAgeMs` (one check at a time). */
    const refreshIfStale = (maxAgeMs: number) => {
      if (checking || Date.now() - checkedAt < maxAgeMs) return checking ?? Promise.resolve();
      checking = refresh().finally(() => {
        checkedAt = Date.now();
        checking = null;
      });
      return checking;
    };
    /** When the server was last asked for the profile (D414): at startup, then hourly at most. */
    let serverCheckedAt = 0;
    const readProfile = (base: string) => {
      if (Date.now() - serverCheckedAt < 60 * 60_000) return accountsIpc.profile(base);
      serverCheckedAt = Date.now();
      return accountsIpc.check(base).catch(() => accountsIpc.profile(base));
    };
    const refresh = async () => {
      const base = server();
      const [p, gh] = await Promise.all([
        base ? readProfile(base).catch(() => null) : Promise.resolve(null),
        githubIpc.run("authStatus").then(
          (text) => ({ text, problem: null }),
          (err: unknown) => ({
            text: "",
            problem: err instanceof Error ? err.message : String(err),
          }),
        ),
      ]);
      profile.value = p;
      github.value = parseGhAuth(gh.text);
      githubProblem.value = gh.problem;
      void showAvatar();
    };
    // The account's picture on the Accounts icon (VS Code shows the GitHub one).
    let avatarUrl = "";
    let avatarBlob = "";
    const showAvatar = async () => {
      // The picture goes on a button of the window's activity bar.
      if (!services.hasScreen) return;
      const login = github.peek().find((g) => g.active && g.host === "github.com");
      const url =
        profile.peek()?.avatarUrl ?? (login ? `https://github.com/${login.login}.png?size=64` : "");
      const button = document.querySelector<HTMLElement>(".activitybar-accounts");
      if (!button || url === avatarUrl) return;
      avatarUrl = url;
      if (avatarBlob) URL.revokeObjectURL(avatarBlob);
      avatarBlob = "";
      button.querySelector(".activitybar-avatar")?.remove();
      button.classList.remove("has-avatar");
      if (!url) return;
      const bytes = await accountsIpc.avatar(url, server()).catch(() => null);
      if (!bytes || url !== avatarUrl) return;
      avatarBlob = URL.createObjectURL(new Blob([bytes.slice()]));
      const img = document.createElement("img");
      img.className = "activitybar-avatar";
      img.alt = "";
      img.src = avatarBlob;
      button.append(img);
      button.classList.add("has-avatar");
    };
    sub.add({ dispose: () => avatarBlob && URL.revokeObjectURL(avatarBlob) });
    void refreshIfStale(0);
    // The Sync tab asked the server for the profile again (a plan bought or renewed in the
    // browser): what it saved is the profile now, so the menu's Sync entry follows.
    sub.add(
      services.events.on("command.executed", (event) => {
        if (event.status !== "ok" || event.id !== "sync.checkPlan") return;
        const base = server();
        if (!base) return;
        void accountsIpc
          .profile(base)
          .then((p) => {
            if (JSON.stringify(p) !== JSON.stringify(profile.peek())) profile.value = p;
          })
          .catch(() => {});
      }),
    );
    // Coming back to the window: signed in or out in the browser meanwhile, perhaps.
    if (services.hasScreen) {
      const onFocus = () => void refreshIfStale(5 * 60_000);
      window.addEventListener("focus", onFocus);
      sub.add({ dispose: () => window.removeEventListener("focus", onFocus) });
    }

    const run =
      (id: string, input: unknown = {}) =>
      () =>
        void dispatcher.execute(id, input).catch(() => {});

    /** Extensions' authentication providers and their accounts, as last read (ide://accounts). */
    let extensionsSeen: ExtensionAccounts[] = [];
    const extensionAccounts = async (): Promise<ExtensionAccounts[]> => {
      const providers = services.extensionFeatures.authentication.all.peek();
      extensionsSeen = await Promise.all(
        providers.map(async (p) => {
          // A slow or broken provider leaves its row as "Sign in with…", not the menu waiting.
          const sessions = await withTimeout(p.sessions(), 1500, p.label).catch(() => []);
          const accounts = [
            ...new Map(sessions.map((x) => [x.account.id, x.account] as const)).values(),
          ];
          return { providerId: p.id, label: p.label, owner: p.owner, accounts };
        }),
      );
      return extensionsSeen;
    };

    /** A terminal running a command the user finishes there (gh's own login). */
    const inTerminal = async (command: string) => {
      await dispatcher.execute("terminal.create", {});
      await dispatcher.execute("terminal.sendText", { text: command });
    };

    sub.add(
      dispatcher.register({
        id: "accounts.showMenu",
        title: "Accounts",
        category: "Accounts",
        description:
          "Opens the Accounts menu: the IDE account, GitHub (GitHub CLI), model providers and settings backup.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        needsScreen: true,
        run: async () => {
          // Show at once from what's known; refresh in the background when it's old (gh is slow).
          void refreshIfStale(30_000);
          const p = profile.value;
          const items: MenuItem[] = [];
          if (p)
            items.push({
              label: `${p.name}${p.email ? ` (${p.email})` : ""}`,
              icon: "circle-user-round",
              submenu: [
                ...(p.plan && hasPlanPage() ? [{ label: `Plan: ${p.plan}`, disabled: true }] : []),
                {
                  label: "Sign out",
                  icon: "log-out",
                  run: run("accounts.signOut", { provider: "ide" }),
                },
              ],
            });
          else if (ideAccount)
            items.push({
              label: signingIn.value
                ? "Signing in… (cancel)"
                : `Sign in to your ${product.nameShort} account…`,
              icon: "log-in",
              run: signingIn.value
                ? run("accounts.cancelSignIn")
                : run("accounts.signIn", { provider: "ide" }),
            });
          const logins = github.value;
          if (logins.length)
            for (const g of logins)
              items.push({
                label: `${g.login} (GitHub${g.host === "github.com" ? "" : ` · ${g.host}`})`,
                icon: "git-pull-request",
                separatorBefore: g === logins[0] && items.length > 0,
                submenu: [
                  {
                    label: "Open profile",
                    icon: "external-link",
                    run: () =>
                      void openerIpc.openUrl(`https://${g.host}/${g.login}`).catch(() => {}),
                  },
                  {
                    label: "Sign out",
                    icon: "log-out",
                    run: run("accounts.signOut", { provider: "github" }),
                  },
                ],
              });
          else
            items.push({
              label: githubProblem.value?.includes("isn't installed")
                ? "Sign in to GitHub… (install the GitHub CLI)"
                : "Sign in to GitHub…",
              icon: "git-pull-request",
              separatorBefore: items.length > 0,
              run: run("accounts.signIn", { provider: "github" }),
            });
          // Extensions' sign-ins (D233, VS Code lists them here too): each account with Sign
          // out, or Sign in with a provider that has none yet.
          const fromExtensions = await extensionAccounts();
          fromExtensions.forEach((entry, i) => {
            const first = i === 0;
            if (!entry.accounts.length) {
              items.push({
                label: `Sign in with ${entry.label}…`,
                icon: "log-in",
                separatorBefore: first,
                run: run("extensions.authSignIn", { providerId: entry.providerId }),
              });
              return;
            }
            entry.accounts.forEach((account, j) => {
              items.push({
                label: `${account.label} (${entry.label})`,
                icon: "circle-user-round",
                separatorBefore: first && j === 0,
                submenu: [
                  {
                    label: "Sign out",
                    icon: "log-out",
                    run: run("extensions.authSignOut", {
                      providerId: entry.providerId,
                      account: account.id,
                    }),
                  },
                ],
              });
            });
          });
          if (dispatcher.has("agent.showSetup"))
            items.push({
              label: "AI models and providers…",
              icon: "agent",
              run: run("agent.showSetup"),
            });
          // Sync (D435), once it is open to the account, or on sale to it.
          const syncOpen =
            (p?.sync === true || p?.syncOffered === true) && dispatcher.has("sync.show");
          if (syncOpen)
            items.push({
              label: "Sync…",
              icon: "refresh-cw",
              separatorBefore: true,
              run: run("sync.show"),
            });
          items.push({
            label: backupTitle(syncBuiltIn),
            icon: syncOpen ? "file-output" : "refresh-cw",
            separatorBefore: !syncOpen,
            run: run("accounts.syncSettings"),
          });
          const anchor = document.querySelector<HTMLElement>(".activitybar-accounts");
          const r = anchor?.getBoundingClientRect();
          menu.value = showMenu(
            r ? { x: r.right + 4, y: r.bottom } : { x: 56, y: window.innerHeight },
            items,
            {
              label: "Accounts",
              focusFirst: false,
            },
          );
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "accounts.signIn",
        title: "Sign in…",
        category: "Accounts",
        description: ideAccount
          ? 'Signs in: "ide" (the IDE account, through the browser) or "github" (`gh auth login` in a terminal).'
          : 'Signs in to "github" (`gh auth login` in a terminal).',
        input: s.object({ provider: s.enum(signInProviders(ideAccount)) }),
        effects: ["network"],
        agent: "hidden",
        run: async ({ provider }) => {
          if (provider === "github") {
            await inTerminal("gh auth login --hostname github.com --git-protocol https --web");
            notifications.show(
              "info",
              "Finish signing in to GitHub in the terminal. The Accounts menu picks it up afterwards.",
            );
            checkedAt = 0; // read again next time the menu opens
            return { started: "github" };
          }
          const base = server();
          // Not reached through the menu: a build without accounts has no "ide" provider.
          if (!base) throw new Error("This build has no accounts service.");
          if (signingIn.peek()) return { signingIn: true };
          signingIn.value = true;
          try {
            const p = await accountsIpc.signIn(
              base,
              (url) => void openerIpc.openUrl(url).catch(() => {}),
            );
            profile.value = p;
            notifications.show("success", `Signed in as ${p.name}.`);
            return { signedIn: p.name };
          } finally {
            signingIn.value = false;
          }
        },
      }),
    );

    // Only the IDE account's sign-in waits for the browser.
    if (ideAccount)
      sub.add(
        dispatcher.register({
          id: "accounts.cancelSignIn",
          title: "Cancel sign-in",
          category: "Accounts",
          description: "Stops waiting for the browser sign-in.",
          input: s.empty(),
          effects: [],
          agent: "hidden",
          run: () => accountsIpc.cancel(),
        }),
      );

    sub.add(
      dispatcher.register({
        id: "accounts.signOut",
        title: "Sign out…",
        category: "Accounts",
        description: ideAccount
          ? 'Signs out of "ide" (the IDE account) or "github" (`gh auth logout`, in a terminal).'
          : 'Signs out of "github" (`gh auth logout`, in a terminal).',
        input: s.object({ provider: s.enum(signInProviders(ideAccount)) }),
        effects: ["network"],
        agent: "hidden",
        run: async ({ provider }) => {
          if (provider === "github") {
            await inTerminal("gh auth logout --hostname github.com");
            checkedAt = 0; // read again next time the menu opens
            return { started: "github" };
          }
          await accountsIpc.signOut();
          profile.value = null;
          notifications.show("info", "Signed out.");
          return { signedOut: true };
        },
      }),
    );

    sub.add(
      dispatcher.register({
        id: "accounts.syncSettings",
        title: backupTitle(syncBuiltIn),
        category: "Accounts",
        description: syncBuiltIn
          ? "Settings backup: export or import a profile (settings, keybindings, snippets) as a file. Syncing between computers is the Sync tab (sync.show), for accounts it is open to."
          : "Settings backup: export or import a profile (settings, keybindings, snippets) as a file.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async () => {
          const p = profile.peek();
          const syncOpen =
            (p?.sync === true || p?.syncOffered === true) && dispatcher.has("sync.show");
          const choice = await showDialog<"export" | "import" | "sync" | "cancel">({
            title: syncBuiltIn ? "Backup and sync settings" : "Back up settings",
            message: syncOpen
              ? "To keep your settings the same on every computer, use Sync. For a copy in a file, export your settings, keybindings and snippets, or import one."
              : !syncBuiltIn
                ? "Export your settings, keybindings and snippets to a file, or import one."
                : profile.peek()
                  ? "Sync isn't open to your account. Export your settings, keybindings and snippets to a file, or import one."
                  : "To keep your settings the same on every computer, sign in to your account and use Sync. For a copy in a file, export your settings, keybindings and snippets, or import one.",
            actions: [
              { label: "Cancel", value: "cancel" },
              { label: "Import…", value: "import" },
              { label: "Export…", value: "export", variant: "primary" },
            ],
            ...(syncOpen && { leftActions: [{ label: "Open Sync", value: "sync" as const }] }),
            cancelValue: "cancel",
          });
          if (choice === "sync") return dispatcher.execute("sync.show", {});
          if (choice === "export") return dispatcher.execute("settings.exportProfile", {});
          if (choice === "import") return dispatcher.execute("settings.importProfile", {});
          return { cancelled: true };
        },
      }),
    );

    sub.add(
      state.register("ide://accounts", {
        description:
          "Accounts: the IDE account (`available`: whether this build has an accounts service; profile when signed in) and the GitHub CLI's signed-in accounts.",
        get: () => ({
          ide: {
            available: !!server(),
            signedIn: profile.peek() !== null,
            profile: profile.peek(),
          },
          github: { accounts: github.peek(), problem: githubProblem.peek() },
          // As of the menu's last opening (reading them asks the extensions).
          extensions: extensionsSeen,
        }),
      }),
    );
  },
};
