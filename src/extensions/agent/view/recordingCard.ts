// A browser recording's card in the chat (D340): browser_act stop_recording drawn as the animated
// GIF it made, what it holds (frames, length, size), and Save to the project or Download. The GIF
// stays in memory until the IDE closes; a chat reopened after that says so instead.
import { recordingSummary } from "../../../core/agent/browserRecording";
import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { recordingForItem } from "../browserRecorder";

export function recordingCard(
  itemId: string,
  run: (command: string, input?: unknown) => void,
): HTMLElement {
  const rec = recordingForItem(itemId);
  const what = rec?.target === "ide" ? "IDE recording" : "Browser recording";
  if (!rec)
    return h(
      "div",
      { class: "agent-recording is-gone", "data-key": `rec-${itemId}-gone` },
      icon("image"),
      h(
        "span",
        { class: "agent-recording-caption" },
        "Browser recording · no longer kept (recordings last until the IDE closes)",
      ),
    );
  const button = (glyph: "download" | "file-down", label: string, input: unknown) => {
    const b = h(
      "button",
      { class: "button button-sm button-secondary agent-recording-action", type: "button" },
      icon(glyph),
      label,
    );
    setTooltip(b, label);
    on(b, "click", () => run("agent.saveRecording", input));
    return b;
  };
  return h(
    "div",
    { class: "agent-recording", "data-key": `rec-${itemId}-${rec.id}`, "data-recording": rec.id },
    h("img", {
      class: "agent-recording-image",
      src: rec.url,
      alt: what,
      width: String(rec.width),
      height: String(rec.height),
      draggable: "false",
    }),
    h(
      "div",
      { class: "agent-recording-foot" },
      h(
        "span",
        { class: "agent-recording-caption" },
        `${what} · ${recordingSummary({ ...rec, bytes: rec.gif.length })}`,
      ),
      h(
        "div",
        { class: "agent-recording-actions" },
        button("file-down", "Save to project…", { id: rec.id }),
        button("download", "Download…", { id: rec.id, to: "file" }),
      ),
    ),
  );
}
