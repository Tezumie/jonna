// Start free (D239): OpenCode runs free models with no account or key (its own free tier, served by
// opencode.ai), so a first-time user can try the agent at once, as OpenBot does. The empty chat's
// "Start free" card installs OpenCode if it's missing and makes it the chat's agent. Since D401
// that's the ACP registry's OpenCode V2, downloaded from opencode.ai (no Node.js or npm needed).
//
// All of it is here and in catalog.ts SUGGESTED_REGISTRY_AGENTS: if OpenCode drops its free
// tier, delete this file and its two calls in index.ts.

import { h, on } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { installedAgents } from "./acpRegistry";

/** The registry agent that runs free with no account (catalog.ts SUGGESTED_REGISTRY_AGENTS). */
export const FREE_AGENT_ID = "opencode-v2";

/** The card under "Set up AI models" in an empty chat with no model. */
export function freeStartCard(run: (command: string) => void): HTMLElement {
  const button = h(
    "button",
    { class: "ai-start ai-free-start", type: "button", "data-command": "agent.startFree" },
    h(
      "span",
      { class: "ai-tile-text" },
      h("span", { class: "ai-tile-name" }, "Start free with OpenCode"),
      h(
        "span",
        { class: "ai-free-start-note" },
        "No account or key needed. Free for a limited time; some models keep what you send.",
      ),
    ),
    icon("chevron-right"),
  );
  // OpenCode's terms for its free models (opencode.ai/docs/zen, checked for D253): offered for a
  // limited time, through OpenCode only (which is what this runs), and some providers keep what's
  // sent or use it to improve their model.
  setTooltip(
    button,
    "OpenCode's free models are offered for a limited time, and some of them keep what you send or use it to improve the model: don't send secrets or personal data. Its terms: opencode.ai/docs/zen.",
  );
  on(button, "click", () => run("agent.startFree"));
  return button;
}

export function registerFreeStart(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, notifications } = services;
  sub.add(
    dispatcher.register({
      id: "agent.startFree",
      title: "Start free with OpenCode",
      category: "Agent",
      description:
        "Makes OpenCode the chat's agent (D239): it runs free models with no account or key (OpenCode's free tier). Installs it first when it's missing: the ACP registry's OpenCode V2, downloaded from opencode.ai after the user confirms (D401).",
      input: s.empty(),
      effects: ["network", "write", "exec"],
      agent: "hidden",
      run: async () => {
        let name = installedAgents(services)[FREE_AGENT_ID]?.name;
        if (!name) {
          // A download, never an `opencode` on PATH: that can be OpenCode 1, which can't open
          // OpenCode 2's database.
          const result = (await dispatcher.execute("agent.registry.install", {
            id: FREE_AGENT_ID,
            from: "download",
          })) as { installed?: boolean; name?: string; reason?: string } | null;
          if (!result?.installed || !result.name) {
            // Already installing (Install on its row), say so rather than nothing (D407); a
            // declined confirm says nothing.
            if (result?.reason && result.reason !== "The user declined.")
              notifications.show("info", `OpenCode: ${result.reason}`);
            return { installed: false, ...(result?.reason && { reason: result.reason }) };
          }
          name = result.name;
        }
        await dispatcher.execute("agent.chooseModel", { for: "main", model: `acp/${name}` });
        notifications.show("info", "Using OpenCode's free models.");
        return { agent: name };
      },
    }),
  );
}
