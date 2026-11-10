// The breakpoints that aren't on a line (D204), VS Code's Breakpoints section: function
// breakpoints (stop when a function by that name is called; kept per workspace), data
// breakpoints (stop when a value changes; they belong to the session that made them, so they go
// when it ends, as in VS Code for adapters that can't keep them) and the choices for an
// adapter's own exception filters (on or off, a condition; kept per filter id), and instruction
// breakpoints (an address in the disassembly view; kept while the IDE runs, not saved: addresses
// change between builds, as VS Code). DOM-free and tested.
import { type Signal, signal } from "../../core/reactive/index";
import type { ExceptionFilter, FilterChoice } from "./exceptionInfo";

export interface FunctionBreakpoint {
  id: number;
  name: string;
  condition?: string;
  hitCondition?: string;
  enabled: boolean;
  /** Set while a session runs: found and placed, or not. */
  verified?: boolean;
}

export interface DataBreakpoint {
  id: number;
  /** The adapter's id for the value (from dataBreakpointInfo). */
  dataId: string;
  /** What it watches, as the adapter describes it ("counter", "obj.x"). */
  description: string;
  accessType: "read" | "write" | "readWrite";
  enabled: boolean;
  /** The session it was made in. */
  sessionId: string;
  verified?: boolean;
}

/** A breakpoint on one machine instruction (DAP `setInstructionBreakpoints`). */
export interface InstructionBreakpoint {
  id: number;
  /** The instruction's address (the adapter's memory reference, "0x401a2c"). */
  address: string;
  enabled: boolean;
  verified?: boolean;
}

/** Addresses compare as numbers: "0x00401A2C" is "0x401a2c". */
export function sameAddress(a: string, b: string): boolean {
  const n = (x: string) => {
    try {
      return BigInt(x.trim()).toString();
    } catch {
      return x.trim().toLowerCase();
    }
  };
  return n(a) === n(b);
}

export class OtherBreakpoints {
  readonly instructions: Signal<readonly InstructionBreakpoint[]> = signal([]);
  readonly functions: Signal<readonly FunctionBreakpoint[]> = signal([]);
  readonly data: Signal<readonly DataBreakpoint[]> = signal([]);
  /** The user's choice per exception filter id. */
  readonly filterChoices: Signal<Readonly<Record<string, FilterChoice>>> = signal({});
  /** The filters of the last adapter that had some (shown in Breakpoints). */
  readonly filters: Signal<readonly ExceptionFilter[]> = signal([]);
  /** Whose filters those are (the configuration type, "debugpy"…). */
  readonly filtersType: Signal<string> = signal("");
  private nextId = 1;

  addFunction(
    name: string,
    opts: { condition?: string; hitCondition?: string } = {},
  ): FunctionBreakpoint {
    const n = name.trim();
    if (!n) throw new Error("A function breakpoint needs a function name.");
    const clean = {
      ...(opts.condition?.trim() ? { condition: opts.condition.trim() } : {}),
      ...(opts.hitCondition?.trim() ? { hitCondition: opts.hitCondition.trim() } : {}),
    };
    const existing = this.functions.peek().find((f) => f.name === n);
    if (existing) {
      const next = { id: existing.id, name: n, enabled: true, ...clean };
      this.functions.value = this.functions.peek().map((f) => (f.id === existing.id ? next : f));
      return next;
    }
    const bp: FunctionBreakpoint = { id: this.nextId++, name: n, enabled: true, ...clean };
    this.functions.value = [...this.functions.peek(), bp];
    return bp;
  }

  updateFunction(id: number, patch: Partial<Omit<FunctionBreakpoint, "id">>): void {
    this.functions.value = this.functions.peek().map((f) => {
      if (f.id !== id) return f;
      const next = { ...f, ...patch };
      if (!next.condition?.trim()) delete next.condition;
      if (!next.hitCondition?.trim()) delete next.hitCondition;
      return next;
    });
  }

  removeFunction(id: number): void {
    this.functions.value = this.functions.peek().filter((f) => f.id !== id);
  }

  addData(bp: Omit<DataBreakpoint, "id" | "enabled">): DataBreakpoint {
    const existing = this.data
      .peek()
      .find((d) => d.dataId === bp.dataId && d.sessionId === bp.sessionId);
    if (existing) return existing;
    const made: DataBreakpoint = { id: this.nextId++, enabled: true, ...bp };
    this.data.value = [...this.data.peek(), made];
    return made;
  }

  updateData(id: number, patch: Partial<Pick<DataBreakpoint, "enabled" | "verified">>): void {
    this.data.value = this.data.peek().map((d) => (d.id === id ? { ...d, ...patch } : d));
  }

  removeData(id: number): void {
    this.data.value = this.data.peek().filter((d) => d.id !== id);
  }

  /** Adds a breakpoint at `address`, or removes the one there. True when one was added. */
  toggleInstruction(address: string): boolean {
    const a = address.trim();
    if (!a) throw new Error("An instruction breakpoint needs an address.");
    const existing = this.instructions.peek().find((b) => sameAddress(b.address, a));
    if (existing) {
      this.removeInstruction(existing.id);
      return false;
    }
    this.instructions.value = [
      ...this.instructions.peek(),
      { id: this.nextId++, address: a, enabled: true },
    ];
    return true;
  }

  updateInstruction(
    id: number,
    patch: Partial<Pick<InstructionBreakpoint, "enabled" | "verified">>,
  ): void {
    this.instructions.value = this.instructions
      .peek()
      .map((b) => (b.id === id ? { ...b, ...patch } : b));
  }

  removeInstruction(id: number): void {
    this.instructions.value = this.instructions.peek().filter((b) => b.id !== id);
  }

  /** A session ended: its data breakpoints go. */
  sessionEnded(sessionId: string): void {
    if (this.data.peek().some((d) => d.sessionId === sessionId))
      this.data.value = this.data.peek().filter((d) => d.sessionId !== sessionId);
  }

  /** No session runs: nothing is placed any more. */
  clearVerification(): void {
    if (this.functions.peek().some((f) => f.verified !== undefined))
      this.functions.value = this.functions.peek().map(({ verified: _v, ...f }) => f);
    if (this.instructions.peek().some((b) => b.verified !== undefined))
      this.instructions.value = this.instructions.peek().map(({ verified: _v, ...b }) => b);
  }

  setFilter(filter: string, choice: Partial<FilterChoice>): void {
    const old = this.filterChoices.peek()[filter];
    const def = this.filters.peek().find((f) => f.filter === filter);
    const next: FilterChoice = {
      enabled: choice.enabled ?? old?.enabled ?? def?.default ?? false,
      ...((choice.condition ?? old?.condition)?.trim()
        ? { condition: (choice.condition ?? old?.condition ?? "").trim() }
        : {}),
    };
    this.filterChoices.value = { ...this.filterChoices.peek(), [filter]: next };
  }

  /** Whether `filter` is on (the choice, else the adapter's default). */
  filterOn(filter: string): boolean {
    const choice = this.filterChoices.peek()[filter];
    if (choice) return choice.enabled;
    return this.filters.peek().find((f) => f.filter === filter)?.default ?? false;
  }

  save(): {
    functionBreakpoints: {
      name: string;
      condition?: string;
      hitCondition?: string;
      enabled: boolean;
    }[];
    exceptionFilters: Record<string, FilterChoice>;
    exceptionFilterDefs: ExceptionFilter[];
    exceptionFilterType: string;
  } {
    return {
      functionBreakpoints: this.functions.peek().map(({ id: _i, verified: _v, ...f }) => f),
      exceptionFilters: { ...this.filterChoices.peek() },
      exceptionFilterDefs: [...this.filters.peek()],
      exceptionFilterType: this.filtersType.peek(),
    };
  }

  restore(data: unknown): void {
    const d = (data ?? {}) as {
      functionBreakpoints?: unknown;
      exceptionFilters?: unknown;
      exceptionFilterDefs?: unknown;
      exceptionFilterType?: unknown;
    };
    const fns: FunctionBreakpoint[] = [];
    for (const raw of Array.isArray(d.functionBreakpoints) ? d.functionBreakpoints : []) {
      const f = raw as Partial<FunctionBreakpoint> | null;
      if (!f || typeof f.name !== "string" || !f.name.trim()) continue;
      if (fns.some((x) => x.name === f.name)) continue;
      fns.push({
        id: this.nextId++,
        name: f.name.trim(),
        enabled: f.enabled !== false,
        ...(typeof f.condition === "string" && f.condition.trim()
          ? { condition: f.condition }
          : {}),
        ...(typeof f.hitCondition === "string" && f.hitCondition.trim()
          ? { hitCondition: f.hitCondition }
          : {}),
      });
    }
    this.functions.value = fns;
    this.data.value = [];
    const choices: Record<string, FilterChoice> = {};
    if (d.exceptionFilters && typeof d.exceptionFilters === "object")
      for (const [k, v] of Object.entries(d.exceptionFilters as Record<string, unknown>)) {
        const c = v as Partial<FilterChoice> | null;
        if (!c || typeof c.enabled !== "boolean") continue;
        choices[k] = {
          enabled: c.enabled,
          ...(typeof c.condition === "string" && c.condition.trim()
            ? { condition: c.condition }
            : {}),
        };
      }
    this.filterChoices.value = choices;
    this.filters.value = Array.isArray(d.exceptionFilterDefs)
      ? (d.exceptionFilterDefs as ExceptionFilter[]).filter(
          (f) => f && typeof f.filter === "string" && typeof f.label === "string",
        )
      : [];
    this.filtersType.value = typeof d.exceptionFilterType === "string" ? d.exceptionFilterType : "";
  }
}
