// Desktop control (Rust `desktop`, D353): monitors, screen captures, the app under a point, input
// and the stop banner. Windows only; elsewhere `info().supported` is false and the rest fail.
import { call } from "./invoke";

export interface DesktopMonitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface DesktopInfo {
  supported: boolean;
  monitors: DesktopMonitor[];
  /** The virtual desktop: x, y, width, height in physical pixels. */
  desktop: [number, number, number, number];
}

export interface DesktopWindow {
  process: string;
  title: string;
  pid: number;
  isSelf: boolean;
}

export type DesktopInput =
  | { op: "move"; x: number; y: number }
  | {
      op: "click";
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      count: number;
      hold: number[];
    }
  | { op: "drag"; fromX: number; fromY: number; x: number; y: number }
  | { op: "scroll"; x: number; y: number; dx: number; dy: number }
  | { op: "type"; text: string }
  | { op: "key"; keys: number[]; repeat: number };

export const desktopIpc = {
  info: () => call<DesktopInfo>("desktop_info"),
  /** BGRA pixels of an area scaled to outW×outH (an 8-byte width/height header first). */
  capture: async (
    area: { x: number; y: number; width: number; height: number },
    outW: number,
    outH: number,
  ): Promise<{ width: number; height: number; bgra: Uint8Array }> => {
    const raw = new Uint8Array(
      await call<ArrayBuffer>("desktop_capture", {
        x: Math.round(area.x),
        y: Math.round(area.y),
        w: Math.round(area.width),
        h: Math.round(area.height),
        outW: Math.round(outW),
        outH: Math.round(outH),
      }),
    );
    const view = new DataView(raw.buffer, raw.byteOffset, 8);
    return {
      width: view.getUint32(0, true),
      height: view.getUint32(4, true),
      bgra: raw.subarray(8),
    };
  },
  /** The app whose window is at the point, or the one in front. */
  windowAt: (point?: [number, number]) =>
    call<DesktopWindow | null>(
      "desktop_window_at",
      point ? { x: Math.round(point[0]), y: Math.round(point[1]) } : {},
    ),
  input: (op: DesktopInput) => call<void>("desktop_input", { op }),
  /** Shows the always-on-top stop banner with `text`, or hides it. */
  banner: (text: string | null) => call<void>("desktop_banner", text ? { text } : {}),
  /** Whether the user pressed Esc or the banner's Stop since the last call. */
  takeStop: () => call<boolean>("desktop_take_stop"),
};
