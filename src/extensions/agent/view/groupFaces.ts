// The faces of a chat's agents as elements (D234): a group's stacked, a chat's own in its
// state, a group chat's header. Who the members are is groupChat.ts's; drawing them is here.

import { MAIN_MEMBER } from "../../../core/agent/groupChat";
import { type FaceState, agentFace as faceElement, faceGroup } from "../../../ui/AgentFace";
import { setTooltip } from "../../../ui/Tooltip";
import { memberInfo, memberNames, soloSpeaker } from "../groupChat";
import type { AgentSession } from "../session";

/** The faces of a group's members, stacked (the chat's header, its row, the composer). */
export function groupFaces(names: readonly string[], size: number): HTMLElement {
  return names.length === 1
    ? faceElement(memberInfo(names[0] ?? MAIN_MEMBER).face, { size })
    : faceGroup(
        names.map((n) => memberInfo(n).face),
        size,
      );
}

/**
 * A chat's face (D234): its agents' faces in a group chat, else the agent it's with, in
 * `state` (the chat's tab, so open chats tell apart at a glance).
 */
export function chatFaceElement(
  session: AgentSession,
  size: number,
  state?: FaceState,
): HTMLElement {
  const members = session.members.peek();
  if (members.length) return groupFaces(members, size);
  const info = memberInfo(soloSpeaker(session.chatMode.peek()));
  return faceElement(info.face, { size, ...(state && { state }) });
}

/** A group chat's header: its agents' faces, their names in the tooltip. */
export function showGroupFaces(slot: HTMLElement, names: readonly string[]): void {
  slot.replaceChildren(groupFaces(names, 20));
  setTooltip(slot, `Group chat: ${memberNames(names)}`);
}
