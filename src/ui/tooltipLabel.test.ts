import assert from "node:assert/strict";
import { test } from "node:test";
import { setTooltip } from "./Tooltip";

/** The few element members setTooltip touches. */
function fakeElement(text = "") {
  const attrs = new Map<string, string>();
  return {
    dataset: {} as Record<string, string | undefined>,
    textContent: text,
    hasAttribute: (name: string) => attrs.has(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
}

// D203: recycled rows must not keep the accessible name of the first item they showed.
test("setTooltip replaces the aria-label it set, and rows can opt out", () => {
  const button = fakeElement();
  setTooltip(button as unknown as HTMLElement, "Refresh");
  assert.equal(button.getAttribute("aria-label"), "Refresh");
  setTooltip(button as unknown as HTMLElement, "Stop");
  assert.equal(button.getAttribute("aria-label"), "Stop");

  // An aria-label the owner set is kept.
  const own = fakeElement();
  own.setAttribute("aria-label", "Mine");
  setTooltip(own as unknown as HTMLElement, "Tip");
  assert.equal(own.getAttribute("aria-label"), "Mine");

  // A row filled after the call: no label from the path, now or after recycling.
  const row = fakeElement();
  setTooltip(row as unknown as HTMLElement, "/a/one.ts", undefined, { ariaLabel: false });
  assert.equal(row.hasAttribute("aria-label"), false);
  row.textContent = "one.ts";
  setTooltip(row as unknown as HTMLElement, "/a/two.ts", undefined, { ariaLabel: false });
  assert.equal(row.hasAttribute("aria-label"), false);
  assert.equal(row.dataset.tooltip, "/a/two.ts");
});
