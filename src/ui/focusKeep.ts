// Keeping keyboard focus across a list that's rebuilt (D244): the focused row is found again by a
// data attribute it carries (its room, its session, its command) and focused in the new rows.

const KEYS = ["room", "session", "command", "show", "status"] as const;

/** Runs `redraw` on `host`, then puts focus back on the row that had it, if there's one like it. */
export function keepFocus(host: HTMLElement, redraw: () => void): void {
  const active = host.ownerDocument.activeElement;
  const had = active instanceof HTMLElement && host.contains(active) ? active : null;
  const key = had ? KEYS.find((k) => had.dataset[k] !== undefined) : undefined;
  const value = key && had ? had.dataset[key] : undefined;
  redraw();
  if (!key || value === undefined) return;
  const attr = `data-${key}`;
  for (const el of host.querySelectorAll<HTMLElement>(`[${attr}]`))
    if (el.getAttribute(attr) === value) {
      el.focus({ preventScroll: true });
      return;
    }
}
