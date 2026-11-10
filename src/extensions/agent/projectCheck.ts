// The project's check for the verify step (D127) when agent.verifyCommand is empty: read what the
// folder has (package.json scripts and lockfiles, Cargo.toml, go.mod); the choice itself is
// core/agent/verify.ts (tested).
import { detectVerifyCommand } from "../../core/agent/verify";
import { fsIpc } from "../../core/ipc/fs";
import { joinPath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

export async function detectCheck(services: WorkbenchServices): Promise<string | null> {
  const root = services.workspace.root.peek();
  if (!root) return null;
  const names = new Set((await fsIpc.listDir(root).catch(() => [])).map((e) => e.name));
  const packageJson = names.has("package.json")
    ? await fsIpc
        .read(joinPath(root, "package.json"))
        .then((b) => new TextDecoder().decode(b))
        .catch(() => null)
    : null;
  return detectVerifyCommand({
    packageJson,
    hasCargoToml: names.has("Cargo.toml"),
    hasGoMod: names.has("go.mod"),
    lockfiles: [...names].filter((n) => /lock/.test(n)),
  });
}
