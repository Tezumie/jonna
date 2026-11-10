// What read_file returns: a text file's numbered lines, paged with offset; and (D253) an image,
// which goes to a vision model as a picture (a PNG at most 1568 px on its longer side, as pasted
// ones do), or a PDF, read as its text page by page (core/agent/pdfText.ts) and paged the same way.
import type { ToolOutcome } from "../../core/agent/loop";
import {
  MAX_PDF_PAGES,
  notebookCells,
  notebookRead,
  PDF_PAGES_UNASKED,
  pageRange,
  pagesLabel,
} from "../../core/agent/notebookText";
import { pdfText } from "../../core/agent/pdfText";
import { fsIpc } from "../../core/ipc/fs";
import { LINE_LIMIT, READ_LIMIT } from "./extensionFiles";
import { pngBase64 } from "./uploads";

/** Most characters one read_file returns (about 12k tokens); the rest with offset. */
const READ_CHARS = 48_000;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** The biggest image file read (it's decoded and shrunk first). */
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** The biggest PDF read. */
const PDF_MAX_BYTES = 60 * 1024 * 1024;

const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

/** read_file reads this as an image or a PDF rather than refusing a binary file. */
export function mediaKind(path: string): "image" | "pdf" | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  return ext in IMAGE_TYPES ? "image" : null;
}

/** An image for the model: attached to the result (vision models see it, others get the words). */
export async function readImageForAgent(
  path: string,
  name: string,
  size: number,
): Promise<ToolOutcome> {
  if (size > IMAGE_MAX_BYTES)
    return {
      result: `Error: ${name} is too large to look at (${(size / 1048576).toFixed(1)} MB, the limit is ${IMAGE_MAX_BYTES / 1048576} MB).`,
      isError: true,
      summary: "too large",
    };
  const bytes = await fsIpc.read(path);
  const png = await pngBase64(
    new Blob([bytes as BlobPart], { type: IMAGE_TYPES[extOf(path)] ?? "" }),
  );
  if (!png)
    return {
      result: `Error: ${name} couldn't be decoded as an image.`,
      isError: true,
      summary: "not an image",
    };
  return {
    result: `${name} is an image (${(bytes.length / 1024).toFixed(0)} KB); it's attached so you can see it. If you can't see images, ask the user what it shows.`,
    summary: "image",
    images: [png],
  };
}

/**
 * A PDF's text with page markers, for read_file's line paging; or a result saying why there's
 * none (scanned, encrypted, damaged).
 */
export async function readPdfForAgent(
  path: string,
  name: string,
  size: number,
): Promise<{ text: string; pages: number; pageTexts: string[] } | ToolOutcome> {
  if (size > PDF_MAX_BYTES)
    return {
      result: `Error: ${name} is too large to read (${(size / 1048576).toFixed(1)} MB, the limit is ${PDF_MAX_BYTES / 1048576} MB).`,
      isError: true,
      summary: "too large",
    };
  try {
    const pdf = await pdfText(await fsIpc.read(path));
    const words = pdf.pages.join("").trim().length;
    if (!words)
      return {
        result: pdf.encrypted
          ? `${name} is an encrypted PDF (${pdf.pages.length} pages): its text can't be read here.`
          : `${name} is a PDF with ${pdf.pages.length} pages but no text that can be read: it's probably scanned images. Ask the user, or run a tool that does OCR if the project has one.`,
        isError: true,
        summary: "no text",
      };
    return {
      text: pdf.pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n"),
      pages: pdf.pages.length,
      pageTexts: pdf.pages,
    };
  } catch (err) {
    return {
      result: `Error: ${name} couldn't be read as a PDF (${err instanceof Error ? err.message : String(err)}).`,
      isError: true,
      summary: "not readable",
    };
  }
}

/**
 * read_file's numbered lines of `text` from `args.offset`, cut to READ_LIMIT lines and READ_CHARS
 * characters. `kind` says what it was read from ("PDF, 12 pages").
 */
export function readLines(
  name: string,
  text: string,
  args: Record<string, unknown>,
  kind?: string,
): ToolOutcome {
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(READ_LIMIT, Math.max(1, Number(args.limit) || READ_LIMIT));
  if (offset > lines.length)
    return {
      result: `Error: ${name} has ${lines.length} lines; offset ${offset} is past its end.`,
      isError: true,
      summary: "past the end",
    };
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  // Minified or generated lines are cut (each costs tokens on every later request), and so is
  // the read as a whole: 400 long lines were most of a model's context in one result.
  const shown: string[] = [];
  let chars = 0;
  for (const [i, l] of slice.entries()) {
    const line = `${String(offset + i).padStart(5)}| ${l.length > LINE_LIMIT ? `${l.slice(0, LINE_LIMIT)}… [${l.length - LINE_LIMIT} more characters]` : l}`;
    if (shown.length && chars + line.length > READ_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
  }
  slice.length = shown.length;
  const body = shown.join("\n");
  const more =
    offset - 1 + slice.length < lines.length
      ? `\n… ${lines.length - (offset - 1 + slice.length)} more lines (offset ${offset + slice.length})`
      : "";
  return {
    result: `${name} (${kind ? `${kind}, ` : ""}${lines.length} lines)\n${body}${more}`,
    summary: `${slice.length} lines`,
    detail: slice.slice(0, 40).join("\n"),
  };
}

/** Whether read_file shows `path` as a Jupyter notebook's cells (D310). */
export function isNotebook(path: string): boolean {
  return extOf(path) === "ipynb";
}

/** A notebook's cells from `args.offset` (a cell number), `args.limit` cells (D310). */
export function readNotebook(
  name: string,
  json: string,
  args: Record<string, unknown>,
): ToolOutcome {
  const cells = notebookCells(json);
  // Not a notebook after all (a broken or odd file): its lines, as any text file.
  if (!Array.isArray(cells))
    return readLines(name, json, args, `not read as a notebook: ${cells.error}`);
  const r = notebookRead(
    name,
    cells,
    Math.max(1, Number(args.offset) || 1),
    Math.max(1, Number(args.limit) || cells.length || 1),
  );
  if ("error" in r) return { result: `Error: ${r.error}`, isError: true, summary: "past the end" };
  return { result: r.text, summary: `${r.shown} cells`, detail: r.text.slice(0, 4000) };
}

/**
 * A PDF's pages for read_file (D310): `pages` ("1-5", "3"; at most 20), else the whole PDF when
 * it's short, else its first 10 pages and how to ask for more. `offset` / `limit` still page by
 * line through what's read.
 */
export function readPdfPages(
  name: string,
  pdf: { pages: number; pageTexts: string[] },
  args: Record<string, unknown>,
): ToolOutcome {
  const all = pdf.pageTexts.map((_, i) => i + 1);
  let pages: number[];
  let note = "";
  if (args.pages !== undefined && args.pages !== null && args.pages !== "") {
    const r = pageRange(args.pages, pdf.pages);
    if (!Array.isArray(r))
      return { result: `Error: ${r.error}`, isError: true, summary: "bad pages" };
    pages = r;
  } else if (pdf.pages > PDF_PAGES_UNASKED && !args.offset) {
    pages = all.slice(0, PDF_PAGES_UNASKED);
    note = `\n… ${pdf.pages - PDF_PAGES_UNASKED} more pages: read them with pages, e.g. "${PDF_PAGES_UNASKED + 1}-${Math.min(pdf.pages, PDF_PAGES_UNASKED + MAX_PDF_PAGES)}" (at most ${MAX_PDF_PAGES} a call)`;
  } else pages = all;
  const text = pages.map((p) => `--- Page ${p} ---\n${pdf.pageTexts[p - 1] ?? ""}`).join("\n\n");
  const which = pages.length === pdf.pages ? "" : `; pages ${pagesLabel(pages)}`;
  const read = readLines(name, text, args, `PDF, ${pdf.pages} pages${which}`);
  return note && !read.isError ? { ...read, result: `${read.result}${note}` } : read;
}
