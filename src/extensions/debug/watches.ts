// Watch expressions (D145), VS Code's Watch section: expressions kept per workspace, evaluated
// in the selected frame whenever the program stops or another frame is chosen; objects expand
// like variables. DOM-free.
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import type { DebugController } from "./controller";

export interface WatchValue {
  value: string;
  /** > 0: expandable (`session.variables(ref)`). */
  ref: number;
  error?: boolean;
}

export class Watches {
  readonly expressions: Signal<readonly string[]> = signal([]);
  /** The last values, while a session is paused (empty otherwise). */
  readonly values: Signal<ReadonlyMap<string, WatchValue>> = signal(new Map());
  private run = 0;

  constructor(
    private readonly debug: DebugController,
    sub: DisposableStore,
  ) {
    sub.add(
      effect(() => {
        const list = this.expressions.value;
        const state = debug.state.value;
        debug.frameVersion.value;
        void this.evaluate(list, state === "stopped");
        return undefined;
      }),
    );
  }

  private async evaluate(list: readonly string[], paused: boolean): Promise<void> {
    const run = ++this.run;
    const session = this.debug.active;
    if (!session || !paused) {
      if (this.values.peek().size) this.values.value = new Map();
      return;
    }
    const out = new Map<string, WatchValue>();
    for (const expression of list) {
      try {
        const r = await session.evaluate(expression, this.debug.frameId(), "watch");
        out.set(expression, { value: r.value, ref: r.ref });
      } catch (err) {
        out.set(expression, {
          value: err instanceof Error ? err.message : String(err),
          ref: 0,
          error: true,
        });
      }
      if (run !== this.run) return;
    }
    this.values.value = out;
  }

  add(expression: string): void {
    const e = expression.trim();
    if (!e || this.expressions.peek().includes(e)) return;
    this.expressions.value = [...this.expressions.peek(), e];
  }

  remove(expression: string): void {
    this.expressions.value = this.expressions.peek().filter((x) => x !== expression);
  }

  /** Edits one in place (empty removes it). */
  replace(old: string, next: string): void {
    const e = next.trim();
    if (!e) {
      this.remove(old);
      return;
    }
    this.expressions.value = this.expressions
      .peek()
      .map((x) => (x === old ? e : x))
      .filter((x, i, all) => all.indexOf(x) === i);
  }

  clear(): void {
    this.expressions.value = [];
  }

  save(): string[] {
    return [...this.expressions.peek()];
  }

  restore(data: unknown): void {
    this.expressions.value = Array.isArray(data)
      ? data.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
  }
}
