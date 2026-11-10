// VS Code's EnvironmentVariableCollection (`context.environmentVariableCollection`, D264): what an
// extension changes in new terminals' environment (a port for its CLI, a virtualenv's PATH, a
// debugger's NODE_OPTIONS). Every change sends the whole set to the IDE once, a tick later, and
// the IDE applies it to each terminal it starts from then on. DOM-free and unit-tested.

import type { TerminalEnvChange } from "../rpcTerminals";
import { EnvironmentVariableMutatorType } from "./types";

interface MutatorOptions {
  applyAtProcessCreation?: boolean;
  applyAtShellIntegration?: boolean;
}

interface Mutator {
  readonly value: string;
  readonly type: EnvironmentVariableMutatorType;
  readonly options: MutatorOptions;
}

const TYPE_NAMES: Record<EnvironmentVariableMutatorType, TerminalEnvChange["type"]> = {
  [EnvironmentVariableMutatorType.Replace]: "replace",
  [EnvironmentVariableMutatorType.Append]: "append",
  [EnvironmentVariableMutatorType.Prepend]: "prepend",
};

export class EnvironmentVariableCollection {
  /** VS Code keeps a persistent collection across window reloads; the IDE re-applies it on start. */
  persistent = true;
  description: string | { value: string } | undefined;
  private readonly mutators = new Map<string, Mutator>();
  private scheduled = false;

  constructor(private readonly send: (changes: TerminalEnvChange[]) => void) {}

  replace(variable: string, value: string, options?: MutatorOptions): void {
    this.set(variable, value, EnvironmentVariableMutatorType.Replace, options);
  }

  append(variable: string, value: string, options?: MutatorOptions): void {
    this.set(variable, value, EnvironmentVariableMutatorType.Append, options);
  }

  prepend(variable: string, value: string, options?: MutatorOptions): void {
    this.set(variable, value, EnvironmentVariableMutatorType.Prepend, options);
  }

  get(variable: string): Mutator | undefined {
    return this.mutators.get(variable);
  }

  forEach(
    callback: (variable: string, mutator: Mutator, collection: this) => unknown,
    thisArg?: unknown,
  ): void {
    for (const [variable, mutator] of this.mutators)
      callback.call(thisArg, variable, mutator, this);
  }

  [Symbol.iterator](): IterableIterator<[string, Mutator]> {
    return new Map(this.mutators)[Symbol.iterator]();
  }

  delete(variable: string): void {
    if (this.mutators.delete(variable)) this.changed();
  }

  clear(): void {
    if (!this.mutators.size) return;
    this.mutators.clear();
    this.changed();
  }

  /** VS Code's per-folder collections: the IDE has one set per extension, so it's this one. */
  getScoped(_scope: unknown): this {
    return this;
  }

  /** What the IDE applies, in the order they were set. */
  changes(): TerminalEnvChange[] {
    return [...this.mutators].map(([variable, m]) => ({
      variable,
      value: m.value,
      type: TYPE_NAMES[m.type] ?? "replace",
    }));
  }

  private set(
    variable: string,
    value: string,
    type: EnvironmentVariableMutatorType,
    options: MutatorOptions = {},
  ): void {
    const name = String(variable);
    const text = String(value);
    const before = this.mutators.get(name);
    if (before && before.value === text && before.type === type) return;
    // Set again, it moves to the end (VS Code applies them in the order they were set).
    this.mutators.delete(name);
    this.mutators.set(name, { value: text, type, options: { ...options } });
    this.changed();
  }

  private changed(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.send(this.changes());
    });
  }
}
