// Sign-in prompts (D139): when git (HTTPS) or ssh needs a username, password, token or key
// passphrase and no credential helper answers, the IDE binary is their askpass program
// (src-tauri/src/git/askpass.rs) and the question arrives here. It is asked in the quick input —
// masked for secrets — one at a time; Escape cancels (git then fails as it would without a
// terminal). Nothing is stored: a credential helper (or `gh auth setup-git`) remembers sign-ins.
import { type AskpassRequest, gitIpc } from "../../core/ipc/git";
import type { WorkbenchServices } from "../../workbench/services";

/** The prompt as shown: git's trailing ": " dropped, a hint for GitHub passwords. */
export function askpassPrompt(prompt: string): string {
  const text = prompt.trim().replace(/:$/, "");
  return /^Password for 'https:\/\/([^@']+@)?github\.com/i.test(text)
    ? `${text} (GitHub wants a personal access token here, not your account password)`
    : text;
}

export function registerAskpass(services: WorkbenchServices): void {
  let queue = Promise.resolve();
  let current: number | null = null;
  /** Prompts git stopped waiting for (timed out) before they were shown. */
  const cancelled = new Set<number>();
  const ask = (req: AskpassRequest) => {
    queue = queue
      .then(async () => {
        if (cancelled.delete(req.id)) return;
        current = req.id;
        const value = await services.quickInput.prompt({
          prompt: askpassPrompt(req.prompt),
          placeholder: req.secret ? "Password, token or passphrase" : "",
          password: req.secret,
        });
        current = null;
        await gitIpc.askpassReply(req.id, value ?? null);
      })
      .catch(() => {
        current = null;
        return gitIpc.askpassReply(req.id, null).catch(() => {});
      });
  };
  const onRequest = (req: AskpassRequest) => {
    if (req.kind !== "cancel") return ask(req);
    if (current === req.id) services.quickInput.cancel();
    else cancelled.add(req.id);
  };
  void gitIpc.askpassListen(onRequest).catch((err: unknown) => {
    console.warn("git sign-in prompts unavailable", err);
  });
}
