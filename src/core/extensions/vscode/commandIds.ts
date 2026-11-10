// How the `vscode` shim asks the host about other extensions' commands (VS Code has one
// registry for every extension): ids with a ":" (no dispatcher command has one), sent through
// `commands.execute` so they run as the calling extension, under its own permissions.

/** Runs another extension's command (or the IDE's) by its VS Code id: `{ arguments }`. */
export const RUN_VSCODE_COMMAND = "vscode:run:";
/** The extension registered this VS Code command in code only (its manifest doesn't list it). */
export const ANNOUNCE_VSCODE_COMMAND = "vscode:announce:";
