import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AcpSetting } from "../../core/acp/client";
import { PersistenceService, type StateBackend } from "../../workbench/persistence";
import type { WorkbenchServices } from "../../workbench/services";
import { cachedSettings, rememberSettings } from "./acpSettingsCache";

const setting = (current: string): AcpSetting => ({
  configId: "model",
  name: "Model",
  category: "model",
  current,
  options: [{ id: current, name: current }],
});

/** A state file kept in memory. */
function memoryBackend(global: Record<string, unknown> | null = null) {
  const files: { global: string | null; workspace: string | null } = {
    global: global ? JSON.stringify({ version: 1, ...global }) : null,
    workspace: null,
  };
  const backend: StateBackend = {
    load: async (scope) => files[scope],
    save: async (scope, json) => {
      files[scope] = json;
    },
  };
  return { backend, saved: () => JSON.parse(files.global ?? "{}") as Record<string, unknown> };
}

async function servicesWith(global: Record<string, unknown> | null = null) {
  const store = memoryBackend(global);
  const persistence = new PersistenceService(store.backend);
  await persistence.loadGlobal();
  return { services: { persistence } as unknown as WorkbenchServices, persistence, ...store };
}

/** The web view's storage, as far as the cache uses it. */
function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  (globalThis as unknown as { localStorage?: unknown }).localStorage = storage;
  return map;
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

/** The global writes queued so far have landed. */
const settled = (persistence: PersistenceService) => persistence.saveGlobal({});

test("with no web view storage: what an agent reports is kept in the global state", async () => {
  assert.equal(typeof localStorage, "undefined");
  const { services, persistence, saved } = await servicesWith();
  assert.equal(cachedSettings(services, "codex"), null);
  rememberSettings(services, "codex", [setting("gpt")]);
  // At once in this window, before the write lands.
  assert.deepEqual(cachedSettings(services, "codex"), [setting("gpt")]);
  await settled(persistence);
  assert.deepEqual(saved().acpSettings, { codex: [setting("gpt")] });
});

test("the saved state is read back by a later run", async () => {
  const { services } = await servicesWith({ acpSettings: { codex: [setting("gpt")], bad: "x" } });
  assert.deepEqual(cachedSettings(services, "codex"), [setting("gpt")]);
  // What isn't a list of settings was dropped when the state was read.
  assert.equal(cachedSettings(services, "bad"), null);
});

test("values in the web view's storage are taken over once, the saved ones winning", async () => {
  const old = fakeStorage({
    "ide.acpSettings.claude": JSON.stringify([setting("sonnet")]),
    "ide.acpSettings.codex": JSON.stringify([setting("old")]),
    "ide.acpSettings.broken": "{not json",
    "ide.other": "kept",
  });
  const { services, persistence, saved } = await servicesWith({
    acpSettings: { codex: [setting("gpt")] },
  });
  // Readable at once, before anything is written.
  assert.deepEqual(cachedSettings(services, "claude"), [setting("sonnet")]);
  assert.deepEqual(cachedSettings(services, "codex"), [setting("gpt")]);
  await settled(persistence);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved().acpSettings, {
    claude: [setting("sonnet")],
    codex: [setting("gpt")],
  });
  // The old copies are gone (the damaged one too); other keys are untouched.
  assert.deepEqual([...old.keys()], ["ide.other"]);

  // A later window finds nothing to take over, and still has them.
  const later = { persistence } as unknown as WorkbenchServices;
  assert.deepEqual(cachedSettings(later, "claude"), [setting("sonnet")]);
});

test("reporting the same settings again writes nothing", async () => {
  const { services, persistence, backend } = await servicesWith({
    acpSettings: { codex: [setting("gpt")] },
  });
  let writes = 0;
  const save = backend.save;
  backend.save = async (scope, json) => {
    writes++;
    await save(scope, json);
  };
  rememberSettings(services, "codex", [setting("gpt")]);
  await persistence.refreshGlobal();
  assert.equal(writes, 0);
  rememberSettings(services, "codex", [setting("gpt-next")]);
  await settled(persistence);
  assert.ok(writes >= 1);
  assert.deepEqual(cachedSettings(services, "codex"), [setting("gpt-next")]);
});
