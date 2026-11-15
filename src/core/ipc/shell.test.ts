// What the window-only wrappers do where there is no window (this test runs in Node: importing
// the modules below, with the desktop framework's packages behind them, must not throw).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { dragDropIpc } from "./fs";
import { hasBackend, IpcError, isDesktopShell } from "./invoke";
import { createWindowlessShell, currentShell, setShell } from "./shell";
import { clipboardIpc, dialogIpc, openerIpc, windowIpc, wslIpc } from "./system";

afterEach(() => setShell(null));

test("without a window: controls do nothing, pickers choose nothing, questions refuse", async () => {
  assert.equal(isDesktopShell(), false);
  assert.equal(hasBackend(), false);

  await windowIpc.requestAttention();
  await windowIpc.focus();
  await windowIpc.minimize();
  await windowIpc.toggleMaximize();
  await windowIpc.unmaximize();
  await windowIpc.destroy();
  await windowIpc.setSize(640, 480);
  await windowIpc.setZoom(1.2);
  assert.equal(await windowIpc.isMaximized(), false);
  assert.equal(await windowIpc.isFullscreen(), false);
  assert.equal(await windowIpc.toggleFullscreen(), false);
  assert.deepEqual(await windowIpc.innerSize(), { width: 1280, height: 800 });
  (await windowIpc.onResized(() => assert.fail("never resized"))).dispose();
  (await windowIpc.onCloseRequested(async () => true)).dispose();
  assert.equal(await windowIpc.auxLabel(), null);

  assert.equal(await dialogIpc.pickFolder("Open folder"), null);
  assert.equal(
    await dialogIpc.pickFile("Open file", "/tmp", [{ name: "x", extensions: ["x"] }]),
    null,
  );
  assert.equal(await dialogIpc.pickPaths({ directory: false, multiple: true }), null);
  assert.equal(await dialogIpc.pickSavePath("Save as"), null);
  for (const question of [
    () => dialogIpc.confirm("Discard?", "Unsaved changes"),
    () => dialogIpc.ask("Sure?", "Question"),
  ]) {
    await assert.rejects(question(), (err: unknown) => {
      assert.ok(err instanceof IpcError);
      assert.equal(err.code, "Invalid");
      assert.match(err.message, /no window/);
      return true;
    });
  }

  (await dragDropIpc.listen(() => assert.fail("nothing is dropped"))).dispose();
  await openerIpc.revealInOs("/some/file");
  await assert.rejects(
    openerIpc.openUrl("https://example.com"),
    (err: unknown) => err instanceof IpcError && err.code === "Invalid",
  );
  // The link check comes first, with or without a window.
  await assert.rejects(openerIpc.openUrl("file:///etc/passwd"), /Not a web link/);

  // No backend either: the guarded calls answer empty instead of failing.
  assert.deepEqual(await wslIpc.distros(), []);
});

test("without a window the clipboard is a text buffer of the program's own", async () => {
  assert.equal(await clipboardIpc.readText(), "");
  await clipboardIpc.writeText("copied");
  assert.equal(await clipboardIpc.readText(), "copied");
  await clipboardIpc.writeText("again");
  assert.equal(await clipboardIpc.readText(), "again");
  assert.equal(await clipboardIpc.readImagePng(), null);
});

test("an error dialog without a window goes to the console", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await dialogIpc.error("The file is gone.", "Open file");
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, ["Open file: The file is gone."]);
});

test("a registered shell answers instead; null goes back to the default", async () => {
  const base = createWindowlessShell();
  const asked: string[] = [];
  setShell({
    ...base,
    dialog: {
      ...base.dialog,
      confirm: async (text, title, okLabel) => {
        asked.push(`${title}|${text}|${okLabel}`);
        return true;
      },
      pickFolder: async () => "/picked",
    },
    opener: { ...base.opener, openUrl: async (url) => void asked.push(url) },
  });
  assert.equal(await dialogIpc.confirm("Discard?", "Unsaved"), true);
  assert.equal(await dialogIpc.confirm("Delete?", "Files", "Delete"), true);
  assert.equal(await dialogIpc.pickFolder("Open"), "/picked");
  await openerIpc.openUrl("mailto:a@example.com");
  assert.deepEqual(asked, ["Unsaved|Discard?|OK", "Files|Delete?|Delete", "mailto:a@example.com"]);

  setShell(null);
  assert.equal(await dialogIpc.pickFolder("Open"), null);
  assert.equal(currentShell(), currentShell());
});
