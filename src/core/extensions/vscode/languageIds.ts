// Language ids the editor names differently from VS Code ("tsx" is VS Code's "typescriptreact"):
// extensions see VS Code's (document.languageId, selectors, onLanguage), the editor keeps its own.
// DOM-free.

const TO_VSCODE: Record<string, string> = {
  tsx: "typescriptreact",
  jsx: "javascriptreact",
  make: "makefile",
};
const TO_IDE: Record<string, string> = Object.fromEntries(
  Object.entries(TO_VSCODE).map(([ide, vscode]) => [vscode, ide]),
);

/** The editor's language id as VS Code names it. */
export const vscodeLanguageId = (id: string): string => TO_VSCODE[id] ?? id;
/** VS Code's language id as the editor names it. */
export const ideLanguageId = (id: string): string => TO_IDE[id] ?? id;
