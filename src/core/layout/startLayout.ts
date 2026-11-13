// The layout a window starts from (workbench.defaultLayout): what the sidebar shows and which
// tabs the dock holds when there is nothing to restore — no folder at startup, a folder closed,
// a folder opened for the first time. DOM-free; workbench/baseLayout.ts applies it.

/** "default": chats, welcome, the agent beside it. "agent": the chat fills the window. "code": welcome alone. */
export type StartLayout = "default" | "agent" | "code";

export const START_LAYOUTS: readonly StartLayout[] = ["default", "agent", "code"];

/** A setting's value as a layout ("default" for anything else). */
export function startLayoutOf(value: unknown): StartLayout {
  return START_LAYOUTS.includes(value as StartLayout) ? (value as StartLayout) : "default";
}

export interface StartLayoutPlan {
  /** The sidebar's view. */
  sidebar: "agent.chats" | "explorer.view";
  /** Whether the sidebar shows (hidden: only the activity bar). */
  sidebarVisible: boolean;
  /** View types for the dock's main, bottom and right groups. */
  main: string[];
  bottom: string[];
  right: string[];
  /** A folder opened for the first time may show its README (workbench.openReadme). */
  readme: boolean;
}

/** What `layout` starts with, without a folder or with one opened for the first time. */
export function startLayoutPlan(layout: StartLayout, folder: boolean): StartLayoutPlan {
  if (layout === "agent")
    // The chat is the window: the chats list beside it, nothing else (a file opened later gets
    // an editor area of its own on the left, as with any chat alone in the dock).
    return {
      sidebar: "agent.chats",
      sidebarVisible: true,
      main: [],
      bottom: [],
      right: ["agent"],
      readme: false,
    };
  if (layout === "code")
    // As VS Code starts: welcome alone; the explorer shows once there is a folder to list.
    return {
      sidebar: "explorer.view",
      sidebarVisible: folder,
      main: ["welcome"],
      bottom: [],
      right: [],
      readme: true,
    };
  return {
    sidebar: folder ? "explorer.view" : "agent.chats",
    sidebarVisible: true,
    main: ["welcome"],
    // No terminal (D424, as VS Code): one starts when it's asked for (Ctrl+`).
    bottom: [],
    right: ["agent"],
    readme: true,
  };
}
