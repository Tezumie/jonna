// Files into a page (D339), after Claude in Chrome's file_upload and upload_image: workspace files
// or a screenshot the agent took, set on an <input type=file> (through a DataTransfer, with input
// and change events) or dropped on a drop zone (dragenter, dragover, drop carrying the files).
// What goes where is decided here from what the bridge says the target is. DOM-free and tested.

/** At most this many files in one upload. */
export const UPLOAD_MAX_FILES = 20;
/** At most this many bytes in one upload: the bytes travel to the page as base64. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export type UploadSource = { kind: "path"; path: string } | { kind: "screenshot"; id: string };

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);

/** browser_act upload's `files` (paths) and `screenshot` (ids) → what to read, in order. */
export function uploadSources(args: Record<string, unknown>): UploadSource[] {
  const paths = list(args.files ?? args.paths ?? args.path);
  const shots = list(args.screenshot ?? args.image);
  const sources: UploadSource[] = [
    ...paths.map((path) => ({ kind: "path" as const, path })),
    ...shots.map((id) => ({ kind: "screenshot" as const, id })),
  ];
  if (!sources.length)
    throw new Error(
      "upload: give `files` (workspace paths) or `screenshot` (an id from the screenshot tool).",
    );
  if (sources.length > UPLOAD_MAX_FILES)
    throw new Error(`upload: at most ${UPLOAD_MAX_FILES} files at once.`);
  return sources;
}

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The MIME type a browser gives a file of this name ("" when it doesn't know, as browsers do). */
export function mimeType(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (TYPES[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

/** What the bridge found at the target (input.fileTarget). */
export interface FileTarget {
  /** A file input (itself, or the one a label is for), or anything else (dropped on). */
  kind: "input" | "drop";
  multiple?: boolean;
  accept?: string;
  disabled?: boolean;
  /** How the element reads in a snapshot: input "Photo" [ref=e4]. */
  label: string;
}

export interface PlannedFile {
  name: string;
  type: string;
  size: number;
}

/** Whether a file input's `accept` ("image/*,.pdf") takes the file (none: anything). */
export function acceptMatches(accept: string | undefined, file: { name: string; type: string }) {
  const tokens = (accept ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((t) =>
    t.startsWith(".")
      ? name.endsWith(t)
      : t.endsWith("/*")
        ? type.startsWith(t.slice(0, -1))
        : type === t,
  );
}

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Why these files are too much for one upload, or null. */
export function sizeProblem(files: readonly PlannedFile[]): string | null {
  const total = files.reduce((n, f) => n + f.size, 0);
  return total > UPLOAD_MAX_BYTES
    ? `upload: ${kb(total)} is more than the ${kb(UPLOAD_MAX_BYTES)} one upload can carry.`
    : null;
}

export type TransferPlan =
  | { mode: "input" | "drop"; files: PlannedFile[]; notes: string[] }
  | { error: string };

/**
 * How the files reach the target: set on a file input (one only, unless it takes several), or
 * dropped on anything else. The page's `accept` isn't enforced by browsers for scripts either: a
 * file it doesn't list still goes, with a note (the page may refuse it itself).
 */
export function planTransfer(target: FileTarget, files: readonly PlannedFile[]): TransferPlan {
  if (!files.length) return { error: "upload: no files." };
  const tooMuch = sizeProblem(files);
  if (tooMuch) return { error: tooMuch };
  if (target.kind === "drop") return { mode: "drop", files: [...files], notes: [] };
  if (target.disabled) return { error: `upload: ${target.label} is disabled.` };
  if (files.length > 1 && !target.multiple)
    return {
      error: `upload: ${target.label} takes one file (no \`multiple\`); upload one at a time.`,
    };
  const notes = files
    .filter((f) => !acceptMatches(target.accept, f))
    .map((f) => `${f.name} isn't of a type the input lists (accept="${target.accept ?? ""}").`);
  return { mode: "input", files: [...files], notes };
}

/** One line on what was uploaded, for the agent: "a.png (12 KB), b.pdf (1.2 MB)". */
export function describeFiles(files: readonly PlannedFile[]): string {
  return files.map((f) => `${f.name} (${kb(f.size)})`).join(", ");
}
