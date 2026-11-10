// Accounts, DOM-free (D140): what `gh auth status` says, and the menu's account list.

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

/** The accounts server: the setting (development) wins over product.json. */
export function accountsServer(setting: string | undefined, product: string): string {
  return (setting?.trim() || product.trim()).replace(/\/+$/, "");
}
