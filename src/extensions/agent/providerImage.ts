// A provider's own image (D212): a custom server can show a picture the user picks instead of its
// letter badge. Kept small (MAX_IMAGE_BYTES), checked to be the image type its name says, and
// stored in this computer's global state (beside recent folders and trust), never in the
// workspace or settings.json. The DOM-free checks are unit-tested.

/** Biggest image accepted: a badge is 32 px; this leaves room for a detailed SVG. */
export const MAX_IMAGE_BYTES = 256 * 1024;

export const IMAGE_EXTENSIONS = ["png", "svg", "jpg", "jpeg", "webp"] as const;

const MIME: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Whether the bytes start like the type (an SVG: an XML or <svg> start, no script). */
function looksLike(ext: string, bytes: Uint8Array): boolean {
  const at = (i: number) => bytes[i] ?? -1;
  switch (ext) {
    case "png":
      return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
    case "jpg":
    case "jpeg":
      return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case "webp":
      return (
        String.fromCharCode(at(0), at(1), at(2), at(3)) === "RIFF" &&
        String.fromCharCode(at(8), at(9), at(10), at(11)) === "WEBP"
      );
    case "svg": {
      const text = new TextDecoder().decode(bytes);
      // Shown as an <img> (where no script runs); refused anyway, like the bundled logos.
      return (
        /<svg[\s>]/i.test(text) && !/<script|\son[a-z]+\s*=|javascript:|<foreignObject/i.test(text)
      );
    }
    default:
      return false;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** An image file's bytes as a data URL, or the reason it can't be a provider's image. */
export function imageDataUrl(
  fileName: string,
  bytes: Uint8Array,
): { ok: true; dataUrl: string } | { ok: false; error: string } {
  const ext = fileName.toLowerCase().match(/\.([a-z]+)$/)?.[1] ?? "";
  const mime = MIME[ext];
  if (!mime) return { ok: false, error: "Pick a PNG, SVG, JPEG or WebP image." };
  if (bytes.length > MAX_IMAGE_BYTES)
    return {
      ok: false,
      error: `That image is over ${MAX_IMAGE_BYTES / 1024} KB. Pick a smaller one.`,
    };
  if (!bytes.length || !looksLike(ext, bytes))
    return { ok: false, error: `That file isn't a ${ext.toUpperCase()} image.` };
  return { ok: true, dataUrl: `data:${mime};base64,${base64(bytes)}` };
}

/** Whether a stored value is one of ours (a data URL of an accepted image type). */
export function isImageDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_BYTES * 2 &&
    /^data:image\/(png|svg\+xml|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}
