/**
 * The VS Code version the shim reports (extensions compare against it; installs and update
 * checks pick releases whose `engines.vscode` accepts it). VS Code's latest stable, by the
 * owner's choice (D423): an extension's newest release then installs. What the shim covers was
 * checked against 1.106's `vscode.d.ts`; a member added since that it lacks is logged when an
 * extension uses it (`ide://ext/<id>/vscode`).
 */
export const VSCODE_VERSION = "1.146.0";
