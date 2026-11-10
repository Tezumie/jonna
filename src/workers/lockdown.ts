// Locking a worker down before untrusted code runs in it (D102, D203; shared with workflow
// scripts, D338): the network, storage, nested workers and script loading are removed, and once
// the code's own function exists, code generation too.

const scope = self as unknown as Record<string, unknown>;

/** Removes ways out of the sandbox (network, storage, nested workers, script loading). */
export function lockdown(): void {
  const names = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "WebSocketStream",
    "EventSource",
    "WebTransport",
    "importScripts",
    "indexedDB",
    "caches",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "RTCPeerConnection",
    "Request",
    "FileReaderSync",
    // A font face loads its `url(…)` from anywhere (the worker has no CSP of its own).
    "FontFace",
    "fonts",
  ];
  let target: object | null = scope;
  while (target && target !== Object.prototype) {
    for (const name of names) {
      try {
        if (Object.getOwnPropertyDescriptor(target, name))
          Object.defineProperty(target, name, {
            value: undefined,
            configurable: false,
            writable: false,
          });
      } catch {
        // not configurable on this engine: shadow it on the global instead
        try {
          Object.defineProperty(scope, name, { value: undefined, configurable: false });
        } catch {
          /* already locked */
        }
      }
    }
    target = Object.getPrototypeOf(target);
  }
  // The origin's file system (navigator.storage.getDirectory) is shared by every extension's
  // worker and kept on disk: a channel between extensions and around the storage limit.
  const nav = scope.navigator as object | undefined;
  let proto: object | null = nav ?? null;
  while (proto && proto !== Object.prototype) {
    for (const name of ["storage", "serviceWorker"])
      try {
        if (Object.getOwnPropertyDescriptor(proto, name))
          Object.defineProperty(proto, name, { value: undefined, configurable: false });
      } catch {
        /* already locked */
      }
    proto = Object.getPrototypeOf(proto);
  }
}

/**
 * Removes code generation once the extension's own function exists (D203 audit): `import()` is
 * syntax and can't be removed, and it loads from any URL, so code that builds new code at run
 * time (eval, new Function, a constructor reached through a function, string timers) could
 * reach the network without the "network" permission. The source itself is checked for
 * `import(` before it runs.
 */
export function lockCodeGeneration(message: string): void {
  const refuse = () => {
    throw new Error(message);
  };
  // Each function constructor stays itself for `instanceof` and its prototype, but can't be
  // called or constructed any more.
  const blocked = (ctor: unknown) =>
    new Proxy(ctor as (...args: unknown[]) => unknown, { apply: refuse, construct: refuse });
  const protos = [
    Function.prototype,
    Object.getPrototypeOf(async () => {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ] as { constructor: unknown }[];
  for (const proto of protos)
    try {
      Object.defineProperty(proto, "constructor", {
        value: blocked(proto.constructor),
        configurable: false,
        writable: false,
      });
    } catch {
      /* already locked */
    }
  for (const [name, value] of [
    ["eval", refuse],
    ["Function", blocked(Function)],
  ] as const)
    try {
      Object.defineProperty(scope, name, { value, configurable: false, writable: false });
    } catch {
      /* already locked */
    }
  // Timers with a string are eval too.
  for (const name of ["setTimeout", "setInterval"]) {
    const original = scope[name] as (...args: unknown[]) => unknown;
    try {
      Object.defineProperty(scope, name, {
        value: (handler: unknown, ...rest: unknown[]) => {
          if (typeof handler !== "function") refuse();
          return original.call(scope, handler, ...rest);
        },
        configurable: false,
        writable: false,
      });
    } catch {
      /* already locked */
    }
  }
}
