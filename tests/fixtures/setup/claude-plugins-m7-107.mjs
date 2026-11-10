// D375 (agent-plugins-cc-m7-107): a Claude Code folder with one installed plugin and one
// marketplace, in <work>/claude-home (the test runner points CLAUDE_CONFIG_DIR there for every
// test). The plugin brings a command, an output style and a language server.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const work = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(work, "claude-home");
const plugin = join(home, "plugins", "cache", "pkgt-market", "pkgt-styler", "1.0.0");
const market = join(home, "plugins", "marketplaces", "pkgt-market");
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

write(
  join(plugin, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "pkgt-styler", version: "1.0.0", description: "PkgT test plugin" }),
);
write(join(plugin, "commands", "shout.md"), "Say it loudly: $ARGUMENTS\n");
write(
  join(plugin, "output-styles", "pkgt-terse.md"),
  "---\nname: PkgT terse\ndescription: Very short answers\n---\n\nAnswer in one line.\n",
);
write(
  join(plugin, ".lsp.json"),
  JSON.stringify({
    pkgt: { command: "pkgt-ls", args: ["--stdio"], extensionToLanguage: { ".pkgt": "plaintext" } },
  }),
);
write(
  join(home, "plugins", "installed_plugins.json"),
  JSON.stringify({
    version: 2,
    plugins: {
      "pkgt-styler@pkgt-market": [{ scope: "user", installPath: plugin, version: "1.0.0" }],
    },
  }),
);
write(
  join(market, ".claude-plugin", "marketplace.json"),
  JSON.stringify({
    name: "pkgt-market",
    plugins: [{ name: "pkgt-styler", source: "./plugins/pkgt-styler" }],
  }),
);
write(
  join(home, "plugins", "known_marketplaces.json"),
  JSON.stringify({ "pkgt-market": { installLocation: market } }),
);
write(
  join(home, "settings.json"),
  JSON.stringify({ enabledPlugins: { "pkgt-styler@pkgt-market": true }, env: { SECRET: "x" } }),
);
console.log("claude home ready");
