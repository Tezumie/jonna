// D267: a product icon theme extension for productIcons-m7-25, made next to the test folder
// (argv[2]): its font is Windows' own Segoe MDL2 Assets (copied, not kept in the repository),
// with glyphs for VS Code's "files", "search" and "settings-gear" codicons.
const fs = require("node:fs");
const path = require("node:path");

const dest = path.resolve(process.argv[2] ?? "../producticons");
const font = path.join(process.env.SystemRoot ?? "C:\\Windows", "Fonts", "segmdl2.ttf");
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(font, path.join(dest, "icons.ttf"));
fs.writeFileSync(
  path.join(dest, "package.json"),
  JSON.stringify(
    {
      publisher: "acme",
      name: "product-icons",
      displayName: "Acme glyphs",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      contributes: {
        productIconThemes: [{ id: "acme-glyphs", label: "Acme glyphs", path: "./theme.json" }],
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(dest, "theme.json"),
  JSON.stringify(
    {
      fonts: [{ id: "mdl2", src: [{ path: "./icons.ttf", format: "truetype" }] }],
      iconDefinitions: {
        files: { fontCharacter: "\\E8A5" },
        search: { fontCharacter: "\\E721" },
        "settings-gear": { fontCharacter: "\\E713" },
      },
    },
    null,
    2,
  ),
);
console.log(`made ${dest}`);
