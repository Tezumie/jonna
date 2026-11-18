// Whether extension code may run in this page at all. In the app's window it always may: the
// page has an origin of its own with nothing else in it. The web build (src/web) can be served
// from an origin that also holds something worth stealing (the account pages keep a signed-in
// session there), and an extension's worker runs in the page's origin. There the entry turns
// extension code off for the whole session, before anything starts. DOM-free.

let blocked: string | null = null;

/** Turns extension code off for this page, for good. `reason` is what a person is told. */
export function blockExtensionCode(reason: string): void {
  blocked = reason;
}

/** Why extension code doesn't run here, or null when it does. */
export function extensionCodeBlocked(): string | null {
  return blocked;
}
