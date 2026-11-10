// Typing a command line into a shell for the user (terminal.runCommand, tasks, Run recent
// command), D270. Bash's readline holds a lone Escape until the next key with no timeout (Escape
// is the prefix of Alt+key there), so after the user pressed Escape in the terminal the command's
// first letter was read as Alt+letter: `cp …` ran as `p …`. Escape Ctrl+G is readline's abort,
// which drops the held Escape and nothing else; other shells resolve a lone Escape on their own
// (zsh and fish after a short timeout, PowerShell at once). DOM-free and tested.

/** Whether the shell's line editor holds a lone Escape: bash (Git Bash, WSL, Linux, macOS). */
export function holdsEscape(shell: string): boolean {
  const name = (shell.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return name === "bash" || name === "sh";
}

/**
 * What to write to type `command` and run it, given the last input the user's keys sent: a
 * held Escape is cancelled first.
 */
export function commandInput(command: string, lastInput: string, shell: string): string {
  const held = lastInput.endsWith("\x1b") && holdsEscape(shell);
  return `${held ? "\x07" : ""}${command}\r`;
}
