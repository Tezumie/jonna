import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectedProfile } from "../../core/ipc/process";
import {
  defaultProfile,
  msysToWindows,
  parseAutomationProfile,
  profileColor,
  profilePlatform,
  profileSpec,
  profileTaskShell,
  quotePathForShell,
  resolveProfiles,
  shellRunFlags,
  windowsToMsys,
} from "./profiles";

const detected: DetectedProfile[] = [
  {
    name: "PowerShell",
    path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: ["-NoLogo"],
    source: "PowerShell",
    icon: "powershell",
  },
  {
    name: "Git Bash",
    path: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["--login", "-i"],
    source: "Git Bash",
    icon: "bash",
  },
  { name: "Command Prompt", path: "C:\\Windows\\System32\\cmd.exe", args: [], icon: "cmd" },
  {
    name: "Ubuntu (WSL)",
    path: "C:\\Windows\\System32\\wsl.exe",
    args: ["-d", "Ubuntu"],
    icon: "linux",
  },
];

test("detected profiles come first, in their order, without settings", () => {
  const list = resolveProfiles({}, detected);
  assert.deepEqual(
    list.map((p) => p.name),
    ["PowerShell", "Git Bash", "Command Prompt", "Ubuntu (WSL)"],
  );
  assert.deepEqual(list[1]?.args, ["--login", "-i"]);
  assert.equal(list[2]?.args, undefined);
  assert.equal(list[0]?.detected, true);
  const wsl = list[3];
  assert.ok(wsl);
  assert.deepEqual(profileSpec(wsl), {
    path: ["C:\\Windows\\System32\\wsl.exe"],
    args: ["-d", "Ubuntu"],
  });
});

test("settings hide, adjust, add and point at a source, as in VS Code", () => {
  const list = resolveProfiles(
    {
      "Command Prompt": null,
      "Git Bash": { env: { CHERE_INVOKING: "1", HISTFILE: null }, color: "terminal.ansiGreen" },
      "My bash": { source: "Git Bash", args: ["-l"], icon: "bot", overrideName: true },
      Nu: { path: ["C:\\nope\\nu.exe", "nu"], args: "--login" },
      Broken: { args: ["x"] },
      "Not an object": 3,
    },
    detected,
    ["bot", "terminal"],
  );
  assert.deepEqual(
    list.map((p) => p.name),
    ["PowerShell", "Git Bash", "Ubuntu (WSL)", "My bash", "Nu"],
  );
  const git = list[1];
  assert.deepEqual(git?.path, ["C:\\Program Files\\Git\\bin\\bash.exe"]);
  assert.deepEqual(git?.args, ["--login", "-i"]); // kept from the detected profile
  assert.deepEqual(git?.env, { CHERE_INVOKING: "1", HISTFILE: null });
  assert.equal(git?.color, "green");
  const mine = list[3];
  assert.deepEqual(mine?.path, ["C:\\Program Files\\Git\\bin\\bash.exe"]);
  assert.deepEqual(mine?.args, ["-l"]);
  assert.equal(mine?.icon, "bot");
  assert.equal(mine?.overrideName, true);
  assert.equal(mine?.kind, "bash");
  const nu = list[4];
  assert.deepEqual(nu?.path, ["C:\\nope\\nu.exe", "nu"]);
  assert.deepEqual(nu?.args, ["--login"]);
  assert.equal(nu?.detected, false);
});

test("the default profile is found by name, else the IDE's own shell", () => {
  const list = resolveProfiles({}, detected);
  assert.equal(defaultProfile("git bash", list)?.name, "Git Bash");
  assert.equal(defaultProfile("", list), null);
  assert.equal(defaultProfile("Fish", list), null);
  assert.equal(defaultProfile(null, list), null);
  assert.equal(profilePlatform("windows"), "windows");
  assert.equal(profilePlatform("mac"), "osx");
  assert.equal(profilePlatform("linux"), "linux");
  assert.equal(profileColor("terminal.ansiBrightCyan"), "cyan");
  assert.equal(profileColor("terminal.ansiWhite"), undefined);
});

test("Git Bash paths, and quoting for each shell", () => {
  assert.equal(windowsToMsys("C:\\Users\\me\\a b.txt"), "/c/Users/me/a b.txt");
  assert.equal(windowsToMsys("D:\\"), "/d");
  assert.equal(msysToWindows("/c/Users/me"), "C:\\Users\\me");
  assert.equal(msysToWindows("/d"), "D:\\");
  assert.equal(msysToWindows("/usr/bin"), "/usr/bin");
  assert.equal(
    quotePathForShell("C:\\My Files\\x.txt", "C:\\…\\bash.exe", true),
    "'/c/My Files/x.txt'",
  );
  assert.equal(quotePathForShell("C:\\plain\\x.txt", "bash.exe", true), "/c/plain/x.txt");
  assert.equal(quotePathForShell("C:\\a b\\it's", "pwsh.exe"), "'C:\\a b\\it''s'");
  // A typographic quote ends a PowerShell string too: doubled, so the name can't break out.
  assert.equal(quotePathForShell("C:\\x\\a’;calc;’", "pwsh.exe"), "'C:\\x\\a’’;calc;’’'");
  assert.equal(quotePathForShell("C:\\a b", "C:\\Windows\\System32\\cmd.exe"), '"C:\\a b"');
  assert.equal(quotePathForShell("/home/me/a b", "/bin/zsh"), "'/home/me/a b'");
});

test("the automation profile is the shell tasks run in, with its run flags", () => {
  assert.equal(parseAutomationProfile(null), null);
  assert.equal(parseAutomationProfile({}), null);
  assert.equal(parseAutomationProfile({ path: "  " }), null);
  assert.deepEqual(parseAutomationProfile({ path: "C:\\Program Files\\Git\\bin\\bash.exe" }), {
    executable: "C:\\Program Files\\Git\\bin\\bash.exe",
    args: ["-l", "-c"],
    env: {},
  });
  assert.deepEqual(
    parseAutomationProfile({
      path: ["cmd.exe", "x"],
      args: ["/D", "/C"],
      env: { A: "1", B: null },
    }),
    { executable: "cmd.exe", args: ["/D", "/C"], env: { A: "1", B: null } },
  );
  assert.deepEqual(parseAutomationProfile({ path: "pwsh", args: ["-NoProfile"] })?.args, [
    "-NoProfile",
    "-NoLogo",
    "-Command",
  ]);
  assert.deepEqual(shellRunFlags("/usr/bin/fish"), ["-l", "-c"]);
  assert.deepEqual(shellRunFlags("nu"), ["-c"]);
});

test("without an automation profile, tasks run in the default profile's shell (VS Code's rule)", () => {
  const profiles = resolveProfiles(
    { Mine: { path: "C:\\tools\\bash.exe", args: ["--login"], env: { A: "1" } } },
    detected,
  );
  assert.deepEqual(profileTaskShell(defaultProfile("Mine", profiles)), {
    executable: "C:\\tools\\bash.exe",
    args: ["--login", "-l", "-c"],
    env: { A: "1" },
  });
  assert.deepEqual(profileTaskShell(defaultProfile("PowerShell", profiles))?.args, [
    "-NoLogo",
    "-Command",
  ]);
  assert.equal(profileTaskShell(null), null);
  // Several candidates (Rust picks one when a terminal starts) or wsl.exe: the IDE's own shell.
  assert.equal(profileTaskShell({ ...profiles[0], path: ["a.exe", "b.exe"] } as never), null);
  assert.equal(
    profileTaskShell({ ...profiles[0], path: ["C:\\Windows\\System32\\wsl.exe"] } as never),
    null,
  );
});
