// D266: dev container configurations and the docker commands they become.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArgs,
  containerHost,
  containerLabels,
  execArgs,
  findArgs,
  imageName,
  needsCli,
  parseCliUp,
  parseContainerList,
  parseDevContainer,
  parseFound,
  parseRunId,
  runArgs,
  substitute,
} from "./devContainer";

const ctx = {
  localWorkspaceFolder: "/home/me/My App",
  configFile: "/home/me/My App/.devcontainer/devcontainer.json",
  env: { HOME: "/home/me" },
};

test("an image configuration gets VS Code's defaults", () => {
  const { config, errors } = parseDevContainer(
    `{
      // comments and trailing commas, as VS Code allows
      "name": "Node",
      "image": "mcr.microsoft.com/devcontainers/javascript-node:20",
      "forwardPorts": [3000, "db:5432", 70000],
      "postCreateCommand": "npm install",
      "remoteUser": "node",
    }`,
    ctx,
  );
  assert.deepEqual(errors, []);
  assert.equal(config?.workspaceFolder, "/workspaces/My App");
  assert.equal(
    config?.workspaceMount,
    "type=bind,source=/home/me/My App,target=/workspaces/My App,consistency=cached",
  );
  assert.deepEqual(config?.forwardPorts, [3000, 5432]);
  assert.equal(config?.postCreateCommand, "npm install");
  assert.equal(config?.overrideCommand, true);
  assert.equal(needsCli(config ?? ({} as never)), null);
});

test("variables, a Dockerfile relative to the configuration, mounts as objects", () => {
  const { config } = parseDevContainer(
    `{
      "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": 3 } },
      "workspaceFolder": "/src/\${localWorkspaceFolderBasename}",
      "containerEnv": { "HOME_THERE": "\${localEnv:HOME}", "MISSING": "\${localEnv:NOPE:fallback}" },
      "mounts": [{ "source": "cache", "target": "/cache", "type": "volume" }, "type=tmpfs,target=/tmp/x"],
      "remoteEnv": { "WS": "\${containerWorkspaceFolder}" }
    }`,
    ctx,
  );
  assert.deepEqual(config?.build, {
    dockerfile: "/home/me/My App/.devcontainer/Dockerfile",
    context: "/home/me/My App",
    args: { V: "3" },
  });
  assert.equal(config?.workspaceFolder, "/src/My App");
  assert.deepEqual(config?.containerEnv, { HOME_THERE: "/home/me", MISSING: "fallback" });
  assert.deepEqual(config?.mounts, [
    "type=volume,source=cache,target=/cache",
    "type=tmpfs,target=/tmp/x",
  ]);
  assert.deepEqual(config?.remoteEnv, { WS: "/src/My App" });
  assert.equal(substitute("${containerEnv:PATH}", ctx), "${containerEnv:PATH}");
});

test("what isn't a container configuration, and what needs the devcontainers CLI", () => {
  assert.match(parseDevContainer(`{ "name": "x" }`, ctx).errors[0] ?? "", /names no container/);
  assert.match(parseDevContainer(`{ "image": "x", }}`, ctx).errors[0] ?? "", /line 1/);
  assert.match(
    parseDevContainer(`{ "image": "x", "workspaceFolder": "src" }`, ctx).errors[0] ?? "",
    /absolute/,
  );
  const compose = parseDevContainer(
    `{ "dockerComposeFile": "compose.yml", "service": "app" }`,
    ctx,
  ).config;
  assert.deepEqual(compose?.dockerComposeFile, ["/home/me/My App/.devcontainer/compose.yml"]);
  assert.equal(needsCli(compose ?? ({} as never)), "Docker Compose configurations");
  const features = parseDevContainer(
    `{ "image": "x", "features": { "ghcr.io/devcontainers/features/go:1": {} } }`,
    ctx,
  ).config;
  assert.equal(needsCli(features ?? ({} as never)), "features");
});

test("the docker commands: find, build, run, lifecycle", () => {
  const { config } = parseDevContainer(
    `{
      "build": { "dockerfile": "Dockerfile", "target": "dev" },
      "runArgs": ["--cap-add=SYS_PTRACE"],
      "containerEnv": { "A": "1" },
      "remoteUser": "dev",
      "postStartCommand": { "server": "npm start", "watch": ["npm", "run", "watch"] }
    }`,
    ctx,
  );
  assert.ok(config);
  const labels = containerLabels(ctx.localWorkspaceFolder, ctx.configFile);
  assert.deepEqual(findArgs(labels).slice(0, 4), [
    "ps",
    "-a",
    "--filter",
    "label=devcontainer.local_folder=/home/me/My App",
  ]);
  const image = imageName(ctx.localWorkspaceFolder);
  assert.match(image, /^vsc-my-app-[0-9a-f]{8}$/);
  assert.deepEqual(buildArgs(config, image), [
    "build",
    "-f",
    "/home/me/My App/.devcontainer/Dockerfile",
    "-t",
    image,
    "--target",
    "dev",
    "/home/me/My App/.devcontainer",
  ]);
  const run = runArgs(config, image, labels);
  assert.deepEqual(run.slice(0, 2), ["run", "-d"]);
  assert.ok(run.includes("--cap-add=SYS_PTRACE"));
  assert.deepEqual(run.slice(run.indexOf("-e"), run.indexOf("-e") + 2), ["-e", "A=1"]);
  assert.deepEqual(run.slice(-5, -1), ["--entrypoint", "/bin/sh", image, "-c"]);
  const exec = execArgs(config, "abc123", config.postStartCommand ?? "");
  assert.deepEqual(exec, [
    ["exec", "-u", "dev", "-w", "/workspaces/My App", "abc123", "/bin/sh", "-c", "npm start"],
    ["exec", "-u", "dev", "-w", "/workspaces/My App", "abc123", "npm", "run", "watch"],
  ]);
});

test("docker's and the CLI's answers", () => {
  assert.deepEqual(parseFound("0123456789ab\texited\n"), { id: "0123456789ab", running: false });
  assert.equal(parseFound("Cannot connect to the Docker daemon"), null);
  assert.equal(parseRunId(`Unable to find image\npulling…\n${"a".repeat(64)}\n`), "a".repeat(64));
  assert.equal(parseRunId("error"), null);
  assert.deepEqual(
    parseCliUp(
      '[1 ms] Start\n{"outcome":"success","containerId":"f00d","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/x"}\n',
    ),
    { containerId: "f00d", remoteUser: "node", remoteWorkspaceFolder: "/workspaces/x" },
  );
  assert.deepEqual(parseCliUp('{"outcome":"error","message":"no daemon"}'), {
    error: "no daemon",
  });
  assert.equal(containerHost("0123456789abcdef", "node"), "node@0123456789ab");
  assert.equal(containerHost("0123456789abcdef", "bad user"), "0123456789ab");
  assert.deepEqual(
    parseContainerList(
      '{"ID":"0123456789ab","Names":"happy_app","Image":"node:20","Status":"Up 2 hours","Labels":"devcontainer.local_folder=/home/me/app,other=1"}\nnoise',
    ),
    [
      {
        id: "0123456789ab",
        name: "happy_app",
        image: "node:20",
        status: "Up 2 hours",
        localFolder: "/home/me/app",
      },
    ],
  );
});

test("Windows folders: the Dockerfile and context resolve with backslashes", () => {
  const win = {
    localWorkspaceFolder: "C:\\Users\\me\\app",
    configFile: "C:\\Users\\me\\app\\.devcontainer\\devcontainer.json",
    env: {},
  };
  const { config } = parseDevContainer(
    `{ "build": { "dockerfile": "Dockerfile", "context": ".." } }`,
    win,
  );
  assert.deepEqual(config?.build, {
    dockerfile: "C:\\Users\\me\\app\\.devcontainer\\Dockerfile",
    context: "C:\\Users\\me\\app",
    args: {},
  });
  assert.equal(config?.workspaceFolder, "/workspaces/app");
  assert.equal(
    config?.workspaceMount,
    "type=bind,source=C:\\Users\\me\\app,target=/workspaces/app,consistency=cached",
  );
});
