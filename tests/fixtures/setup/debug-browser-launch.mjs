// tests/scripts/debug-browser-m6-97.jsonc: writes the folder's .vscode/launch.json with two browser
// configurations. The browser is the CI image's Chromium when it's there (Linux); elsewhere the
// IDE finds Chrome or Edge itself, as it would for a user.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const linuxChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = existsSync(linuxChromium) ? { runtimeExecutable: linuxChromium } : {};
const config = (type, name, page) => ({
  type,
  request: "launch",
  name,
  url: `http://127.0.0.1:11998/${page}`,
  webRoot: "${workspaceFolder}/site",
  ...browser,
  runtimeArgs: ["--headless=new", "--no-sandbox"],
});
mkdirSync(".vscode", { recursive: true });
writeFileSync(
  ".vscode/launch.json",
  `${JSON.stringify(
    {
      configurations: [
        config("chrome", "Page", "debug.html"),
        config("msedge", "Mapped", "mapped.html"),
      ],
    },
    null,
    2,
  )}\n`,
);
console.log("launch.json written");
