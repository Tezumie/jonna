// What a new file or folder may be called. DOM-free and unit-tested.
import { isWindowsPath } from "../../core/paths/index";
import { parseWslPath } from "../../core/paths/wsl";

const INVALID_NAME = /[\\/:*?"<>|\0]/;
/** Windows' device names: reserved with any extension ("nul.txt" is still the null device). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

/**
 * True when names in `folder` follow Windows' rules: a drive or network path, but not a WSL
 * share (those files live on Linux, where "nul" and "a." are ordinary names).
 */
export function hasWindowsNames(folder: string): boolean {
  return isWindowsPath(folder) && !parseWslPath(folder);
}

/**
 * Why `value` can't be a file or folder name (undefined: it can). With `windows`, also what
 * Windows would refuse or quietly change: creating "nul" reports success and makes nothing, and
 * "a." lands on disk as "a" while events and undo would carry "a.".
 */
export function validateName(value: string, windows = false): string | undefined {
  const name = value.trim();
  if (!name) return "A file or folder name must be provided.";
  if (name === "." || name === "..") return "This name is not valid.";
  if (INVALID_NAME.test(name)) return "Names can't contain \\ / : * ? \" < > |";
  if (windows) {
    if (WINDOWS_RESERVED.test(name))
      return `"${name}" is a name Windows reserves for a device. Choose another.`;
    if (name.endsWith(".")) return "On Windows, names can't end with a period.";
  }
  return undefined;
}
