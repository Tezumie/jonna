// Terminal tab titles (DESIGN.md §12.3). DOM-free and unit-tested.

/** "pwsh · ide": the shell's file name without extension, then the cwd's folder name. */
export function terminalTitle(shell: string, cwd: string): string {
  const name = (shell.split(/[\\/]/).pop() ?? "shell").replace(/\.exe$/i, "");
  const folder =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || cwd;
  return folder ? `${name} · ${folder}` : name;
}

/** Undoes the integration scripts' escaping (`\\`, `\xHH`). */
export function unescapeMark(s: string): string {
  return s.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_, e: string) =>
    e === "\\" ? "\\" : String.fromCharCode(Number.parseInt(e.slice(1), 16)),
  );
}
