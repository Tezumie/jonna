// Path arguments as weak models write them (D144): quoted, labeled with the parameter's name
// (`path:C:\x`, `cwd=src`), or with a slash before a drive (`\C:\x`). Cleaned before they're
// resolved against the folder. DOM-free and tested.
export function cleanPathArg(path: string): string {
  return path
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/^(?:path|cwd|dir|file|folder)\s*[:=]\s*/i, "")
    .replace(/^[\\/](?=[A-Za-z]:[\\/])/, "");
}
