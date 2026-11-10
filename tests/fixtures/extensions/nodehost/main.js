// D255: runs in Node (manifest "host": "node"): Node's built-ins and its own modules, plus `ide`.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shout } = require("./lib/helper");

exports.activate = (ide) => {
  // Printed output goes to the extension's log, not onto the host's protocol.
  console.log("node host started");
  process.stdout.write("written to stdout\n");

  ide.commands.register("nodehost.info", async () => ({
    node: process.version,
    platform: os.platform(),
    helper: shout("hi"),
    inNode: typeof require === "function" && typeof process.versions.node === "string",
    folders: (await ide.workspace.folders()).length,
  }));

  ide.commands.register("nodehost.readme", async () => {
    const [folder] = await ide.workspace.folders();
    const file = path.join(folder.path, "README.md");
    return {
      viaFs: fs.readFileSync(file, "utf8").split(/\r?\n/)[0],
      viaIde: (await ide.editor.text(file)).split(/\r?\n/)[0],
    };
  });
};
