// Running without a screen: the error services and commands throw when asked for something only a
// window has, and the wording the dispatcher gives a command that reached for the screen anyway.
// DOM-free.

/** Thrown where a screen is needed and there is none (a picker, a dialog, a view). */
export class NeedsScreenError extends Error {
  constructor(what: string) {
    super(`${what} needs a screen, and this session has none.`);
    this.name = "NeedsScreenError";
  }
}

/** The page's globals a command may reach for; in a runtime without a window they don't exist. */
const SCREEN_GLOBALS =
  /^(document|window|navigator|localStorage|sessionStorage|requestAnimationFrame|cancelAnimationFrame|getComputedStyle|matchMedia|ResizeObserver|MutationObserver|IntersectionObserver|Image|CSS|DOMParser|[A-Z][A-Za-z]*Element|[A-Z][A-Za-z]*Event) is not defined$/;

/**
 * What to say when a command failed with `err` where there is no screen: a readable message when
 * the failure is the missing screen (the runtime's "document is not defined"), else null.
 */
export function screenlessFailure(id: string, err: unknown): string | null {
  if (err instanceof NeedsScreenError) return err.message;
  if (err instanceof ReferenceError && SCREEN_GLOBALS.test(err.message))
    return `"${id}" needs a screen, and this session has none (${err.message}).`;
  return null;
}
