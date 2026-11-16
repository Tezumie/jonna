// Accounts, DOM-free (D140): what `gh auth status` says, and what of the extension a build without
// an accounts server (or without Sync) leaves out.
import type { ExtensionManifest } from "../../core/extensions/index";

export interface GitHubLogin {
  host: string;
  login: string;
  /** The account gh uses for that host. */
  active: boolean;
}

/**
 * Accounts from `gh auth status` output: "✓ Logged in to github.com account octo (keyring)"
 * (gh ≥ 2.40) or "Logged in to github.com as octo" (older); "Active account: false" marks the
 * others.
 */
export function parseGhAuth(text: string): GitHubLogin[] {
  const out: GitHubLogin[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /Logged in to (\S+) (?:account|as) ([A-Za-z0-9-]+)/.exec(line);
    if (!m?.[1] || !m[2]) return;
    // "- Active account: false" follows on a later line of the same block.
    const block = lines.slice(i + 1, i + 4).join("\n");
    out.push({ host: m[1], login: m[2], active: !/Active account: false/.test(block) });
  });
  return out;
}

/** What only a build with an accounts server has (core/ownServices.ts `hasAccounts`). */
const IDE_ACCOUNT_COMMANDS: ReadonlySet<string> = new Set(["accounts.cancelSignIn"]);
const IDE_ACCOUNT_SETTINGS: ReadonlySet<string> = new Set(["accounts.serverUrl"]);
/** The settings backup command: the one whose title mentions sync. */
const BACKUP_COMMAND = "accounts.syncSettings";

/** The settings backup command's title: sync isn't named in a build that has none. */
export function backupTitle(sync: boolean): string {
  return sync ? "Backup and sync settings…" : "Back up settings…";
}

/** Who can be signed in or out with accounts.signIn / signOut: the IDE account only when the build has one. */
export function signInProviders(accounts: boolean): readonly ("ide" | "github")[] {
  return accounts ? ["ide", "github"] : ["github"];
}

/**
 * The extension's manifest as this build has it: without the IDE account's command and setting
 * when the build names no accounts server, and with the backup command's title for a build
 * without Sync. GitHub, extensions' sign-ins and settings backup are there either way.
 */
export function accountsManifest(
  manifest: ExtensionManifest,
  has: { accounts: boolean; sync: boolean },
): ExtensionManifest {
  const contributes = manifest.contributes ?? {};
  return {
    ...manifest,
    contributes: {
      ...contributes,
      commands: (contributes.commands ?? [])
        .filter((c) => has.accounts || !IDE_ACCOUNT_COMMANDS.has(c.id))
        .map((c) => (c.id === BACKUP_COMMAND ? { ...c, title: backupTitle(has.sync) } : c)),
      settings: Object.fromEntries(
        Object.entries(contributes.settings ?? {}).filter(
          ([key]) => has.accounts || !IDE_ACCOUNT_SETTINGS.has(key),
        ),
      ),
    },
  };
}
