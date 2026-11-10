// Built-in language-server definitions: manifest only (contributes.languageServers); the lsp
// extension starts them on demand. Third-party server extensions will look the same (M6).
import type { BuiltinExtension, ExtensionManifest } from "../../core/extensions/index";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";

export const languageServersExtension: BuiltinExtension<WorkbenchServices> = {
  manifest: manifest as unknown as ExtensionManifest,
  activate() {},
};
