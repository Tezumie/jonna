// The browser tab's device bar (device mode): a device or "Responsive", width × height, rotate,
// the scale it is shown at, and leave.
import { h } from "../../core/dom/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { DEVICES, type Viewport } from "./devices";

export function renderDeviceBar(
  bar: HTMLElement,
  vp: Viewport,
  setViewport: (viewport: Viewport) => void,
  leave: () => void,
): void {
  const select = h("select", { class: "input browser-device" });
  select.append(
    h("option", { value: "" }, "Responsive"),
    ...DEVICES.map((d) =>
      h("option", { value: d.id, ...(vp.device === d.id && { selected: true }) }, d.label),
    ),
  );
  select.addEventListener("change", () => {
    const d = DEVICES.find((x) => x.id === select.value);
    setViewport(
      d
        ? { width: d.width, height: d.height, device: d.id }
        : { width: vp.width ?? 800, height: vp.height ?? 600, device: null },
    );
  });
  const size = (value: number | null, set: (n: number) => void) => {
    const input = h("input", {
      class: "input browser-size",
      type: "number",
      min: "200",
      max: "4000",
      value: String(value ?? ""),
    });
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (n >= 200 && n <= 4000) set(n);
    });
    return input;
  };
  const rotate = h("button", { class: "icon-button", type: "button" }, icon("rotate-ccw"));
  setTooltip(rotate, "Rotate");
  rotate.addEventListener("click", () =>
    setViewport({ width: vp.height, height: vp.width, device: vp.device }),
  );
  const close = h("button", { class: "icon-button", type: "button" }, icon("x"));
  setTooltip(close, "Leave device mode");
  close.addEventListener("click", leave);
  bar.replaceChildren(
    select,
    size(vp.width, (n) => setViewport({ ...vp, width: n, device: null, height: vp.height ?? 800 })),
    h("span", { class: "browser-size-x" }, "×"),
    size(vp.height, (n) => setViewport({ ...vp, height: n, device: null, width: vp.width ?? 400 })),
    rotate,
    h("span", { class: "browser-scale" }),
    h("span", { class: "dt-spacer" }),
    close,
  );
  if (vp.width !== null) bar.hidden = false;
}
