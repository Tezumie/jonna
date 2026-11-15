// Built-in agent (PLAN §8, DESIGN §13): sessions as dock tabs ("agent" view), models from Ollama
// (automatic) and OpenAI-compatible providers, the core toolset with changeset review, inline
// permission cards (for run_command and for IDE commands the agent calls), checkpoints and
// transcripts in app data. State: ide://agent (sessions) and ide://agent/session (the active one).
//
// The setup is core.ts (no screen needed); the views are screen.ts. In the window both run, the
// window being the agent's host; with no screen only the setup does.
import type { BuiltinExtension } from "../../core/extensions/index";
import type { WorkbenchServices } from "../../workbench/services";
import { setAgentHost } from "./agentHost";
import { desktopAgentHost } from "./agentHostDesktop";
import { activateAgentCore } from "./core";
import manifest from "./extension.json";
import { agentScreen } from "./screen";

export const agentExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate(context) {
    const { services } = context;
    if (!services.hasScreen) {
      activateAgentCore(context, null);
      return;
    }
    // The window is the agent's host (agentHost.ts): before any chat or MCP server exists.
    setAgentHost(services, desktopAgentHost(services));
    activateAgentCore(context, agentScreen);
  },
};
