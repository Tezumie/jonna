// The screenless entry, run where there is no page at all: Node, with no DOM shim. `document`
// and `window` never exist: the fake backend is a transport in the call layer, so a use of
// either fails where it is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { CommandError } from "../core/dispatcher/index";
import { builtinExtensions } from "../extensions/builtins";
import { createWorkbenchExtension } from "../extensions/workbench/index";
import { bootHeadless, type HeadlessSession } from "./boot";
import { type FakeBackend, fakeBackend } from "./fakeBackend";
import { type MemoryHost, memoryHost } from "./memoryHost";
import type { HeadlessPolicy } from "./services";

/** Every built-in, the agent's too (its setup runs without its views). */
const extensions = () => builtinExtensions(createWorkbenchExtension(null));

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** What a failure for want of a screen looks like in a message. */
const SCREEN_FAILURE = /is not defined|needs a screen|there is no screen/;

interface Started {
  session: HeadlessSession;
  backend: FakeBackend;
  host: MemoryHost;
  /** console.error / console.warn lines and unhandled rejections since the start. */
  problems: string[];
  stop(): Promise<void>;
}

async function start(policy?: HeadlessPolicy): Promise<Started> {
  const host = memoryHost({
    files: { "/ws/README.md": "# Hello\n", "/ws/src/a.ts": "export const a = 1;\n" },
  });
  const backend = fakeBackend({
    ...host.commands,
    fs_create_file: (args) => {
      const path = `${String(args.parent)}/${String(args.name)}`;
      host.files.set(path, "");
      return path;
    },
  });
  const problems: string[] = [];
  const text = (value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const { error, warn } = console;
  console.error = (...args: unknown[]) => void problems.push(args.map(text).join(" "));
  console.warn = (...args: unknown[]) => void problems.push(args.map(text).join(" "));
  const onRejection = (reason: unknown) => void problems.push(`unhandled: ${text(reason)}`);
  process.on("unhandledRejection", onRejection);
  const session = await bootHeadless({
    backend,
    extensions: extensions(),
    folder: "/ws",
    ...(policy && { policy }),
  });
  /** Until the backend has heard nothing for a moment: what the session started has finished. */
  const quiet = async () => {
    for (let calls = -1; calls !== backend.calls.length; ) {
      calls = backend.calls.length;
      await wait(200);
    }
  };
  // What extensions start when the folder opens (reading its files, asking the backend).
  await quiet();
  return {
    session,
    backend,
    host,
    problems,
    stop: async () => {
      // Work under way isn't cancelled by a dispose: let it finish while there is a backend.
      await quiet();
      await session.dispose();
      await wait(50);
      process.off("unhandledRejection", onRejection);
      console.error = error;
      console.warn = warn;
    },
  };
}

test("every built-in extension, the agent's too, activates with no screen", async () => {
  // The proof this runs without a page: there is none in this realm, and none is made.
  assert.equal(typeof document, "undefined");
  assert.equal(typeof window, "undefined");
  const { session, problems, stop } = await start();
  try {
    assert.deepEqual(
      session.extensions.filter((e) => e.error),
      [],
    );
    assert.equal(session.extensions.length, extensions().length);
    assert.ok(session.extensions.length >= 26);
    // Nothing made a window, and nothing failed for want of a page where the failure was only
    // logged.
    assert.equal(typeof window, "undefined");
    assert.deepEqual(
      problems.filter((line) => SCREEN_FAILURE.test(line)),
      [],
    );
    assert.equal(typeof document, "undefined");
    assert.equal(session.folder, "/ws");
    assert.equal(session.folderError, null);
    const { services } = session;
    assert.equal(services.hasScreen, false);
    assert.equal(services.workspace.root.peek(), "/ws");
    // The backend's machine is the only one there is.
    assert.equal(services.backendPlatform, "linux");
    assert.equal(services.screenPlatform, "linux");
    // Views are registered (their descriptors), and none was made.
    assert.ok(services.views.get("explorer.view"));
    assert.ok(services.dispatcher.list().length > 500);
  } finally {
    await stop();
  }
  // Still nothing of a page after the session ended.
  assert.equal(typeof document, "undefined");
  assert.equal(typeof window, "undefined");
});

test("commands run through the dispatcher and state is read, with no screen", async () => {
  const { session, host, stop } = await start();
  const { dispatcher, state } = session.services;
  try {
    // State the workspace and the workbench extension publish.
    const workspace = (await state.get("ide://workspace")).value as { root: string | null };
    assert.equal(workspace.root, "/ws");
    const statusbar = JSON.stringify((await state.get("ide://statusbar")).value);
    assert.match(statusbar, /workspace\.folder/);

    // A command that changes the layout model, seen in ide://layout.
    const sidebar = async () =>
      ((await state.get("ide://layout")).value as { sidebar: { visible: boolean } }).sidebar
        .visible;
    const before = await sidebar();
    await dispatcher.execute("layout.toggleSidebar");
    assert.equal(await sidebar(), !before);

    // A command that reads a file through the backend.
    const read = await dispatcher.execute<{ text: string }>("editor.getText", {
      path: "/ws/src/a.ts",
    });
    assert.equal(read.text, "export const a = 1;\n");

    // A command that writes a setting (the user's settings file, through the backend).
    await dispatcher.execute("settings.set", { key: "editor.tabSize", value: 3 });
    assert.equal(session.services.settings.peek<number>("editor.tabSize"), 3);
    assert.match(host.files.get("/config/settings.json") ?? "", /"editor\.tabSize": 3/);

    // A command marked as needing a screen is refused before it runs, and says why.
    assert.equal(dispatcher.info("window.minimize")?.needsScreen, true);
    assert.equal(dispatcher.info("layout.toggleSidebar")?.needsScreen, undefined);
    await assert.rejects(
      dispatcher.execute("window.minimize"),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "Disabled" &&
        /needs a screen/.test(err.message),
    );

    // A command that asks a question fails with the question, not with a missing global, and
    // the failure is a notice in the list (the window would show a toast).
    await assert.rejects(
      dispatcher.execute("explorer.newFile"),
      (err: unknown) => err instanceof CommandError && /needs a screen/.test(err.message),
    );
    const notices = (await state.get("ide://notifications")).value as {
      items: { kind: string; message: string }[];
    };
    assert.ok(notices.items.some((n) => n.kind === "error" && /needs a screen/.test(n.message)));
    assert.equal(session.screenless.quickInput.asked.length, 1);

    // Trust asks nobody: the folder stays undecided and what needs trust doesn't run.
    await assert.rejects(session.services.trust.require("Task “build”"), /restricted mode/);
    assert.equal(session.services.trust.state.peek(), "unknown");

    // Every command went to the audit log, as in the window.
    assert.ok(host.audit.some((entry) => entry.includes("layout.toggleSidebar")));
    assert.equal(typeof window, "undefined");
    // The open workspace's saved state (the window's layout) is never written from here.
    await session.services.persistence.flush();
    assert.equal(host.state.has("workspace"), false);
  } finally {
    await stop();
  }
});

test("a policy answers what a person would be asked", async () => {
  const { session, host, stop } = await start({
    quickInput: { prompt: (options) => (/New file/.test(options.prompt) ? "notes.md" : undefined) },
    trust: { folder: "trust" },
  });
  try {
    // The name comes from the policy and the file is made. Showing it in an editor is the part
    // that needs a screen, and the command says so.
    await assert.rejects(session.services.dispatcher.execute("explorer.newFile"), /needs a screen/);
    assert.equal(host.files.get("/ws/notes.md"), "");
    await session.services.trust.require("Task “build”");
    assert.equal(session.services.trust.state.peek(), "trusted");
    // Remembered where the window remembers it: the shared global state.
    assert.match(host.state.get("global") ?? "", /\/ws/);
  } finally {
    await stop();
  }
});

test("the screenless entry imports no view code", () => {
  // Value imports only: a type-only import is erased and brings nothing at run time.
  const root = resolve("src");
  const seen = new Set<string>();
  const queue = [join(root, "headless", "boot.ts")];
  const importPattern = /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const target = join(dirname(file), match[1] ?? "");
      if (/\.(css|svg|json)$/.test(target) || target.includes("?")) {
        seen.add(target);
        continue;
      }
      queue.push(target.endsWith(".ts") ? target : `${target}.ts`);
    }
  }
  const local = [...seen].map((file) =>
    file
      .slice(root.length + 1)
      .split("\\")
      .join("/"),
  );
  assert.ok(local.includes("workbench/createServices.ts"));
  assert.deepEqual(
    local.filter((file) => /^ui\/|^core\/dom\/|\.css$|^extensions\/|\/view\//.test(file)),
    [],
  );
});
