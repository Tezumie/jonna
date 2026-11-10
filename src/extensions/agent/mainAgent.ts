// The main agent's name and face (D234): `agent.mainAgent.name` and `agent.mainAgent.icon`, set on
// the Agents page or with `agent.setMainAgent`. The chat's headers, the group chats' faces,
// @mentions and room brief (what each member is told about the others) and the chats list use
// them. Its member id stays `agent` (MAIN_MEMBER), so saved chats and handoffs keep working after
// a rename.

import {
  characterFace,
  type FaceSpec,
  iconCode,
  MAIN_AGENT_FACE,
  MODEL_ICON,
  parseFace,
  randomFace,
} from "../../core/agent/faces";
import type { DisposableStore } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

/** The main agent is named after the IDE until the user names it (D237). */
export const DEFAULT_MAIN_AGENT_NAME = product.nameShort;

export interface MainAgentIdentity {
  label: string;
  face: FaceSpec;
}

/** The main agent as the user named it; updated when the settings change. */
export const mainAgent = signal<MainAgentIdentity>({
  label: DEFAULT_MAIN_AGENT_NAME,
  face: { ...MAIN_AGENT_FACE, model: "" },
});

/** A usable name: one line, at most 40 characters; empty means the default. */
export function cleanMainAgentName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return name || DEFAULT_MAIN_AGENT_NAME;
}

/**
 * Its face: a face code, else its model's logo (D270; the default since D272), with its own face
 * kept for where no logo is found.
 */
function mainFace(icon: string | undefined): FaceSpec {
  return parseFace(icon) ?? { ...MAIN_AGENT_FACE, model: "" };
}

function read(services: WorkbenchServices): MainAgentIdentity {
  const settings = services.settings;
  return {
    label: cleanMainAgentName(settings.peek<string>("agent.mainAgent.name")),
    face: mainFace(settings.peek<string>("agent.mainAgent.icon")),
  };
}

export function registerMainAgent(services: WorkbenchServices, sub: DisposableStore): void {
  const { settings, dispatcher } = services;
  const refresh = () => {
    const next = read(services);
    const now = mainAgent.peek();
    if (next.label !== now.label || iconCode(next.face) !== iconCode(now.face))
      mainAgent.value = next;
  };
  refresh();
  sub.add(
    settings.model.onDidChange((keys) => {
      if (keys.some((k) => k.startsWith("agent.mainAgent."))) refresh();
    }),
  );
  sub.add(
    services.state.register("ide://agent/mainAgent", {
      description:
        "The main agent's name and face code (agent.setMainAgent changes them); its id in group chats, mentions and handoffs is always `agent`.",
      get: () => {
        const now = mainAgent.peek();
        return { id: "agent", name: now.label, icon: iconCode(now.face) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.setMainAgent",
      title: "Rename the main agent or change its face",
      category: "Agent",
      description:
        "Sets the main agent's name and/or face (the user's settings agent.mainAgent.name and agent.mainAgent.icon). `name`: up to 40 characters, empty restores the default. `icon`: a face code `shape-color-eyes` (e.g. `blob-3-dots`, as in an agent file's icon:), `model` (the logo of the model it uses), or `random`. Its id stays `agent` for mentions, handoffs and group members. Returns the name and face now in use.",
      input: s.object({
        name: s.string().describe("The new name; empty restores the default").optional(),
        icon: s.string().describe("A face code shape-color-eyes, model, or random").optional(),
      }),
      effects: ["write"],
      run: async (input) => {
        if (input.name !== undefined) {
          const name = input.name.trim() ? cleanMainAgentName(input.name) : "";
          await settings.update("agent.mainAgent.name", name || undefined, "user");
        }
        if (input.icon !== undefined) {
          const code = input.icon.trim().toLowerCase();
          const face =
            code === "random"
              ? randomFace(characterFace(mainAgent.peek().face))
              : code === MODEL_ICON
                ? { ...MAIN_AGENT_FACE, model: "" }
                : parseFace(code);
          if (code && !face)
            throw new Error(
              `"${input.icon}" isn't a face code: use shape-color-eyes (e.g. blob-3-dots) or model.`,
            );
          await settings.update("agent.mainAgent.icon", face ? iconCode(face) : undefined, "user");
        }
        refresh();
        const now = mainAgent.peek();
        return { name: now.label, icon: iconCode(now.face) };
      },
    }),
  );
}
