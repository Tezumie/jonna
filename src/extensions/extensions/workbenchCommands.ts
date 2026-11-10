// Commands and state for what extensions plug into the workbench (D233): their source controls'
// input box, accept button and resources (the Source control view's sections run these), sign-in
// and sign-out with their authentication providers, and `ide://extensions/providers`, the list of
// everything registered (terminals, task types, source controls, debug types, sign-ins, file
// systems). Also hands quick diff the source controls' original texts.
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { scmCount } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { registerFileSystemCommands } from "./fileSystemCommands";

export function registerWorkbenchProviders(
  sub: DisposableStore,
  services: WorkbenchServices,
  register: WorkbenchServices["dispatcher"]["register"],
): void {
  const { state, quickInput } = services;
  const f = services.extensionFeatures;
  // Base texts for files of extensions' source controls (git's come first).
  sub.add(services.quickDiff.addFallback((path) => f.sourceControls.original(path, isWithin)));
  // New file / folder, rename and delete in extensions' file systems (D234).
  registerFileSystemCommands(services, register);

  const control = (key: string) => {
    const entry = f.sourceControls.all.peek().find((c) => c.key === key);
    if (!entry) throw new Error(`No source control ${key} (see ide://extensions/providers).`);
    return entry;
  };
  const scmKey = s
    .string()
    .describe('A source control\'s key, "<extension id>/<id>" (ide://extensions/providers)');
  register({
    id: "extensions.scmSetInput",
    title: "Set an extension's source control message",
    description: "Sets the text of an extension's source control input box (as typing in it does).",
    input: s.object({ key: scmKey, value: s.string().describe("The box's new text") }),
    effects: [],
    agent: "discoverable",
    run: ({ key, value }) => {
      control(key).setInput(value);
      return { ok: true };
    },
  });
  register({
    id: "extensions.scmAccept",
    title: "Accept an extension's source control message",
    description:
      "Runs an extension's source control accept command (its commit button) with the input box's text; `value` sets the text first.",
    input: s.object({
      key: scmKey,
      value: s.string().describe("The box's text to accept (default: what it holds)").optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ key, value }) => {
      const entry = control(key);
      if (value !== undefined) entry.setInput(value);
      await entry.accept();
      return { ok: true };
    },
  });
  register({
    id: "extensions.scmOpenResource",
    title: "Open an extension's source control resource",
    description:
      "Opens a resource of an extension's source control (its command, else the file), by group id and index.",
    input: s.object({
      key: scmKey,
      group: s.string().describe("The resource group's id"),
      index: s.number().describe("The resource's position in the group (0-based)"),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ key, group, index }) => {
      const entry = control(key);
      const resource = entry.state.peek().groups.find((g) => g.id === group)?.resources[index];
      if (!resource) throw new Error(`No resource ${index} in ${group}.`);
      await entry.open(resource);
      return { path: resource.path };
    },
  });

  const provider = (id: string) => {
    const entry = f.authentication.get(id);
    if (!entry)
      throw new Error(`No authentication provider ${id} (see ide://extensions/providers).`);
    return entry;
  };
  const providerId = s
    .string()
    .describe("The authentication provider's id (ide://extensions/providers)");
  register({
    id: "extensions.authSignIn",
    title: "Sign in with an extension's account provider",
    description:
      "Signs in with an extension's authentication provider (the provider asks for what it needs).",
    input: s.object({
      providerId: providerId.optional(),
      scopes: s.array(s.string()).describe("Scopes to ask for").optional(),
    }),
    effects: ["network"],
    run: async ({ providerId: id, scopes }, ctx) => {
      let chosen = id;
      if (!chosen) {
        const picked = await quickInput.pick(
          f.authentication.all
            .peek()
            .map((p) => ({ id: p.id, label: p.label, description: p.owner })),
          { placeholder: "Sign in with…" },
        );
        if (!picked) return { signedIn: false };
        chosen = picked.id;
      }
      // Signing in is the user's own act: an agent can't start one.
      if (ctx.caller.kind === "agent") throw new Error("Only the user can sign in.");
      const session = await provider(chosen).createSession(scopes ?? []);
      return { signedIn: true, account: session.account.label };
    },
  });
  register({
    id: "extensions.authSignOut",
    title: "Sign out of an extension's account",
    description:
      "Signs out of an account of an extension's authentication provider (every session of it, or one).",
    input: s.object({
      providerId,
      account: s.string().describe("The account's label or id (default: every account)").optional(),
    }),
    effects: ["destructive"],
    run: async ({ providerId: id, account }) => {
      const entry = provider(id);
      const sessions = (await entry.sessions()).filter(
        (x) => account === undefined || x.account.label === account || x.account.id === account,
      );
      for (const session of sessions) await entry.removeSession(session.id);
      return { signedOut: sessions.length };
    },
  });

  sub.add(
    state.register("ide://extensions/providers", {
      description:
        "What extensions plug into the workbench (D233): their terminals, task types, source controls (key, label, groups, count), debug types, authentication providers, file system schemes, the webview panels their code opened (tab id, title) and their test controllers (ide://tests/extensions has their tests).",
      get: () => ({
        terminals: f.terminals.all
          .peek()
          .map((t) => ({ owner: t.owner, id: t.id, name: t.name, kind: t.kind })),
        taskTypes: [...new Set(f.tasks.all.peek().map((t) => `${t.owner}: ${t.type}`))],
        sourceControls: f.sourceControls.all.peek().map((c) => {
          const st = c.state.peek();
          return {
            key: c.key,
            owner: c.owner,
            label: c.label,
            count: scmCount(st),
            input: st.input.value,
            accept: st.accept?.title ?? null,
            groups: st.groups.map((g) => ({
              id: g.id,
              label: g.label,
              resources: g.resources.map((r) => `${r.letter ?? ""} ${r.path}`.trim()),
            })),
          };
        }),
        debugTypes: f.debugAdapters.all
          .peek()
          .map((d) => ({ owner: d.owner, type: d.type, label: d.label })),
        authentication: f.authentication.all
          .peek()
          .map((p) => ({ owner: p.owner, id: p.id, label: p.label })),
        fileSystems: f.fileSystems.all
          .peek()
          .map((x) => ({ owner: x.owner, scheme: x.scheme, label: x.label, readonly: x.readonly })),
        webviewPanels: f.webviewPanels.all.peek().map((p) => ({
          owner: p.owner,
          id: p.id,
          viewType: p.viewType,
          title: p.title(),
          tabId: p.tabId(),
        })),
        testControllers: f.tests.all.peek().map((c) => ({
          owner: c.owner,
          key: c.key,
          label: c.label,
          tests: c.items.peek().length,
        })),
      }),
    }),
  );
}
