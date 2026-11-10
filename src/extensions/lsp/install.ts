// Installing a language server (D199): the shell command for one way to install it, and which of
// a server's ways fits this machine (its package manager is installed). DOM-free, tested.
import type { InstallMethod } from "../../core/extensions/index";

/** The program each package manager runs as (what must be on PATH). */
export const INSTALL_TOOL_PROGRAM: Record<InstallMethod["tool"], string> = {
  npm: "npm",
  pip: "pip",
  go: "go",
  rustup: "rustup",
  dotnet: "dotnet",
  gem: "gem",
  brew: "brew",
  winget: "winget",
};

/** What must be on PATH for `tool` here: pip runs as `py -m pip` / `python3 -m pip`. */
export function installProgram(tool: InstallMethod["tool"], platform: string): string {
  if (tool === "pip") return platform === "windows" ? "py" : "python3";
  return INSTALL_TOOL_PROGRAM[tool];
}

/** The command that installs `m` (one line; the same in PowerShell, cmd and POSIX shells). */
export function installCommand(m: InstallMethod, platform: string): string {
  switch (m.tool) {
    case "npm":
      return `npm install -g ${m.package}`;
    case "pip":
      // The Python launcher's pip on Windows; pip3 elsewhere is often the only one.
      return platform === "windows"
        ? `py -m pip install --user ${m.package}`
        : `python3 -m pip install --user ${m.package}`;
    case "go":
      return `go install ${m.package}`;
    case "rustup":
      return `rustup component add ${m.package}`;
    case "dotnet":
      return `dotnet tool install --global ${m.package}`;
    case "gem":
      return `gem install ${m.package}`;
    case "brew":
      return `brew install ${m.package}`;
    case "winget":
      return `winget install --accept-source-agreements --accept-package-agreements -e --id ${m.package}`;
  }
}

/** The methods that apply on `platform`, in order. */
export function methodsFor(
  methods: readonly InstallMethod[] | undefined,
  platform: string,
): InstallMethod[] {
  return (methods ?? []).filter((m) => !m.platforms || m.platforms.includes(platform));
}

/**
 * The first method whose package manager is installed (`installed[i]` for
 * `methods[i]`'s program), or null.
 */
export function pickInstall(
  methods: readonly InstallMethod[],
  installed: readonly boolean[],
): InstallMethod | null {
  return methods.find((_, i) => installed[i]) ?? null;
}
