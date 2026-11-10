// Titles for the editor engine's commands that have no action (and so no label of their own):
// cursorDown, deleteLeft, tab… (D207). A table for the common ones whose id reads badly, else the
// id in words ("cursorWordLeftSelect" → "Cursor word left with selection"). DOM-free and tested.

const TITLES: Record<string, string> = {
  cursorHome: "Cursor to line start",
  cursorEnd: "Cursor to line end",
  cursorTop: "Cursor to file start",
  cursorBottom: "Cursor to file end",
  cursorLineStart: "Cursor to line start (ignoring indentation)",
  cursorLineEnd: "Cursor to line end (ignoring wrapping)",
  cursorWordStartLeft: "Cursor to previous word start",
  cursorWordEndRight: "Cursor to next word end",
  cursorUndo: "Undo last cursor move",
  cursorRedo: "Redo last cursor move",
  tab: "Indent or insert tab",
  outdent: "Outdent",
  lineBreakInsert: "Insert line break after cursor",
  type: "Type",
  undo: "Undo",
  redo: "Redo",
  removeSecondaryCursors: "Remove secondary cursors",
  cancelSelection: "Cancel selection",
  hideSuggestWidget: "Hide suggestions",
  acceptSelectedSuggestion: "Accept selected suggestion",
  selectNextSuggestion: "Select next suggestion",
  selectPrevSuggestion: "Select previous suggestion",
  selectNextPageSuggestion: "Select next page of suggestions",
  selectPrevPageSuggestion: "Select previous page of suggestions",
  toggleSuggestionDetails: "Toggle suggestion details",
  closeFindWidget: "Close find",
  closeReferenceSearch: "Close references",
  closeParameterHints: "Close parameter hints",
  closeMarkersNavigation: "Close problem navigation",
  leaveSnippet: "Leave snippet",
  jumpToNextSnippetPlaceholder: "Next snippet placeholder",
  jumpToPrevSnippetPlaceholder: "Previous snippet placeholder",
};

/** Words of a camelCase / dotted id, lower case: "cursorPageDown" → ["cursor", "page", "down"]. */
function words(id: string): string[] {
  return id
    .replace(/^editor\.action\./, "")
    .split(/[._\-\s]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) && w.length > 1 ? w : w.toLowerCase()));
}

/** Readable title for an engine command id without a label of its own. */
export function engineCommandTitle(id: string): string {
  const known = TITLES[id];
  if (known) return known;
  let base = id;
  let suffix = "";
  // Monaco's "…Select" variants extend the selection.
  if (/[a-z]Select$/.test(id) && id !== "select") {
    base = id.slice(0, -"Select".length);
    suffix = " with selection";
    const knownBase = TITLES[base];
    if (knownBase) return `${knownBase}${suffix}`;
  }
  const list = words(base);
  if (!list.length) return id;
  const text = list.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${suffix}`;
}
