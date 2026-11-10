// The shim's quick input over live sessions (rpcQuickInput.ts) with a fake host: VS Code's
// QuickPick / InputBox events, showQuickPick / showInputBox on top, and the flows of real
// extensions (Jupyter's kernel picker, Python's interpreter picker, Python Environments' input box).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { toQuickInputEvent } from "../rpcQuickInput";
import {
  createInputBox,
  createQuickPick,
  showInputBox,
  showQuickPick,
  toValidation,
  toWireButton,
  toWireItems,
} from "./quickInput";
import { QuickInputButtons, QuickPickItemKind, ThemeIcon } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeHost() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 5000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: null }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.qi", version: "1.0.0" },
  );
  const requests = (method: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req" && m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const lastId = () => String(requests("quickInput.open").at(-1)?.id);
  /** The host reports an event of the latest session. */
  const send = async (event: Record<string, unknown>, id = lastId()) => {
    deliver({ t: "call", id: ++callId, kind: "provider", target: `quickInput.${id}`, args: event });
    await tick();
  };
  return { api, requests, send, lastId };
}

test("toWireItems: separators group the next item, icons, buttons, and the index map", () => {
  const { wire, map } = toWireItems([
    { label: "Recent", kind: QuickPickItemKind.Separator },
    { label: "$(star) First", description: "d", alwaysShow: true },
    "plain",
    { label: "Btn", buttons: [{ iconPath: new ThemeIcon("trash"), tooltip: "Remove" }] },
  ]);
  assert.deepEqual(map, [1, 2, 3]);
  assert.deepEqual(wire[0], {
    label: "First",
    icon: "star",
    description: "d",
    alwaysShow: true,
    separator: "Recent",
  });
  assert.deepEqual(wire[1], { label: "plain" });
  assert.deepEqual(wire[2]?.buttons, [{ icon: "trash", tooltip: "Remove" }]);
  assert.deepEqual(toWireButton(QuickInputButtons.Back), {
    icon: "arrow-left",
    tooltip: "Back",
    back: true,
  });
});

test("toValidation: a string is an error; Info and Warning severities", () => {
  assert.deepEqual(toValidation("bad"), { message: "bad", severity: "error" });
  assert.deepEqual(toValidation({ message: "hm", severity: 2 }), {
    message: "hm",
    severity: "warning",
  });
  assert.deepEqual(toValidation({ message: "fyi", severity: 1 }), {
    message: "fyi",
    severity: "info",
  });
  assert.equal(toValidation(""), null);
  assert.equal(toValidation(undefined), null);
});

test("toQuickInputEvent: checks what the host sends", () => {
  assert.deepEqual(toQuickInputEvent({ kind: "active", indexes: [1, -1, "x", 2] }), {
    kind: "active",
    indexes: [1, 2],
  });
  assert.equal(toQuickInputEvent({ kind: "button" }), null);
  assert.equal(toQuickInputEvent(null), null);
});

test("Jupyter's kernel picker: items and busy change while open, Refresh stays open, Back", async () => {
  const h = fakeHost();
  const qp = createQuickPick(h.api);
  const refresh = { iconPath: new ThemeIcon("refresh"), tooltip: "Refresh" };
  qp.buttons = [QuickInputButtons.Back, refresh];
  qp.busy = true;
  qp.show();
  await tick();
  const open = h.requests("quickInput.open")[0] as { props: Record<string, unknown> };
  assert.deepEqual(open.props.buttons, [
    { icon: "arrow-left", tooltip: "Back", back: true },
    { icon: "refresh", tooltip: "Refresh" },
  ]);
  assert.equal(open.props.busy, true);
  const triggered: unknown[] = [];
  qp.onDidTriggerButton((b) => triggered.push(b));
  const a = { label: "Python 3.12" };
  qp.items = [a];
  await tick();
  const b = { label: "Python 3.13" };
  qp.items = [a, b];
  qp.busy = false;
  await tick();
  assert.equal(h.requests("quickInput.update").length, 2);
  await h.send({ kind: "button", index: 1 });
  assert.deepEqual(triggered, [refresh]);
  assert.equal(h.requests("quickInput.hide").length, 0, "a button doesn't close it");
  await h.send({ kind: "button", index: 0 });
  assert.equal(triggered[1], QuickInputButtons.Back);
  let picked: unknown;
  qp.onDidChangeSelection((s) => (picked = s[0]));
  await h.send({ kind: "selection", indexes: [1] });
  assert.equal(picked, b, "the extension's own item object");
});

test("Python's interpreter picker: Enter with nothing matching accepts the typed path", async () => {
  const h = fakeHost();
  const qp = createQuickPick(h.api);
  qp.items = [{ label: "Enter interpreter path…" }];
  qp.show();
  let accepted: string | undefined;
  qp.onDidAccept(() => (accepted = qp.value));
  await h.send({ kind: "value", value: "C:\\Python\\python.exe" });
  await h.send({ kind: "active", indexes: [] });
  await h.send({ kind: "accept" });
  assert.equal(accepted, "C:\\Python\\python.exe");
});

test("Python Environments' input box: async validation in onDidAccept, then hide", async () => {
  const h = fakeHost();
  const box = createInputBox(h.api);
  box.prompt = "Name";
  box.show();
  let hidden = 0;
  box.onDidHide(() => hidden++);
  box.onDidAccept(async () => {
    await tick();
    if (box.value.includes(" ")) box.validationMessage = "No spaces";
    else box.hide();
  });
  await h.send({ kind: "value", value: "my env" });
  await h.send({ kind: "accept" });
  await tick();
  const updates = h.requests("quickInput.update").map((u) => u.props as Record<string, unknown>);
  assert.deepEqual(updates.at(-1)?.validation, { message: "No spaces", severity: "error" });
  assert.equal(h.requests("quickInput.hide").length, 0);
  await h.send({ kind: "value", value: "myenv" });
  await h.send({ kind: "accept" });
  await tick();
  assert.equal(h.requests("quickInput.hide").length, 1);
  await h.send({ kind: "hide" });
  assert.equal(hidden, 1);
});

test("showQuickPick: strings back as strings; canPickMany with picked items; cancel", async () => {
  const h = fakeHost();
  const one = showQuickPick(h.api, ["a", "b"]);
  await tick();
  await h.send({ kind: "selection", indexes: [1] });
  assert.equal(await one, "b");
  await tick();
  await h.send({ kind: "hide" }, String(h.requests("quickInput.open")[0]?.id));

  const many = showQuickPick(
    h.api,
    Promise.resolve([{ label: "x", picked: true }, { label: "y" }, { label: "z", picked: true }]),
    { canPickMany: true },
  );
  await tick();
  await tick();
  const open = h.requests("quickInput.open").at(-1) as { props: Record<string, unknown> };
  assert.equal(open.props.busy, true, "busy while the items load");
  const fill = h.requests("quickInput.update").at(-1) as { props: Record<string, unknown> };
  assert.deepEqual(fill.props.selectedIndexes, [0, 2]);
  await h.send({ kind: "selection", indexes: [1, 2] });
  await h.send({ kind: "accept" });
  assert.deepEqual(
    ((await many) as { label: string }[]).map((i) => i.label),
    ["y", "z"],
  );

  const cancelled = showQuickPick(h.api, ["q"]);
  await tick();
  await h.send({ kind: "hide" });
  assert.equal(await cancelled, undefined);
});

test("showInputBox: live validation, Info doesn't block, Error does", async () => {
  const h = fakeHost();
  const answer = showInputBox(h.api, {
    value: "ab",
    validateInput: (v) =>
      v.length < 3 ? "Too short" : v === "abc" ? { message: "Fine", severity: 1 } : undefined,
  });
  await tick();
  await tick();
  const validations = () =>
    h
      .requests("quickInput.update")
      .map((u) => (u.props as Record<string, unknown>).validation)
      .filter((v) => v !== undefined);
  assert.deepEqual(validations().at(-1), { message: "Too short", severity: "error" });
  await h.send({ kind: "accept" });
  await tick();
  await h.send({ kind: "value", value: "abc" });
  await tick();
  assert.deepEqual(validations().at(-1), { message: "Fine", severity: "info" });
  await h.send({ kind: "accept" });
  assert.equal(await answer, "abc");
});

test("dispose hides a shown session and onDidHide still fires", async () => {
  const h = fakeHost();
  const qp = createQuickPick(h.api);
  let hidden = 0;
  qp.onDidHide(() => hidden++);
  qp.show();
  qp.dispose();
  await tick();
  assert.equal(h.requests("quickInput.hide").length, 1);
  await h.send({ kind: "hide" });
  assert.equal(hidden, 1);
});

test("audit: a validateInput that throws doesn't leave the box disabled after Enter", async () => {
  const h = fakeHost();
  const answer = showInputBox(h.api, {
    value: "x",
    validateInput: () => {
      throw new Error("validator bug");
    },
  });
  await tick();
  await h.send({ kind: "accept" });
  await tick();
  assert.equal(await answer, "x");
});
