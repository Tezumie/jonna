// Animated GIF writing (D340): the agent's browser recordings. GIF because every image viewer,
// chat app and issue tracker plays it, and the IDE's webview shows it in an <img>; animated WebP
// and APNG would need an encoder of the same size and play in fewer places. No dependency: a
// median-cut palette per frame (15-bit color histogram), LZW with variable code sizes, and each
// frame cropped to what changed since the previous one (drawn over it: disposal "keep"), so a
// recording of a page where little moves stays small. DOM-free and tested.

/** RGBA pixels, 4 bytes each, rows top to bottom. */
export type Rgba = Uint8Array | Uint8ClampedArray;

export interface Palette {
  /** RGB triples, at most 256. */
  colors: Uint8Array;
  /** Palette index of each pixel. */
  indices: Uint8Array;
}

const BINS = 32768;
const binOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * At most `max` colors for `rgba` (alpha ignored). An image with that few distinct colors keeps
 * them exactly; otherwise median cut over a 15-bit histogram, each box's color the average of the
 * pixels in it.
 */
export function quantize(rgba: Rgba, max = 256): Palette {
  const pixels = rgba.length >> 2;
  const indices = new Uint8Array(pixels);
  // Few colors (flat UI, a test image): exact.
  const exact = new Map<number, number>();
  let overflow = false;
  for (let i = 0; i < pixels; i++) {
    const c = ((rgba[i * 4] ?? 0) << 16) | ((rgba[i * 4 + 1] ?? 0) << 8) | (rgba[i * 4 + 2] ?? 0);
    let at = exact.get(c);
    if (at === undefined) {
      if (exact.size >= max) {
        overflow = true;
        break;
      }
      at = exact.size;
      exact.set(c, at);
    }
    indices[i] = at;
  }
  if (!overflow) {
    const colors = new Uint8Array(exact.size * 3);
    for (const [c, at] of exact) {
      colors[at * 3] = (c >> 16) & 255;
      colors[at * 3 + 1] = (c >> 8) & 255;
      colors[at * 3 + 2] = c & 255;
    }
    return { colors, indices };
  }
  const count = new Uint32Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const bin = binOf(r, g, b);
    count[bin] = (count[bin] ?? 0) + 1;
    sumR[bin] = (sumR[bin] ?? 0) + r;
    sumG[bin] = (sumG[bin] ?? 0) + g;
    sumB[bin] = (sumB[bin] ?? 0) + b;
  }
  const used: number[] = [];
  for (let bin = 0; bin < BINS; bin++) if (count[bin]) used.push(bin);
  const boxes = medianCut(used, count, max);
  const colors = new Uint8Array(boxes.length * 3);
  const lookup = new Uint8Array(BINS);
  boxes.forEach((box, at) => {
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const bin of box) {
      n += count[bin] ?? 0;
      r += sumR[bin] ?? 0;
      g += sumG[bin] ?? 0;
      b += sumB[bin] ?? 0;
      lookup[bin] = at;
    }
    colors[at * 3] = Math.round(r / n);
    colors[at * 3 + 1] = Math.round(g / n);
    colors[at * 3 + 2] = Math.round(b / n);
  });
  for (let i = 0; i < pixels; i++)
    indices[i] = lookup[binOf(rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0)] ?? 0;
  return { colors, indices };
}

const channel = (bin: number, c: number) => (bin >> (10 - c * 5)) & 31;

/** Splits the histogram's used bins into at most `max` boxes (the most populous, widest first). */
function medianCut(used: number[], count: Uint32Array, max: number): number[][] {
  const boxes: number[][] = [used];
  while (boxes.length < max) {
    // The box to split: the largest population times its widest range.
    let best = -1;
    let bestScore = 0;
    let bestChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      let population = 0;
      const lo = [31, 31, 31];
      const hi = [0, 0, 0];
      for (const bin of box) {
        population += count[bin] ?? 0;
        for (let c = 0; c < 3; c++) {
          const v = channel(bin, c);
          if (v < (lo[c] ?? 0)) lo[c] = v;
          if (v > (hi[c] ?? 0)) hi[c] = v;
        }
      }
      const ranges = [0, 1, 2].map((c) => (hi[c] ?? 0) - (lo[c] ?? 0));
      const widest = ranges.indexOf(Math.max(...ranges));
      const score = population * ((ranges[widest] ?? 0) + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
        bestChannel = widest;
      }
    });
    if (best < 0) break;
    const box = (boxes[best] ?? []).sort(
      (a, b) => channel(a, bestChannel) - channel(b, bestChannel),
    );
    // Split at the weighted median, never leaving a side empty.
    let total = 0;
    for (const bin of box) total += count[bin] ?? 0;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += count[box[i] ?? 0] ?? 0;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes;
}

/** Bits per palette index: the color table holds 2^bits entries (at least 2, as GIF requires). */
export function tableBits(colors: number): number {
  let bits = 1;
  while (1 << bits < colors) bits++;
  return bits;
}

/** GIF's LZW (variable code sizes up to 12 bits, a clear code when the table fills), in sub-blocks. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new ByteWriter();
  let bitBuffer = 0;
  let bitCount = 0;
  const block: number[] = [];
  const emitByte = (b: number) => {
    block.push(b);
    if (block.length === 255) {
      out.byte(255);
      out.bytes(block);
      block.length = 0;
    }
  };
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      emitByte(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  // Open addressing: key (prefix << 8 | next) → code. Small, so a clear resets it cheaply.
  const SIZE = 8192;
  const keys = new Int32Array(SIZE).fill(-1);
  const codes = new Int16Array(SIZE);
  let nextCode = end + 1;
  const reset = () => {
    keys.fill(-1);
    nextCode = end + 1;
    codeSize = minCodeSize + 1;
  };
  emit(clear);
  if (indices.length) {
    let prefix = indices[0] ?? 0;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i] ?? 0;
      const key = (prefix << 8) | k;
      let slot = (key * 2654435761) >>> 19;
      let found = -1;
      while (keys[slot] !== -1) {
        if (keys[slot] === key) {
          found = codes[slot] ?? -1;
          break;
        }
        slot = (slot + 1) & (SIZE - 1);
      }
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        keys[slot] = key;
        codes[slot] = nextCode;
        // The decoder widens its codes one step later than the table grows past the size.
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
        nextCode++;
      } else {
        emit(clear);
        reset();
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(end);
  if (bitCount > 0) emitByte(bitBuffer & 255);
  if (block.length) {
    out.byte(block.length);
    out.bytes(block);
  }
  out.byte(0);
  return out.done();
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private current: number[] = [];
  private length = 0;
  byte(b: number): void {
    this.current.push(b & 255);
    if (this.current.length >= 65536) this.flush();
  }
  bytes(list: ArrayLike<number>): void {
    for (let i = 0; i < list.length; i++) this.byte(list[i] ?? 0);
  }
  u16(v: number): void {
    this.byte(v & 255);
    this.byte((v >> 8) & 255);
  }
  ascii(text: string): void {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }
  chunk(data: Uint8Array): void {
    this.flush();
    this.chunks.push(data);
    this.length += data.length;
  }
  private flush(): void {
    if (!this.current.length) return;
    this.chunks.push(Uint8Array.from(this.current));
    this.length += this.current.length;
    this.current = [];
  }
  done(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

interface EncodedFrame {
  /** Image descriptor, color table and image data (everything after the control extension). */
  image: Uint8Array;
  /** When it was shown, ms from the recording's start. */
  at: number;
}

/** The rectangle of pixels that differ between two same-size images, or null when none do. */
export function changedRect(
  a: Rgba,
  b: Rgba,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return top < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** The pixels of `rect` of an image `width` wide. */
function crop(rgba: Rgba, width: number, rect: { x: number; y: number; w: number; h: number }) {
  const out = new Uint8Array(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const from = ((rect.y + y) * width + rect.x) * 4;
    out.set(rgba.subarray(from, from + rect.w * 4), y * rect.w * 4);
  }
  return out;
}

/** Frame delays in GIF's hundredths of a second: at least 2 (viewers slow down shorter ones). */
export function delaysCs(times: readonly number[], endMs: number): number[] {
  return times.map((t, i) => {
    const next = times[i + 1] ?? endMs;
    return Math.min(65535, Math.max(2, Math.round((next - t) / 10)));
  });
}

/**
 * An animated GIF built frame by frame (each encoded as it comes, so only the last frame's pixels
 * are kept): `add` frames of the writer's size with their time, then `finish`.
 */
export class GifWriter {
  private readonly frames: EncodedFrame[] = [];
  private previous: Uint8Array | null = null;
  private bytes = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (width < 1 || height < 1 || width > 65535 || height > 65535)
      throw new Error("A GIF is 1 to 65535 pixels on each side.");
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Bytes encoded so far (roughly the file's size). */
  get size(): number {
    return this.bytes;
  }

  /**
   * Adds a frame shown from `at` ms. Returns false when it's the same as the one before (nothing
   * added: the previous frame stays on screen longer).
   */
  add(rgba: Rgba, at: number): boolean {
    if (rgba.length !== this.width * this.height * 4)
      throw new Error(
        `A frame of ${this.width}×${this.height} has ${this.width * this.height * 4} bytes.`,
      );
    const rect = this.previous
      ? changedRect(this.previous, rgba, this.width, this.height)
      : { x: 0, y: 0, w: this.width, h: this.height };
    if (!rect) return false;
    const pixels =
      rect.w === this.width && rect.h === this.height ? rgba : crop(rgba, this.width, rect);
    const { colors, indices } = quantize(pixels);
    const bits = tableBits(colors.length / 3);
    const w = new ByteWriter();
    w.byte(0x2c);
    w.u16(rect.x);
    w.u16(rect.y);
    w.u16(rect.w);
    w.u16(rect.h);
    w.byte(0x80 | (bits - 1));
    w.chunk(colors);
    for (let i = colors.length; i < (1 << bits) * 3; i++) w.byte(0);
    const minCodeSize = Math.max(2, bits);
    w.byte(minCodeSize);
    w.chunk(lzwEncode(indices, minCodeSize));
    const image = w.done();
    this.frames.push({ image, at });
    this.bytes += image.length + 8;
    this.previous = Uint8Array.from(rgba);
    return true;
  }

  /** The file: frames shown until the next one's time, the last until `endMs`; loops forever. */
  finish(endMs: number): Uint8Array {
    const out = new ByteWriter();
    out.ascii("GIF89a");
    out.u16(this.width);
    out.u16(this.height);
    // No global color table (each frame has its own), 8 bits of color resolution.
    out.byte(0x70);
    out.byte(0);
    out.byte(0);
    // NETSCAPE2.0: loop forever.
    out.bytes([0x21, 0xff, 0x0b]);
    out.ascii("NETSCAPE2.0");
    out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
    const delays = delaysCs(
      this.frames.map((f) => f.at),
      endMs,
    );
    this.frames.forEach((frame, i) => {
      // Graphic control: disposal 1 (keep: the next frame draws over this one), the delay.
      out.bytes([0x21, 0xf9, 0x04, 0x04]);
      out.u16(delays[i] ?? 2);
      out.bytes([0x00, 0x00]);
      out.chunk(frame.image);
    });
    out.byte(0x3b);
    return out.done();
  }
}
