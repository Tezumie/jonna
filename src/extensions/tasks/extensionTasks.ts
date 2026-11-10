// Extensions' task providers (D233, `ide.tasks.registerTaskProvider`): their tasks, already
// checked by the extensions host (workbench/extensionRegistries.ts), as this extension's
// TaskDefinition. tasks.json entries of a provided type are resolved by their provider. DOM-free
// and tested.
import type { ContributedTask } from "../../workbench/extensionRegistries";
import { DEFAULT_PRESENTATION, type TaskDefinition } from "./tasks";

export function fromContributed(task: ContributedTask): TaskDefinition {
  return {
    label: task.label,
    command: task.command,
    spec: task.spec,
    ...(task.cwd && { cwd: task.cwd }),
    ...(task.group && { group: task.group }),
    background: task.background,
    dependsOn: [],
    dependsOrder: "parallel",
    source: task.source,
    ...(task.detail && { detail: task.detail }),
    ...(task.problemMatcher !== undefined && { problemMatcher: task.problemMatcher }),
    presentation: { ...DEFAULT_PRESENTATION, ...task.presentation },
    runOnFolderOpen: false,
    hide: false,
  };
}
