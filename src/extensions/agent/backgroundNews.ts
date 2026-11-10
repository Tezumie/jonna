// Work that brings news into a chat while the agent does something else (D322–D325): monitors,
// pull request watches and messages between chats, registered together (one line in index.ts).

import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerChatMessaging } from "./chatMessaging";
import { registerMonitors } from "./monitors";
import { registerPrWatches } from "./prWatches";
import type { SessionManager } from "./sessions";

export function registerBackgroundNews(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  registerMonitors(sub, services, sessions);
  registerPrWatches(sub, services, sessions);
  registerChatMessaging(sub, services, sessions);
}
