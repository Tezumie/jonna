// Signing in to the IDE's account when the front end is a page in a browser (src/web, D467).
// There the sign-in page can't come back to a listener on the host (the host is another
// computer), so the page receives the code itself and hands it on (`accountsIpc.signInWithCode`).
// The web entry installs how; the accounts extension asks. Nothing is installed in the app's
// own window. DOM-free.

/** What a finished trip to the sign-in page gives: the code, and what it was asked with. */
export interface CodeSignIn {
  code: string;
  verifier: string;
  /** The address the code was sent to (the server checks it again). */
  redirect: string;
}

/** Runs the sign-in in the browser for the accounts server `base`. */
export type PageSignIn = (base: string) => Promise<CodeSignIn>;

let ask: PageSignIn | null = null;
let arrived: CodeSignIn | null = null;
let noted: ((signedIn: boolean) => void) | null = null;

/** Installs the page's way to sign in (null: the host's own way, as in the app's window). */
export function setPageSignIn(next: PageSignIn | null): void {
  ask = next;
}

export function pageSignIn(): PageSignIn | null {
  return ask;
}

/** A code the page was opened with (the account service signed the person's machine in). */
export function setArrivedSignIn(code: CodeSignIn | null): void {
  arrived = code;
}

/** The code the page was opened with, once: a code works one time. */
export function takeArrivedSignIn(): CodeSignIn | null {
  const code = arrived;
  arrived = null;
  return code;
}

/** Who wants to know whether the host is signed in (the page asks for no code when it is). */
export function onAccountKnown(handler: ((signedIn: boolean) => void) | null): void {
  noted = handler;
}

export function noteAccount(signedIn: boolean): void {
  noted?.(signedIn);
}
