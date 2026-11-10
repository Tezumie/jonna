// DOM-free helpers of the hex viewer and the CSV preview (D118).

/** One hex-dump row: offset, 16 bytes as hex (a gap after 8), and the printable characters. */
export function hexRow(
  bytes: Uint8Array,
  offset: number,
): { offset: string; hex: string; text: string } {
  const end = Math.min(bytes.length, offset + 16);
  let hex = "";
  let text = "";
  for (let i = offset; i < offset + 16; i++) {
    if (i === offset + 8) hex += " ";
    if (i < end) {
      const b = bytes[i] ?? 0;
      hex += `${b.toString(16).padStart(2, "0")} `;
      text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    } else hex += "   ";
  }
  return { offset: offset.toString(16).padStart(8, "0"), hex: hex.trimEnd(), text };
}

/** The delimiter a CSV-like file uses: tab for .tsv, else the most common of , ; | in line 1. */
export function guessDelimiter(path: string, text: string): string {
  if (/\.tsv$/i.test(path)) return "\t";
  const nl = text.indexOf("\n");
  const first = text.slice(0, nl < 0 ? 2000 : Math.min(nl, 2000));
  let best = ",";
  let count = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = first.split(d).length - 1;
    if (n > count) {
      best = d;
      count = n;
    }
  }
  return best;
}

/**
 * RFC 4180 rows: quoted fields may hold the delimiter, newlines and "" for a quote. Stops after
 * `limit` rows (`truncated` says whether there was more).
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  limit = Number.POSITIVE_INFINITY,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= limit) return { rows, truncated: i + 1 < n };
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated: false };
}

export interface ZipEntry {
  name: string;
  size: number;
  compressed: number;
  /** Local time from the DOS date/time fields. */
  modified: Date | null;
  dir: boolean;
  encrypted: boolean;
}

/**
 * The entries of a ZIP archive (also .jar, .vsix, .whl, .epub…) from its central directory, or
 * null when it isn't one. Zip64 sizes beyond 4 GB show as -1.
 */
export function parseZip(bytes: Uint8Array): { entries: ZipEntry[]; comment: string } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  // End of central directory: the last 0x06054b50 within 64 KB + 22 bytes of the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  const commentLength = u16(eocd + 20);
  const utf8 = new TextDecoder();
  const comment = utf8.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLength));
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (u32(offset) !== 0x02014b50) return entries.length ? { entries, comment } : null;
    const flags = u16(offset + 8);
    const time = u16(offset + 12);
    const date = u16(offset + 14);
    const compressed = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLen = u16(offset + 32);
    const raw = bytes.subarray(offset + 46, offset + 46 + nameLength);
    // Bit 11: UTF-8 names; older tools wrote CP437, which is ASCII for the usual names.
    const name = flags & 0x800 ? utf8.decode(raw) : String.fromCharCode(...raw);
    const modified =
      date === 0
        ? null
        : new Date(
            (date >> 9) + 1980,
            ((date >> 5) & 15) - 1,
            date & 31,
            time >> 11,
            (time >> 5) & 63,
            (time & 31) * 2,
          );
    entries.push({
      name,
      size: size === 0xffffffff ? -1 : size,
      compressed: compressed === 0xffffffff ? -1 : compressed,
      modified,
      dir: name.endsWith("/"),
      encrypted: (flags & 1) === 1,
    });
    offset += 46 + nameLength + extraLength + commentLen;
  }
  return { entries, comment };
}

export type NotebookOutput =
  | { kind: "text"; text: string; error?: boolean }
  | { kind: "image"; mime: string; data: string }
  | { kind: "markdown"; text: string };

export interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const joined = (v: unknown): string =>
  Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";

/** A Jupyter notebook (nbformat 4) as cells and displayable outputs, or null if it isn't one. */
export function parseNotebook(json: unknown): { language: string; cells: NotebookCell[] } | null {
  if (!json || typeof json !== "object" || !Array.isArray((json as { cells?: unknown }).cells))
    return null;
  const nb = json as {
    cells: unknown[];
    metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } };
  };
  const language =
    nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python";
  const cells = nb.cells.flatMap((raw): NotebookCell[] => {
    if (!raw || typeof raw !== "object") return [];
    const c = raw as {
      cell_type?: string;
      source?: unknown;
      execution_count?: number | null;
      outputs?: unknown[];
    };
    const kind = c.cell_type === "markdown" ? "markdown" : c.cell_type === "code" ? "code" : "raw";
    const outputs: NotebookOutput[] = [];
    for (const o of c.outputs ?? []) {
      if (!o || typeof o !== "object") continue;
      const out = o as {
        output_type?: string;
        text?: unknown;
        data?: Record<string, unknown>;
        ename?: string;
        evalue?: string;
        traceback?: unknown;
      };
      if (out.output_type === "stream") outputs.push({ kind: "text", text: joined(out.text) });
      else if (out.output_type === "error")
        outputs.push({
          kind: "text",
          error: true,
          text: (
            joined(Array.isArray(out.traceback) ? out.traceback.join("\n") : "") ||
            `${out.ename ?? "Error"}: ${out.evalue ?? ""}`
          ).replace(ANSI, ""),
        });
      else if (out.data) {
        const d = out.data;
        const image = ["image/png", "image/jpeg", "image/gif"].find(
          (m) => typeof d[m] === "string" || Array.isArray(d[m]),
        );
        if (image)
          outputs.push({ kind: "image", mime: image, data: joined(d[image]).replace(/\s/g, "") });
        else if (d["text/markdown"] !== undefined)
          outputs.push({ kind: "markdown", text: joined(d["text/markdown"]) });
        else if (d["text/plain"] !== undefined)
          outputs.push({ kind: "text", text: joined(d["text/plain"]).replace(ANSI, "") });
      }
    }
    return [
      {
        kind,
        source: joined(c.source),
        executionCount: typeof c.execution_count === "number" ? c.execution_count : null,
        outputs,
      },
    ];
  });
  return { language, cells };
}
