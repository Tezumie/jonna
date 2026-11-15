// Workspace trust's questions as dialogs (trust.ts asks them through `TrustPrompts`): the window's
// answers. Only for a screen.
import { basename, dirname } from "../core/paths/index";
import { showDialog } from "../ui/Dialog";
import type { TrustFolderRequest, TrustPrompts } from "./trust";

function askAdd(undecided: readonly string[]): Promise<"trust" | "restrict" | "cancel"> {
  return showDialog<"trust" | "restrict" | "cancel">({
    title:
      undecided.length === 1
        ? `Trust the authors of “${basename(undecided[0] ?? "")}”?`
        : `Trust the authors of these ${undecided.length} folders?`,
    message: `${undecided.join("\n")}\n\nThis workspace is trusted. A folder's files can define tasks, launch configurations and tests that run programs on your computer: trust it if you know where it comes from. Restricted, it joins and the whole workspace runs in restricted mode until you trust it.`,
    actions: [
      { label: "Cancel", value: "cancel", variant: "secondary" },
      { label: "Add restricted", value: "restrict", variant: "secondary" },
      { label: "Trust and add", value: "trust", variant: "primary" },
    ],
    cancelValue: "cancel",
    defaultValue: "restrict",
    size: "md",
  });
}

/** Folders the user didn't pick (a workspace file changed on disk, network folders): asked. */
async function confirmAdd(paths: readonly string[], why: "file" | "network"): Promise<boolean> {
  const answer = await showDialog<boolean>({
    title:
      why === "network"
        ? "Open network folders?"
        : `Add ${paths.length === 1 ? "a folder" : `${paths.length} folders`} to the workspace?`,
    message:
      why === "network"
        ? `The workspace file lists folders on another computer:\n${paths.join("\n")}\n\nOpening them connects to that computer with your Windows sign-in. Open them only if you know the workspace file and the computer.`
        : `The workspace file changed and now lists:\n${paths.join("\n")}\n\nAdded, their files are part of the workspace: the agent and extensions can read them. Add them only if you made this change.`,
    actions: [
      { label: "Don't add", value: false, variant: "secondary" },
      { label: why === "network" ? "Open them" : "Add", value: true, variant: "primary" },
    ],
    cancelValue: false,
    defaultValue: false,
    size: "md",
  });
  return answer === true;
}

/** The trust dialog, with "Trust the parent folder too". */
async function askFolder(
  request: TrustFolderRequest,
): Promise<{ answer: "trust" | "restrict" | "cancel"; trustParent: boolean }> {
  const { root, folders, what } = request;
  const several = folders.length > 1;
  // A multi-root workspace has no one parent to offer.
  const parent = several ? root : dirname(root);
  let trustParent = false;
  const answer = await showDialog<"trust" | "restrict" | "cancel">({
    title: several
      ? `Trust the authors of the ${folders.length} folders in “${request.workspaceName ?? basename(root)}”?`
      : `Trust the authors of “${basename(root)}”?`,
    message: `${several ? `${folders.map((f) => f.name).join(", ")}.\n\n` : ""}${what ? `${what} comes from this folder's files and runs programs on your computer.` : "This folder's files can define tasks, launch configurations and tests that run programs on your computer."}\n\nTrust the folder if you know where it comes from. In restricted mode its tasks, debugging and tests don't run; you can still browse and edit everything, and change this later with "Manage workspace trust".`,
    actions: [
      { label: "Stay restricted", value: "restrict", variant: "secondary" },
      { label: several ? "Trust folders" : "Trust folder", value: "trust", variant: "primary" },
    ],
    cancelValue: "cancel",
    defaultValue: "restrict",
    size: "md",
    signal: request.signal,
    ...(parent !== root && {
      checkbox: {
        label: `Trust the authors of all files in the parent folder “${basename(parent)}”`,
        detail: parent,
        onCheck: (checked: boolean) => (trustParent = checked),
      },
    }),
  });
  return { answer, trustParent };
}

export const trustDialogs: TrustPrompts = {
  addFolders: askAdd,
  confirmAdd,
  folder: askFolder,
};
