// Device sizes for the browser's responsive mode (CSS pixels, portrait). DOM-free.
export interface Device {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const DEVICES: readonly Device[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852 },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "galaxy-s23", label: "Galaxy S23", width: 360, height: 780 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "full-hd", label: "Full HD", width: 1920, height: 1080 },
];

export interface Viewport {
  /** null: the page fills the tab (no emulation). */
  width: number | null;
  height: number | null;
  device: string | null;
}

/** Reads `browser.resize` input: a device id/name, "responsive", or explicit size. */
export function viewportFor(input: {
  device?: string;
  width?: number;
  height?: number;
  landscape?: boolean;
}): Viewport {
  if (input.device && /^(responsive|none|fill|off)$/i.test(input.device))
    return { width: null, height: null, device: null };
  const wanted = input.device?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const d = wanted
    ? DEVICES.find(
        (x) =>
          x.id.replace(/-/g, "") === wanted ||
          x.label.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted,
      )
    : undefined;
  if (input.device && !d)
    throw new Error(
      `Unknown device "${input.device}". Known: ${DEVICES.map((x) => x.label).join(", ")}.`,
    );
  let width = d?.width ?? input.width ?? null;
  let height = d?.height ?? input.height ?? null;
  if (input.landscape && width && height) [width, height] = [height, width];
  if (width !== null && (width < 200 || width > 4000)) throw new Error("Width must be 200–4000.");
  if (height !== null && (height < 200 || height > 4000))
    throw new Error("Height must be 200–4000.");
  return {
    width,
    height: height ?? (width ? Math.round(width * 1.6) : null),
    device: d?.id ?? null,
  };
}
