// The disassembly view's instructions (D229), VS Code's: a window of instructions around the paused
// frame's, grown on demand when the view scrolls to either end (DAP `disassemble` with an
// instruction offset from the first or last one loaded), sorted by address, without duplicates
// or the placeholders adapters return past the ends of memory. DOM-free and tested.
import type { Instruction } from "./session";

/** How the model asks the debugger for instructions (DAP `disassemble`). */
export type Disassemble = (
  memoryReference: string,
  instructionOffset: number,
  count: number,
) => Promise<Instruction[]>;

/** The most rows kept: past it, the far end is dropped. */
export const MAX_ROWS = 4000;

/** An address as a number (null when it isn't one: "??", a symbol). */
export function addressValue(address: string): bigint | null {
  const a = address.trim();
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(a)) return null;
  try {
    return BigInt(a);
  } catch {
    return null;
  }
}

/**
 * `existing` with `incoming` added: by address, each once (the newer answer wins), in address
 * order, invalid ones dropped. `keep` says which end to keep past MAX_ROWS.
 */
export function mergeInstructions(
  existing: readonly Instruction[],
  incoming: readonly Instruction[],
  keep: "start" | "end" = "start",
): Instruction[] {
  const byAddress = new Map<bigint, Instruction>();
  for (const i of [...existing, ...incoming]) {
    const n = addressValue(i.address);
    if (n === null || !i.instruction.trim() || /^\?+$/.test(i.instruction.trim())) continue;
    byAddress.set(n, i);
  }
  const sorted = [...byAddress.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, i]) => i);
  if (sorted.length <= MAX_ROWS) return sorted;
  return keep === "start" ? sorted.slice(0, MAX_ROWS) : sorted.slice(-MAX_ROWS);
}

/** The row of `address` in `rows` (-1: not loaded). */
export function rowOf(rows: readonly Instruction[], address: string): number {
  const n = addressValue(address);
  if (n === null) return rows.findIndex((r) => r.address === address);
  return rows.findIndex((r) => addressValue(r.address) === n);
}

/** One instruction as a line of text (agents, copying). */
export function instructionLine(i: Instruction, current: boolean): string {
  const where =
    i.line !== undefined ? `    ; ${i.path ? `${i.path.split(/[\\/]/).pop()}:` : ""}${i.line}` : "";
  return `${current ? "=>" : "  "} ${i.address.padEnd(18)} ${(i.bytes ?? "").padEnd(24)} ${i.instruction}${i.symbol ? `    ; ${i.symbol}` : ""}${where}`;
}

export class DisassemblyModel {
  rows: Instruction[] = [];
  /** The paused frame's instruction. */
  current: string | null = null;
  /** A request under way: ends don't load twice at once. */
  private busy = false;
  /** An end that returned nothing new: don't ask again until the next open. */
  private exhausted = { before: false, after: false };

  constructor(private readonly disassemble: Disassemble) {}

  /** Loads `count` instructions around `address` (a quarter before it). */
  async open(address: string, count = 200): Promise<void> {
    this.current = address;
    this.exhausted = { before: false, after: false };
    const before = Math.floor(count / 4);
    const list = await this.disassemble(address, -before, count);
    this.rows = mergeInstructions([], list);
  }

  /** Marks `address` current; false when it isn't loaded (open() it instead). */
  moveTo(address: string): boolean {
    this.current = address;
    return rowOf(this.rows, address) >= 0;
  }

  /** Adds `list`; how many of its instructions weren't there yet. */
  private grow(list: readonly Instruction[], keep: "start" | "end"): number {
    const known = new Set(this.rows.map((r) => addressValue(r.address)));
    const fresh = mergeInstructions([], list).filter((i) => !known.has(addressValue(i.address)));
    this.rows = mergeInstructions(this.rows, list, keep);
    return fresh.length;
  }

  /** `count` more before the first row; how many rows were added. */
  async loadBefore(count = 100): Promise<number> {
    const first = this.rows[0];
    if (!first || this.busy || this.exhausted.before) return 0;
    this.busy = true;
    try {
      const list = await this.disassemble(first.address, -count, count);
      const added = this.grow(list, "start");
      if (added === 0) this.exhausted.before = true;
      return added;
    } finally {
      this.busy = false;
    }
  }

  /** `count` more after the last row; how many rows were added. */
  async loadAfter(count = 100): Promise<number> {
    const last = this.rows.at(-1);
    if (!last || this.busy || this.exhausted.after) return 0;
    this.busy = true;
    try {
      const list = await this.disassemble(last.address, 1, count);
      const added = this.grow(list, "end");
      if (added === 0) this.exhausted.after = true;
      return added;
    } finally {
      this.busy = false;
    }
  }
}
