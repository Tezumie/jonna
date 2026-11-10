// A delete / modify conflict in the merge editor (D209): one side deleted the file, the other
// changed it. The changed version shows in its input pane; this panel, where the result would
// be, says what happened and offers Keep the file / Delete the file (git.mergeEditor.resolveDeleted).
import { h } from "../../core/dom/index";
import { setTooltip } from "../../ui/Tooltip";

export interface DeletedSide {
  /** The side that deleted the file. */
  by: "current" | "incoming";
  /** The other side's text (what Keep keeps). */
  kept: string;
}

export function deletedPanel(
  deleted: DeletedSide,
  name: string,
  choose: (choice: "keep" | "delete") => void,
): HTMLElement {
  const changedBy = deleted.by === "current" ? "Incoming (their side)" : "Current (your side)";
  const deletedBy = deleted.by === "current" ? "Current (your side)" : "Incoming (their side)";
  const keep = h(
    "button",
    { class: "button button-primary button-sm", type: "button", "data-choice": "keep" },
    "Keep the file",
  );
  setTooltip(keep, `Keep ${changedBy.toLowerCase()}'s version of ${name} and stage it`);
  keep.addEventListener("click", () => choose("keep"));
  const remove = h(
    "button",
    { class: "button button-secondary button-sm", type: "button", "data-choice": "delete" },
    "Delete the file",
  );
  setTooltip(remove, `Delete ${name} and stage the deletion`);
  remove.addEventListener("click", () => choose("delete"));
  const lines = deleted.kept ? deleted.kept.split("\n").length : 0;
  return h(
    "div",
    { class: "merge-pane merge-pane-result merge-deleted", "data-pane": "result" },
    h("div", { class: "merge-pane-header" }, h("span", { class: "merge-pane-title" }, "Result")),
    h(
      "div",
      { class: "merge-deleted-body" },
      h(
        "p",
        null,
        `${deletedBy} deleted ${name}; ${changedBy} changed it (${lines} line${lines === 1 ? "" : "s"}, shown above).`,
      ),
      h(
        "p",
        { class: "merge-deleted-hint" },
        "Keep the changed file, or delete it. Either way the choice is staged.",
      ),
      h("div", { class: "merge-deleted-actions" }, keep, remove),
    ),
  );
}
