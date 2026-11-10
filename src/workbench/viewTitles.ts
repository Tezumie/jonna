// Titles and descriptions views' code sets (VS Code's TreeView / WebviewView `title` and
// `description`): the view's header (sidebar, section, dock tab) shows the title instead of the
// descriptor's, with the description beside it in a quieter color. DOM-free and unit-tested.
import { type Signal, signal } from "../core/reactive/index";

/** A view's title and description set from code. */
export interface ViewTitle {
  title?: string;
  description?: string;
}

const MAX = 200;

export class ViewTitles {
  readonly all: Signal<ReadonlyMap<string, ViewTitle>> = signal<ReadonlyMap<string, ViewTitle>>(
    new Map(),
  );

  /** Sets view `id`'s title and description (both empty or absent: back to its own). */
  set(id: string, next: ViewTitle): void {
    const clean = (v: string | undefined) => (v?.trim() ? v.trim().slice(0, MAX) : undefined);
    const title = clean(next.title);
    const description = clean(next.description);
    const current = this.all.peek().get(id);
    if (current?.title === title && current?.description === description) return;
    const map = new Map(this.all.peek());
    if (title === undefined && description === undefined) map.delete(id);
    else map.set(id, { ...(title && { title }), ...(description && { description }) });
    this.all.value = map;
  }

  /** The title view `view` shows now: one set from code, else its own (tracked in effects). */
  titleOf(view: { id: string; title: string }): string {
    return this.all.value.get(view.id)?.title ?? view.title;
  }

  /** Its description set from code, if any (tracked in effects). */
  descriptionOf(id: string): string | undefined {
    return this.all.value.get(id)?.description;
  }
}
