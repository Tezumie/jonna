// "What's new" (D204): the bundled release notes (docs/release-notes.md) in a dock tab, opened by
// Help → Release notes and by itself after an update (the version that ran last is kept by the
// Rust side), unless `update.showReleaseNotes` is off.
import notesText from "../../../docs/release-notes.md?raw";
import { parseReleaseNotes, shouldShowReleaseNotes } from "../../core/diagnostics/releaseNotes";
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { sessionIpc } from "../../core/ipc/diagnostics";
import { openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { perf } from "../../core/perf";
import { product } from "../../core/product";
import { s } from "../../core/schema/index";
import { markdownNodes } from "../../ui/markdown/render";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

export const releaseNotes = parseReleaseNotes(notesText);

class ReleaseNotesView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();

  constructor(services: WorkbenchServices) {
    const run = (id: string) =>
      void services.dispatcher.execute(id).catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    const markdown = [
      `# What's new in ${product.nameLong}`,
      `You have version ${product.version}.`,
      ...releaseNotes.map((n) => `## ${n.id}${n.title ? ` — ${n.title}` : ""}\n\n${n.body}`),
    ].join("\n\n");
    this.element = h(
      "div",
      { class: "docs-view release-notes-view", tabindex: "-1" },
      h(
        "div",
        { class: "docs-scroll" },
        h(
          "div",
          { class: "md md-document docs-page" },
          ...markdownNodes(markdown, {
            headingShift: 0,
            softBreaks: "space",
            openLink: (href) => {
              if (href.startsWith("command:")) run(href.slice("command:".length));
              else if (/^https?:\/\//i.test(href)) void openerIpc.openUrl(href).catch(() => {});
            },
            copy: (t) =>
              void services.dispatcher.execute("ui.copyText", { text: t }).catch(() => {}),
          }),
        ),
      ),
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerReleaseNotes(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock, settings } = services;
  const descriptor: DockViewDescriptor = {
    type: "releaseNotes",
    title: () => "What's new",
    icon: () => "sparkles",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: () => new ReleaseNotesView(services),
  };
  sub.add(dock.views.register(descriptor));

  sub.add(
    dispatcher.register({
      id: "help.showReleaseNotes",
      title: "Release notes",
      category: "Help",
      description:
        "Opens What's new: short notes on each recent release, newest first. With `release` (e.g. 'm7.4'), also returns that release's notes as Markdown.",
      input: s.object({ release: s.string().describe("A release id, e.g. m7.4").optional() }),
      effects: [],
      agent: "discoverable",
      run: ({ release }) => {
        const found = release ? releaseNotes.find((n) => n.id === release) : undefined;
        if (release && !found)
          throw new Error(`No release "${release}" (${releaseNotes.map((n) => n.id).join(", ")}).`);
        const tabId = dock.openView("releaseNotes", null, "main", true);
        return {
          tabId,
          releases: releaseNotes.map((n) => ({ id: n.id, title: n.title })),
          ...(found && { markdown: found.body }),
        };
      },
    }),
  );

  // After an update: once the folder (and its tabs) is restored, so the tab isn't replaced.
  let disposed = false;
  sub.add({ dispose: () => (disposed = true) });
  void perf
    .whenMarked("workspaceRestored")
    .then(() => sessionIpc.info())
    .then((info) => {
      const enabled = settings.peek<boolean>("update.showReleaseNotes") !== false;
      if (!disposed && shouldShowReleaseNotes(info?.previousVersion, product.version, enabled))
        dock.openView("releaseNotes", null, "main", true);
    })
    .catch(() => {});
}
