// What a caller other than the user (an agent, an ACP agent, an MCP client, an extension) may not
// ask of a command even when its effects are allowed: inputs that would reach past what those
// effects say. The dispatcher checks these after validating the input and before the permission
// policy, so the refusal names the reason. The user and test scripts are never limited here.
// DOM-free and tested.
//
// Reviewed for escalation (m7.12): every command a non-user caller can reach (not `agent:
// "hidden"`), looking for (1) commands that run another command or an engine command as the user,
// (2) commands that keep a command to run later on the user's click, (3) path inputs that leave the
// open folder's file scope, (4) settings writes that bypass `settings.set`'s checks. What's listed
// below are the verified ones; the rest are checked in their own commands (README, Security).
import type { Caller } from "../dispatcher/types";

/** The user, or a test script standing in for them: never limited by these checks. */
export function isUserCaller(caller: Caller): boolean {
  return caller.kind === "user" || caller.kind === "test";
}

/**
 * Editor engine actions and commands other callers may run through `editor.runAction`: the
 * engine's own editing, cursor, folding and find actions. Not the commands the IDE registers in
 * the engine (`ext.<id>.run.N` runs any IDE command as the user, `lsp.<id>.run.N` a language
 * server's command, `ide.resolveConflict`, notebook cell edits), nor the engine's internal `_…`
 * commands.
 */
const ENGINE_ACTIONS_ALLOWED: readonly RegExp[] = [
  /^editor\.action\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/,
  /^editor\.(un)?fold[A-Za-z0-9]*$/,
  /^editor\.toggleFold[A-Za-z0-9]*$/,
  /^editor\.goto(Next|Previous|Parent)Fold$/,
  /^actions\.find[A-Za-z0-9]*$/,
  /^(cursor|delete|scroll|editorScroll)[A-Za-z0-9]*$/,
  /^(undo|redo|tab|outdent|type|paste|cut|copy|selectAll|lineBreakInsert|expandLineSelection|cancelSelection|removeSecondaryCursors)$/,
  /^ide\.(undo|redo|formatDocument)$/,
];

/** Engine actions that reach outside the editor even though they're named like its own. */
const ENGINE_ACTIONS_DENIED = new Set([
  // Opens the link under the cursor in the system browser (the IDE's ui.openLink, as the user).
  "editor.action.openLink",
  // Apply a code action without the user picking it: its `command` (a language server's
  // `lsp.<id>.run.N`, an extension's) runs as the user (D233 audit). Edits go through
  // lsp.codeActions and the agent's own tools instead.
  "editor.action.codeAction",
  "editor.action.quickFix",
  "editor.action.sourceAction",
  "editor.action.refactor",
  "editor.action.organizeImports",
  "editor.action.fixAll",
  "editor.action.autoFix",
]);

/** Engine actions that read the system clipboard (the IDE's paste reads it for the editor). */
const CLIPBOARD_READS = new Set(["editor.action.clipboardPasteAction"]);

/** Why `caller` (not the user) may not run engine action `action`, or null. */
export function engineActionRefusal(action: string, caller: Caller): string | null {
  if (ENGINE_ACTIONS_DENIED.has(action) || !ENGINE_ACTIONS_ALLOWED.some((re) => re.test(action)))
    return `Only you can run the editor action "${action}"; agents and extensions run the editor's own editing, cursor, folding and find actions.`;
  // An extension reading the clipboard into a file it can read back: its clipboard permission
  // isn't checked on this path, so not at all.
  if (caller.kind === "ext" && CLIPBOARD_READS.has(action))
    return `Extensions can't run "${action}" (it reads your clipboard).`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Guard = (input: Record<string, unknown>, caller: Caller) => string | null;

const extensionsMayNot =
  (what: string): Guard =>
  (_input, caller) =>
    caller.kind === "ext" ? `${what} can only be changed by you, not by an extension.` : null;

/** The per-command checks for callers other than the user. */
const GUARDS: Record<string, Guard> = {
  // Monaco's command registry also holds the IDE's own commands, which run as the user.
  "editor.runAction": (input, caller) =>
    typeof input.action === "string" ? engineActionRefusal(input.action, caller) : null,
  // The tab's Refresh button runs `refresh.command` as the user, on the user's click.
  "editor.openMultiDiff": (input) =>
    input.refresh !== undefined
      ? "Only you can give a multi-file diff a Refresh command (it runs when you click it)."
      : null,
  // lsp.servers is a user setting `settings.set` keeps from extensions: a server's settings can
  // name programs it starts (rust-analyzer's overrideCommand, a Python interpreter).
  "lsp.setServerSetting": extensionsMayNot("Language server settings"),
  "lsp.setServerSettingsJson": extensionsMayNot("Language server settings"),
};

/** The commands with checks for callers other than the user (for the docs and tests). */
export function guardedCommands(): string[] {
  return Object.keys(GUARDS).sort();
}

/** Why `caller` may not run `commandId` with `input` (validated), or null when it may. */
export function callerRefusal(commandId: string, input: unknown, caller: Caller): string | null {
  if (isUserCaller(caller)) return null;
  const guard = GUARDS[commandId];
  if (!guard) return null;
  return guard(isObject(input) ? input : {}, caller);
}
