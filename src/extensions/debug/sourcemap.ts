// Source maps (D145): what the debugger needs to show TypeScript (or any compiled source) while
// the runtime executes generated JavaScript — tsx / ts-node output, `tsc` builds with
// `sourceMap`, bundles. Source Map v3 (`mappings` in Base64 VLQ, `sourceRoot`, `sources`, inline
// `sourcesContent` ignored, index maps' `sections` flattened). Both directions: a generated
// position → its source line (call stacks, stops), a source line → where its code was generated
// (breakpoints, run to cursor). Lines and columns here are 0-based. DOM-free and tested.

interface Segment {
  genLine: number;
  genCol: number;
  source: number;
  line: number;
  col: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/** Decodes one segment's Base64 VLQ numbers ("AAgBC" → [0, 0, 16, 1]). */
export function decodeVlq(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of text) {
    const digit = B64_VALUE.get(c);
    if (digit === undefined) throw new Error(`Bad source map character "${c}"`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  return out;
}

interface RawMap {
  version?: number;
  sources?: (string | null)[];
  sourceRoot?: string;
  mappings?: string;
  sections?: { offset: { line: number; column: number }; map: RawMap }[];
}

export class SourceMap {
  /** Each source as an absolute path (null when it isn't a file, e.g. `webpack://`). */
  readonly sources: (string | null)[] = [];
  /** Per generated line, by column. */
  private readonly byGenerated: Segment[][] = [];
  /** Per source, by line then column. */
  private readonly bySource = new Map<number, Segment[]>();
  private readonly key: (path: string) => string;

  /**
   * `json`: the map. `base`: the URL the map's relative sources resolve against (the map file's
   * URL, or the script's for an inline map). `toPath`: a file: URL → path. `key`: path identity
   * (case-insensitive on Windows and macOS).
   */
  constructor(
    json: unknown,
    base: string,
    toPath: (url: string) => string | null,
    key: (path: string) => string = (p) => p,
  ) {
    this.key = key;
    this.add(json as RawMap, base, toPath, 0, 0);
    for (const line of this.byGenerated) line?.sort((a, b) => a.genCol - b.genCol);
    for (const list of this.bySource.values())
      list.sort((a, b) => a.line - b.line || a.col - b.col || a.genLine - b.genLine);
  }

  private add(
    raw: RawMap,
    base: string,
    toPath: (url: string) => string | null,
    lineOffset: number,
    colOffset: number,
  ): void {
    if (Array.isArray(raw.sections)) {
      for (const s of raw.sections) this.add(s.map, base, toPath, s.offset.line, s.offset.column);
      return;
    }
    const first = this.sources.length;
    const root = raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, "/") : "";
    for (const src of raw.sources ?? []) {
      let path: string | null = null;
      if (src !== null)
        try {
          // A source that is a URL already (`webpack://…`, `file:///…`) ignores sourceRoot.
          const absolute = /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
          const url = new URL(absolute ? src : root + src, base);
          // file: for Node; a page's http(s) and webpack:// sources map through its toPath.
          path = toPath(url.href);
        } catch {
          path = null;
        }
      this.sources.push(path);
    }
    let genLine = lineOffset;
    let genCol = 0;
    let source = 0;
    let line = 0;
    let col = 0;
    for (const lineText of (raw.mappings ?? "").split(";")) {
      genCol = genLine === lineOffset ? colOffset : 0;
      if (lineText)
        for (const seg of lineText.split(",")) {
          if (!seg) continue;
          const v = decodeVlq(seg);
          genCol += v[0] ?? 0;
          if (v.length < 4) continue;
          source += v[1] ?? 0;
          line += v[2] ?? 0;
          col += v[3] ?? 0;
          const s: Segment = { genLine, genCol, source: first + source, line, col };
          const row = this.byGenerated[genLine] ?? [];
          row.push(s);
          this.byGenerated[genLine] = row;
          const list = this.bySource.get(s.source) ?? [];
          list.push(s);
          this.bySource.set(s.source, list);
        }
      genLine++;
    }
  }

  private sourceIndex(path: string): number {
    const k = this.key(path);
    return this.sources.findIndex((s) => s !== null && this.key(s) === k);
  }

  hasSource(path: string): boolean {
    return this.sourceIndex(path) >= 0;
  }

  /** The source position of generated `line`:`col` (the mapping at or before it on that line). */
  original(line: number, col: number): { path: string; line: number; col: number } | null {
    const segs = this.byGenerated[line];
    if (!segs?.length) return null;
    let best = segs[0];
    for (const s of segs) if (s.genCol <= col) best = s;
    const path = best ? this.sources[best.source] : null;
    return best && path ? { path, line: best.line, col: best.col } : null;
  }

  /**
   * Where source `line` of `path` was generated: its first mapping, or the next mapped line's
   * (within a few lines, as breakpoints on blank lines move down); null if none.
   */
  generated(path: string, line: number): { line: number; col: number; sourceLine: number } | null {
    const list = this.bySource.get(this.sourceIndex(path));
    if (!list) return null;
    for (const s of list)
      if (s.line >= line && s.line <= line + 10)
        return { line: s.genLine, col: s.genCol, sourceLine: s.line };
    return null;
  }
}

/** The text of a `data:` source map URL (base64 or percent-encoded), or null. */
export function dataUrlText(url: string): string | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    if (m[2]) {
      const bin = atob(m[3] ?? "");
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    return decodeURIComponent(m[3] ?? "");
  } catch {
    return null;
  }
}
