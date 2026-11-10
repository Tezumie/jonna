// How a chat's work flows (D329–D333, one line in index.ts): handing a task in flight to a new
// chat (hand_off_task), Plan mode's plan as an editable document (planDocs.ts), searching the
// folder's other chats (search_chats), loops (/loop, schedule_wakeup) and the user guide for the
// guide subagent (read_guide).

import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerChatLoops } from "./chatLoops";
import { registerChatSearch } from "./chatSearch";
import { guideTool } from "./guideTool";
import { handOffTool } from "./handOff";
import { registerPlanDocs } from "./planDocs";
import type { ScheduleService } from "./schedules";
import type { SessionManager } from "./sessions";

export function registerChatFlow(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  schedules: ScheduleService,
): void {
  registerPlanDocs(sub, services, sessions);
  registerChatSearch(sub, services, sessions);
  registerChatLoops(sub, services, sessions, schedules);
  const tools = [handOffTool(sessions), guideTool(services)];
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), ...tools];
}
