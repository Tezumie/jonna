// D256: a VS Code package with code, in the IDE's shapes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "./thirdParty";
import {
  camelSegment,
  declarativeOnly,
  dispatcherCommandId,
  localizePackage,
  selectorExtensions,
  whenKeys,
} from "./vscodePackage";

const PACKAGE = {
  publisher: "Acme",
  name: "md-tools",
  version: "1.2.0",
  displayName: "%displayName%",
  main: "./out/extension",
  activationEvents: ["onStartupFinished"],
  contributes: {
    commands: [
      {
        command: "mdTools.preview",
        title: "%preview.title%",
        category: "Markdown",
        icon: "$(open-preview)",
      },
      { command: "markdown-tools.toc", title: "Insert table of contents" },
      { command: "helloWorld", title: "Hello" },
      { command: "mdTools.internal", title: "Internal" },
    ],
    configuration: {
      title: "Markdown tools",
      properties: {
        "mdTools.enable": { type: "boolean", default: true, description: "Turns it on" },
        "mdTools.path": {
          type: ["string", "null"],
          default: null,
          scope: "machine",
          markdownDescription: "The **path**",
        },
        "mdTools.mode": { enum: ["a", "b"], default: "a" },
        "editor.fontSize": { type: "number", default: 3 },
      },
    },
    keybindings: [
      {
        command: "mdTools.preview",
        key: "ctrl+k v",
        mac: "cmd+k v",
        when: "editorLangId == markdown",
      },
      { command: "workbench.action.quickOpen", key: "ctrl+p" },
    ],
    viewsContainers: { activitybar: [{ id: "md", title: "Markdown", icon: "media/md.svg" }] },
    views: {
      explorer: [{ id: "mdTools.outline", name: "Headings" }],
      md: [
        { id: "mdTools.links", name: "Links" },
        { id: "mdTools.page", name: "Page", type: "webview" },
      ],
    },
    menus: {
      commandPalette: [{ command: "mdTools.internal", when: "false" }],
      "editor/title": [
        { command: "mdTools.preview", group: "navigation", when: "resourceLangId == markdown" },
      ],
      "view/item/context": [{ command: "markdown-tools.toc", when: "view == mdTools.links" }],
      "scm/title": [{ command: "mdTools.preview" }],
    },
    languages: [{ id: "mdx", extensions: [".mdx"] }],
  },
};

test("package.nls.json's text replaces %key% strings", () => {
  const out = localizePackage(
    { a: "%x%", b: ["%y%", "%none%"], c: { d: "keep %x% inside" } },
    { x: "Ex", y: { message: "Why", comment: ["…"] } },
  );
  assert.deepEqual(out, { a: "Ex", b: ["Why", "%none%"], c: { d: "keep %x% inside" } });
});

test("VS Code's command ids as the dispatcher's", () => {
  assert.equal(dispatcherCommandId("eslint.restart", "ns"), "eslint.restart");
  assert.equal(dispatcherCommandId("markdown-preview.open", "ns"), "markdownPreview.open");
  assert.equal(dispatcherCommandId("helloWorld", "acmeX"), "acmeX.helloWorld");
  assert.equal(dispatcherCommandId("_internal.do-it", "ns"), "internal.doIt");
  assert.equal(camelSegment("1c-tools"), "x1cTools");
});

test("a VS Code package with code runs in Node with its commands, settings, keys, views and menus", () => {
  const m = parseManifest(
    localizePackage(PACKAGE, { displayName: "Markdown tools", "preview.title": "Open preview" }),
    "package.json",
  );
  assert.equal(m.id, "acme.md-tools");
  assert.equal(m.format, "vscode");
  assert.equal(m.host, "node");
  assert.equal(m.main, "out/extension");
  assert.equal(m.displayName, "Markdown tools");
  assert.ok(m.permissions.includes("node") && m.permissions.includes("shell"));
  const commands = m.contributes.commands;
  assert.deepEqual(
    commands.map((c) => [c.id, c.vscodeId, c.title]),
    [
      ["mdTools.preview", undefined, "Open preview"],
      ["markdownTools.toc", "markdown-tools.toc", "Insert table of contents"],
      ["mdTools.helloWorld", "helloWorld", "Hello"],
      ["mdTools.internal", undefined, "Internal"],
      ["mdTools.runVscodeCommand", undefined, "Run a command of the extension"],
    ],
  );
  assert.equal(commands.find((c) => c.id === "mdTools.internal")?.palette, false);
  assert.equal(commands.find((c) => c.id === "mdTools.runVscodeCommand")?.agent, "hidden");

  const s = m.contributes.settings;
  // VS Code reserves no names: the IDE's own key is declared too (the runtime shares it).
  assert.deepEqual(Object.keys(s), [
    "mdTools.enable",
    "mdTools.path",
    "mdTools.mode",
    "editor.fontSize",
  ]);
  assert.equal(s["mdTools.path"]?.type, "string");
  assert.equal(s["mdTools.path"]?.scope, "user");
  assert.equal(s["mdTools.path"]?.description, "The **path**");
  assert.equal(s["mdTools.mode"]?.type, "string");
  assert.equal(s["mdTools.enable"]?.category, "Markdown tools");

  assert.deepEqual(m.contributes.keybindings, [
    {
      key: "ctrl+k v",
      command: "mdTools.preview",
      mac: "cmd+k v",
      when: "editorLangId == markdown",
    },
    // VS Code's own command: resolved when the extension loads.
    {
      key: "ctrl+p",
      command: "workbench.action.quickOpen",
      vscodeCommand: "workbench.action.quickOpen",
    },
  ]);
  assert.ok(m.warnings?.some((w) => w.includes(`"editor."`)));
  assert.deepEqual(
    m.contributes.views.map((v) => [v.id, v.title, v.location, v.sectionOf]),
    [
      ["mdTools.outline", "Headings", "sidebar", "explorer.view"],
      ["mdTools.links", "Markdown: Links", "sidebar", undefined],
      // A webview view: its page comes from its code (D257).
      ["mdTools.page", "Markdown: Page", "sidebar", undefined],
    ],
  );
  assert.deepEqual(
    m.contributes.menus.map((x) => [x.location, x.command, x.icon]),
    [
      ["editor/title", "mdTools.preview", "open-preview"],
      ["view/item/context", "markdownTools.toc", undefined],
    ],
  );
  // mdx has no `configuration`: no implicit onLanguage (VS Code's languageService.ts, D295).
  assert.deepEqual(m.activation, ["onStartupFinished"]);
  assert.ok(m.contextNamespaces?.includes("mdTools"));
  assert.ok(m.contextNamespaces?.includes("markdown-tools"));
  assert.ok(!m.contextNamespaces?.includes("editor"));
});

test("without activation events it waits for its commands; without code it stays declarative", () => {
  const { activationEvents: _a, ...rest } = PACKAGE;
  const noEvents = parseManifest(
    { ...rest, contributes: { commands: PACKAGE.contributes.commands } },
    "package.json",
  );
  assert.deepEqual(noEvents.activation, ["onCommand"]);
  const { main: _m, ...declarative } = PACKAGE;
  const themeOnly = parseManifest(declarative, "package.json");
  assert.equal(themeOnly.host, undefined);
  assert.equal(themeOnly.main, undefined);
  assert.deepEqual(themeOnly.contributes.commands, []);
  assert.deepEqual(themeOnly.permissions, []);
});

test("D257: custom editors, webview views, notebooks, debuggers and tasks of a package with code", () => {
  const m = parseManifest(
    {
      publisher: "acme",
      name: "draw",
      version: "1.0.0",
      main: "./out/extension.js",
      contributes: {
        customEditors: [
          {
            viewType: "acme.draw",
            displayName: "Draw",
            selector: [{ filenamePattern: "*.{drawio,dio}" }],
          },
          {
            viewType: "acme.svg",
            displayName: "SVG",
            selector: [{ filenamePattern: "**/*.svg" }],
            priority: "option",
          },
        ],
        viewsContainers: { panel: [{ id: "drawPanel", title: "Draw" }] },
        views: { drawPanel: [{ id: "acme.preview", name: "Preview", type: "webview" }] },
        notebooks: [
          { type: "acme-nb", displayName: "Acme", selector: [{ filenamePattern: "*.acnb" }] },
        ],
        notebookRenderer: [
          {
            id: "acme.r",
            displayName: "R",
            entrypoint: "./out/r.js",
            mimeTypes: ["x-application/acme"],
          },
        ],
        debuggers: [
          { type: "acme-debug", label: "Acme", program: "./out/adapter.js", runtime: "node" },
        ],
        taskDefinitions: [
          { type: "acme", required: ["target"], properties: { target: { type: "string" } } },
        ],
        themes: [{ label: "Acme", uiTheme: "vs-dark", path: "./t.json" }],
      },
    },
    "package.json",
  );
  const c = m.contributes;
  assert.deepEqual(
    c.viewers.map((v) => [v.id, v.extensions, v.default, v.codePage, v.path]),
    [
      ["acme.draw", [".drawio", ".dio"], true, true, undefined],
      ["acme.svg", [".svg"], false, true, undefined],
    ],
  );
  assert.deepEqual(
    c.views.map((v) => [v.id, v.location, v.type, v.codePage]),
    [["acme.preview", "panel", "webview", true]],
  );
  assert.deepEqual(c.notebooks, [
    { type: "acme-nb", displayName: "Acme", extensions: [".acnb"], default: true },
  ]);
  assert.equal(c.notebookRenderers[0]?.entrypoint, "out/r.js");
  assert.equal(c.debuggers[0]?.type, "acme-debug");
  assert.equal(c.taskDefinitions[0]?.type, "acme");
  // Waiting for permission: only the theme stays.
  const waiting = declarativeOnly(m);
  assert.equal(
    waiting.contributes.viewers.length +
      waiting.contributes.debuggers.length +
      waiting.contributes.views.length,
    0,
  );
  assert.equal(waiting.contributes.themes.length, 1);
  assert.deepEqual(
    selectorExtensions([{ filenamePattern: "readme.md" }, { filenamePattern: "*.csv" }]),
    [".csv"],
  );
});

test("D258: language model tools are commands the agent sees as tools", () => {
  const m = parseManifest(
    {
      publisher: "acme",
      name: "weather",
      version: "1.0.0",
      main: "./out/extension.js",
      contributes: {
        languageModelTools: [
          {
            name: "get_weather",
            displayName: "Get weather",
            modelDescription: "The weather in a city.",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    },
    "package.json",
  );
  const tool = m.contributes.commands.find((c) => c.vscodeTool === "get_weather");
  assert.equal(tool?.id, "weather.tool.getWeather");
  assert.equal(tool?.description, "The weather in a city.");
  assert.equal(tool?.palette, false);
  assert.deepEqual(m.contributes.agentTools, ["weather.tool.getWeather"]);
});

test("D260: views' and containers' when clauses, icon files and the secondary side bar", () => {
  const m = parseManifest(
    {
      publisher: "anthropic",
      name: "claude-code",
      version: "2.1.0",
      main: "./extension.js",
      engines: { vscode: "^1.94.0" },
      contributes: {
        commands: [{ command: "claude-vscode.editor.open", title: "Open" }],
        viewsContainers: {
          activitybar: [
            {
              id: "claude-sidebar",
              title: "Claude Code",
              icon: "resources/claude-logo.svg",
              when: "claude-code:doesNotSupportSecondarySidebar",
            },
            {
              id: "claude-sessions-sidebar",
              title: "Claude Code",
              icon: "resources/claude-logo.svg",
              when: "claude-vscode.sessionsListEnabled",
            },
          ],
          secondarySidebar: [
            {
              id: "claude-sidebar-secondary",
              title: "Claude Code",
              icon: "resources/claude-logo.svg",
              when: "!claude-code:doesNotSupportSecondarySidebar",
            },
          ],
        },
        views: {
          "claude-sidebar": [
            {
              type: "webview",
              id: "claudeVSCodeSidebar",
              name: "Claude Code",
              when: "claude-code:doesNotSupportSecondarySidebar",
            },
          ],
          "claude-sidebar-secondary": [
            { type: "webview", id: "claudeVSCodeSidebarSecondary", name: "Claude Code" },
          ],
          "claude-sessions-sidebar": [
            {
              type: "webview",
              id: "claudeVSCodeSessionsList",
              name: "",
              when: "config.claudeCode.listMode",
            },
          ],
        },
      },
    },
    "package.json",
  );
  assert.deepEqual(
    m.contributes.views.map((v) => [v.id, v.title, v.location, v.iconPath, v.when]),
    [
      [
        "claudeVSCodeSidebar",
        "Claude Code",
        "sidebar",
        "resources/claude-logo.svg",
        "claude-code:doesNotSupportSecondarySidebar",
      ],
      [
        "claudeVSCodeSidebarSecondary",
        "Claude Code",
        "secondary",
        "resources/claude-logo.svg",
        "!claude-code:doesNotSupportSecondarySidebar",
      ],
      // No name: the container's title.
      [
        "claudeVSCodeSessionsList",
        "Claude Code",
        "sidebar",
        "resources/claude-logo.svg",
        "(claude-vscode.sessionsListEnabled) && (config.claudeCode.listMode)",
      ],
    ],
  );
  // Keys its views test are its own to set; "config" (VS Code's settings) isn't.
  assert.ok(m.contextNamespaces?.includes("claude-vscode"));
  assert.ok(m.contextNamespaces?.includes("claude-code"));
  assert.ok(!m.contextNamespaces?.includes("config"));
});

test("D260: the keys a when clause tests", () => {
  assert.deepEqual(whenKeys("a && !b.c == 'x.y' || (d:e =~ /f.g/i) && true"), ["a", "b.c", "d:e"]);
  assert.deepEqual(whenKeys(""), []);
});
