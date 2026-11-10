// Typed events. `Emitter` is a single event stream; `EventBus` is a named-event hub used for
// IDE-wide events such as `command.executed` that agents and extensions can observe.
import { type Disposable, toDisposable } from "../lifecycle/index";

export type Listener<T> = (value: T) => void;
export type Event<T> = (listener: Listener<T>) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();
  private disposed = false;

  /** Subscribe; the returned Disposable unsubscribes. */
  readonly event: Event<T> = (listener) => {
    if (this.disposed) return toDisposable(() => {});
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  };

  fire(value: T): void {
    // Copy so listeners may unsubscribe while being notified. One failing listener must not
    // prevent the others from running.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error("Event listener failed", err);
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** A hub of named, typed events: `bus.on("command.executed", e => …)`. */
export class EventBus<Events extends object> implements Disposable {
  private readonly emitters = new Map<keyof Events, Emitter<never>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Disposable {
    return this.emitter(type).event(listener);
  }

  emit<K extends keyof Events>(type: K, value: Events[K]): void {
    (this.emitters.get(type) as unknown as Emitter<Events[K]> | undefined)?.fire(value);
  }

  private emitter<K extends keyof Events>(type: K): Emitter<Events[K]> {
    let emitter = this.emitters.get(type) as unknown as Emitter<Events[K]> | undefined;
    if (!emitter) {
      emitter = new Emitter<Events[K]>();
      this.emitters.set(type, emitter as unknown as Emitter<never>);
    }
    return emitter;
  }

  dispose(): void {
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }
}
