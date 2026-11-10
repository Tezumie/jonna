// D295: a VS Code controller talks with its notebooks' output page (the notebookMessaging
// proposal): postMessage(message, editor) goes to the host for that notebook's page, and a
// preload's postKernelMessage reaches onDidReceiveMessage with the notebook's editor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { createVscodeShim, type ShimFileSystem } from "./index";
import { kernelSourceId } from "./notebooks";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const defaults: Record<string, (p: Record<string, unknown>) => unknown> = {
    "settings.get": () => null,
    "state.get": () => ({ documents: [] }),
    "workspace.isTrusted": () => true,
  };
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req") {
          const answer = answers[m.method] ?? defaults[m.method];
          queueMicrotask(() =>
            deliver({
              t: "res",
              id: m.id,
              ok: true,
              value: answer ? answer(m.params as Record<string, unknown>) : null,
            }),
          );
        }
      },
      onMessage: (h) => (deliver = h),
    },
    {
      id: "ms-toolsai.jupyter",
      version: "1.0.0",
      path: "/ext",
      appName: "Studio",
      workspace: { folders: [{ path: "/ws", name: "ws", index: 0 }], name: "ws", file: null },
    },
  );
  const requests = (method?: string) =>
    sent.filter((m): m is RequestMessage => m.t === "req" && (!method || m.method === method));
  let callId = 1000;
  const call = async (target: string, args?: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "notebook", target, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const res = sent.find((m) => m.t === "res" && m.id === id);
      if (res && res.t === "res") {
        if (!res.ok) throw new Error(res.error);
        return res.value;
      }
    }
    throw new Error(`no answer to ${target}`);
  };
  const fs: ShimFileSystem = {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async () => [],
    createDirectory: async () => {},
    delete: async () => {},
    rename: async () => {},
    copy: async () => {},
  };
  const shim = createVscodeShim({
    ide: api,
    init: { commands: [], shimCommand: "", settings: [] },
    packageJSON: { publisher: "ms-toolsai", name: "jupyter" },
    extensionPath: "/ext",
    globalStoragePath: "/data/global",
    logPath: "/data/logs",
    fs,
    shell: "/bin/sh",
    log: () => {},
  });
  return { shim, vscode: shim.vscode, requests, call };
}

test("D295: a controller's messages go to its notebook's page and come back from it", async () => {
  const h = harness({ "notebooks.kernelPost": () => true });
  await h.shim.ready();
  const v = h.vscode as unknown as {
    notebooks: {
      createNotebookController(
        id: string,
        type: string,
        label: string,
      ): {
        postMessage(message: unknown, editor?: unknown): Promise<boolean>;
        onDidReceiveMessage(l: (e: { editor: { notebook: unknown }; message: unknown }) => void): {
          dispose(): void;
        };
      };
    };
    Uri: { file(p: string): unknown };
  };
  const controller = v.notebooks.createNotebookController(
    "jupyter-kernel",
    "jupyter-notebook",
    "Python 3",
  );
  await tick();
  const reg = h.requests("notebooks.registerKernelSource")[0]?.params as {
    id: string;
    messaging?: boolean;
  };
  // Its kernel source has an id of its own (the controller id may hold a path).
  const sourceId = kernelSourceId("jupyter-kernel", "jupyter-notebook");
  assert.equal(reg.id, sourceId);
  assert.equal(reg.messaging, true);

  // The controller to one notebook's page.
  const uri = v.Uri.file("/ws/a.ipynb");
  assert.equal(
    await controller.postMessage(
      { type: "IPyWidgets_Reply_Widget_Version", payload: 8 },
      {
        notebook: { uri },
      },
    ),
    true,
  );
  assert.deepEqual(h.requests("notebooks.kernelPost")[0]?.params, {
    source: sourceId,
    message: { type: "IPyWidgets_Reply_Widget_Version", payload: 8 },
    path: "/ws/a.ipynb",
  });

  // The page to the controller, once the notebook's kernel started.
  const got: { editor: { notebook: unknown }; message: unknown }[] = [];
  controller.onDidReceiveMessage((e) => got.push(e));
  await h.call("start", {
    source: sourceId,
    kernel: "k1",
    option: { id: "jupyter-kernel", label: "Python 3" },
    context: { root: "/ws", path: "/ws/a.ipynb", notebookType: "jupyter.notebook" },
  });
  await h.call("kernelMessage", {
    kernel: "k1",
    message: { type: "IPyWidgets_Request_Widget_Version" },
  });
  assert.deepEqual(got[0]?.message, { type: "IPyWidgets_Request_Widget_Version" });
  assert.ok(got[0]?.editor.notebook);
});
