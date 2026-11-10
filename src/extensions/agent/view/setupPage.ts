// The "AI models" page (D164): a dock tab around the setup panel. Kept as its own page (not a
// settings form) so routing, sub-agents and custom agents can join it later as more sections.
import type { Json } from "../../../core/dock/index";
import { h } from "../../../core/dom/index";
import type { DockView, DockViewDescriptor } from "../../../workbench/dock/views";
import { type SetupDeps, SetupPanel } from "./setup";

export function setupPageDescriptor(deps: SetupDeps): DockViewDescriptor {
  return {
    type: "agent.setup",
    title: () => "Model providers",
    icon: () => "agent",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: () => new SetupPage(deps),
  };
}

class SetupPage implements DockView {
  readonly element: HTMLElement;
  private readonly panel: SetupPanel;

  constructor(deps: SetupDeps) {
    this.panel = new SetupPanel(deps);
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.panel.element);
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.panel.dispose();
  }
}
