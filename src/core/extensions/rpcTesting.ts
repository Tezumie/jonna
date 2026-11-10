// The worker side of `ide.tests` (VS Code's `tests.createTestController`, D247): test items in a tree,
// run profiles, test runs that report each test's state, its output and its failures. Its tests
// show in the Testing view next to the built-in ones; Run / Debug there call the run profile. The
// items reach the host as one snapshot per turn, a run's events as one batch per turn. The host
// calls back through "provider" calls on `tests.<controller>.run | resolve | cancel`. DOM-free,
// unit-tested.
import type { CancellationToken } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

/** 1-based lines, like the rest of the API. */
export interface TestRange {
  startLine: number;
  endLine?: number;
}

export interface TestItemCollection extends Iterable<[string, TestItem]> {
  readonly size: number;
  /** Adds (or replaces the item with the same id). */
  add(item: TestItem): void;
  delete(id: string): void;
  get(id: string): TestItem | undefined;
  replace(items: readonly TestItem[]): void;
  forEach(callback: (item: TestItem, collection: TestItemCollection) => void): void;
}

export interface TestItem {
  /** Unique among its siblings. */
  readonly id: string;
  label: string;
  description: string | undefined;
  /** Its file: a path of the open folder (relative or absolute). */
  uri: string | undefined;
  range: TestRange | undefined;
  /** Its children are found when the user opens it (the controller's resolveHandler). */
  canResolveChildren: boolean;
  /** Shows a spinner (finding its children). */
  busy: boolean;
  /** Why it couldn't be loaded. */
  error: string | undefined;
  sortText: string | undefined;
  /** Its tags (VS Code's TestTag, D255): a profile with a tag runs only items that have it. */
  tags: readonly { id: string }[];
  readonly children: TestItemCollection;
  readonly parent: TestItem | undefined;
}

/**
 * A file's coverage for `run.addCoverage` (D255, VS Code's FileCoverage with its statements
 * given at once): each line that has code and how many times it ran, optionally branches
 * (taken of total per line) and functions.
 */
export interface FileCoverage {
  /** A path of the open folder (relative or absolute). */
  path: string;
  lines: { line: number; count: number }[] | [line: number, count: number][];
  branches?: [line: number, taken: number, total: number][];
  functions?: { name: string; line?: number; hits: number }[];
}

/** VS Code's TestRunProfileKind: 1 Run, 2 Debug, 3 Coverage, or the names. */
export type TestRunProfileKind = "run" | "debug" | "coverage" | 1 | 2 | 3;

export interface TestRunRequest {
  /** What to run (default: everything). */
  readonly include?: readonly TestItem[];
  readonly exclude?: readonly TestItem[];
  readonly profile?: TestRunProfile;
}

export interface TestRunProfile {
  label: string;
  readonly kind: "run" | "debug" | "coverage";
  isDefault: boolean;
  /** Only for items with this tag (D255). */
  tag: { id: string } | undefined;
  runHandler: (request: TestRunRequest, token: CancellationToken) => void | Promise<void>;
  dispose(): void;
}

/** A failure (VS Code's TestMessage), or its text. */
export type TestMessage =
  | string
  | {
      message: string;
      expectedOutput?: string;
      actualOutput?: string;
      /** Where it failed (D264): a file of the workspace and its 1-based line. */
      location?: { path: string; line: number };
    };

export interface TestRun {
  readonly name: string | undefined;
  readonly token: CancellationToken;
  enqueued(test: TestItem): void;
  started(test: TestItem): void;
  skipped(test: TestItem): void;
  passed(test: TestItem, duration?: number): void;
  failed(test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number): void;
  errored(test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number): void;
  /** A file's coverage (a coverage profile's run, D255); the Testing view shows it when the run ends. */
  addCoverage(coverage: FileCoverage): void;
  /** Output for the Test output ("\r\n" for a new line, ANSI colors allowed). */
  appendOutput(output: string, location?: unknown, test?: TestItem): void;
  end(): void;
}

export interface TestController {
  readonly id: string;
  label: string;
  readonly items: TestItemCollection;
  createTestItem(id: string, label: string, uri?: string): TestItem;
  createRunProfile(
    label: string,
    kind: TestRunProfileKind,
    runHandler: TestRunProfile["runHandler"],
    isDefault?: boolean,
  ): TestRunProfile;
  createTestRun(request: TestRunRequest, name?: string, persist?: boolean): TestRun;
  /** Finds an item's children when it's opened (undefined: the top-level items). */
  resolveHandler: ((item: TestItem | undefined) => void | Promise<void>) | undefined;
  dispose(): void;
}

export interface TestsApi {
  createTestController(id: string, label: string): TestController;
}

const PROFILE_KINDS = { 1: "run", 2: "debug", 3: "coverage" } as const;

function profileKind(kind: TestRunProfileKind): "run" | "debug" | "coverage" {
  if (kind === "run" || kind === "debug" || kind === "coverage") return kind;
  return PROFILE_KINDS[kind as 1 | 2 | 3] ?? "run";
}

function messageOf(message: TestMessage | readonly TestMessage[]): {
  message: string;
  expected?: string;
  actual?: string;
  location?: { path: string; line: number };
} {
  const first = (Array.isArray(message) ? message[0] : message) as TestMessage | undefined;
  if (first === undefined) return { message: "" };
  if (typeof first === "string") return { message: first };
  return {
    message: String(first.message ?? ""),
    ...(typeof first.expectedOutput === "string" && { expected: first.expectedOutput }),
    ...(typeof first.actualOutput === "string" && { actual: first.actualOutput }),
    ...(first.location &&
      typeof first.location.path === "string" &&
      Number.isFinite(first.location.line) && {
        location: { path: first.location.path, line: Math.floor(first.location.line) },
      }),
  };
}

export function createTestsApi(request: Request, onCall: OnCall): TestsApi {
  let controllerSeq = 0;
  return {
    createTestController(controllerId, controllerLabel) {
      const cid = `tc${++controllerSeq}`;
      let label = String(controllerLabel ?? controllerId);
      let disposed = false;
      let itemSeq = 0;
      let runSeq = 0;
      let profileSeq = 0;
      /** Every item made, by its wid (those in the tree are sent). */
      const wids = new WeakMap<TestItem, string>();
      const byWid = new Map<string, TestItem>();
      const profiles = new Map<string, TestRunProfile>();
      /** Tokens of runs the host started, by its key. */
      const cancels = new Map<string, () => void>();
      let resolveHandler: TestController["resolveHandler"];
      let scheduled = false;

      const sync = () => {
        if (scheduled || disposed) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (disposed) return;
          void request("tests.update", {
            controller: cid,
            label,
            items: snapshot(),
            profiles: [...profiles].map(([id, p]) => ({
              id,
              label: p.label,
              kind: p.kind,
              isDefault: p.isDefault,
              ...(p.tag?.id && { tag: String(p.tag.id) }),
            })),
            resolvable: typeof resolveHandler === "function",
          }).catch(() => {});
        });
      };

      const snapshot = () => {
        const out: Record<string, unknown>[] = [];
        byWid.clear();
        const walk = (collection: TestItemCollection, parent: string | null) => {
          for (const [, item] of collection) {
            const wid = wids.get(item);
            if (!wid) continue;
            byWid.set(wid, item);
            out.push({
              wid,
              parent,
              id: item.id,
              label: item.label,
              ...(item.description !== undefined && { description: item.description }),
              ...(item.uri !== undefined && { path: item.uri }),
              ...(item.range && { line: item.range.startLine }),
              canResolveChildren: item.canResolveChildren,
              busy: item.busy,
              ...(item.error !== undefined && { error: item.error }),
              ...(item.sortText !== undefined && { sortText: item.sortText }),
              ...(Array.isArray(item.tags) &&
                item.tags.length && {
                  tags: item.tags
                    .map((t) => (typeof t === "string" ? t : t?.id))
                    .filter((t): t is string => typeof t === "string"),
                }),
            });
            walk(item.children, wid);
          }
        };
        walk(items, null);
        return out;
      };

      const collection = (owner: () => TestItem | undefined): TestItemCollection => {
        const map = new Map<string, TestItem>();
        const adopt = (item: TestItem) => {
          (item as { parent: TestItem | undefined }).parent = owner();
        };
        const c: TestItemCollection = {
          get size() {
            return map.size;
          },
          add(item) {
            if (!item || !wids.has(item)) throw new Error("Add items made by createTestItem.");
            adopt(item);
            map.set(item.id, item);
            sync();
          },
          delete(id) {
            if (map.delete(id)) sync();
          },
          get: (id) => map.get(id),
          replace(list) {
            map.clear();
            for (const item of list ?? []) {
              if (!wids.has(item)) continue;
              adopt(item);
              map.set(item.id, item);
            }
            sync();
          },
          forEach(callback) {
            for (const item of [...map.values()]) callback(item, c);
          },
          [Symbol.iterator]: () => map.entries(),
        };
        return c;
      };

      const items = collection(() => undefined);

      const createTestItem = (id: string, itemLabel: string, uri?: string): TestItem => {
        const wid = `i${++itemSeq}`;
        const fields = {
          label: String(itemLabel ?? id),
          description: undefined as string | undefined,
          uri: typeof uri === "string" ? uri : undefined,
          range: undefined as TestRange | undefined,
          canResolveChildren: false,
          busy: false,
          error: undefined as string | undefined,
          sortText: undefined as string | undefined,
          tags: [] as readonly { id: string }[],
        };
        const field = <K extends keyof typeof fields>(key: K) => ({
          get: () => fields[key],
          set: (v: (typeof fields)[K]) => {
            fields[key] = v;
            sync();
          },
          enumerable: true,
        });
        const item = { id: String(id), parent: undefined } as unknown as TestItem;
        Object.defineProperties(item, {
          label: field("label"),
          description: field("description"),
          uri: field("uri"),
          range: field("range"),
          canResolveChildren: field("canResolveChildren"),
          busy: field("busy"),
          error: field("error"),
          sortText: field("sortText"),
          tags: field("tags"),
          children: { value: collection(() => item), enumerable: true },
        });
        wids.set(item, wid);
        return item;
      };

      const createTestRun = (runRequest: TestRunRequest, name?: string): TestRun => {
        const run = `r${++runSeq}`;
        let ended = false;
        let cancelled = false;
        const cancelListeners = new Set<() => void>();
        let batch: Record<string, unknown>[] = [];
        const send = (end = false) => {
          const events = batch;
          batch = [];
          void request("tests.run", {
            controller: cid,
            run,
            ...(name !== undefined && { name: String(name) }),
            events,
            ...(end && { ended: true }),
          }).catch(() => {});
        };
        const push = (event: Record<string, unknown>) => {
          if (ended || disposed) return;
          if (!batch.length) queueMicrotask(() => batch.length && send());
          batch.push(event);
        };
        const testOf = (test: TestItem) => wids.get(test);
        const state = (kind: string, test: TestItem, extra: Record<string, unknown> = {}) => {
          const wid = testOf(test);
          if (wid) push({ kind, test: wid, ...extra });
        };
        // The host's cancel (Stop in the view) reaches the run its request started; a run the
        // extension starts by itself is cancelled by a Stop of everything.
        const hostKey = (runRequest as { hostKey?: string } | undefined)?.hostKey;
        const key = hostKey ?? `own:${run}`;
        const token: CancellationToken = {
          get isCancellationRequested() {
            return cancelled;
          },
          onCancellationRequested(listener) {
            cancelListeners.add(listener);
            return { dispose: () => cancelListeners.delete(listener) };
          },
        };
        const previous = cancels.get(key);
        cancels.set(key, () => {
          previous?.();
          if (cancelled) return;
          cancelled = true;
          for (const l of [...cancelListeners]) l();
        });
        // Started at once: the view shows it running even before its first event.
        push({ kind: "output", text: "" });
        const failure =
          (kind: "failed" | "errored") =>
          (test: TestItem, message: TestMessage | readonly TestMessage[], duration?: number) =>
            state(kind, test, {
              ...messageOf(message),
              ...(typeof duration === "number" && { durationMs: duration }),
            });
        return {
          name,
          token,
          enqueued: (test) => state("enqueued", test),
          started: (test) => state("started", test),
          skipped: (test) => state("skipped", test),
          passed: (test, duration) =>
            state("passed", test, typeof duration === "number" ? { durationMs: duration } : {}),
          failed: failure("failed"),
          errored: failure("errored"),
          addCoverage: (coverage) => {
            if (!coverage || typeof coverage.path !== "string") return;
            push({
              kind: "coverage",
              path: coverage.path,
              lines: (Array.isArray(coverage.lines) ? coverage.lines : []).map((l) =>
                Array.isArray(l) ? l : [l?.line, l?.count],
              ),
              ...(Array.isArray(coverage.branches) && { branches: coverage.branches }),
              ...(Array.isArray(coverage.functions) && { functions: coverage.functions }),
            });
          },
          appendOutput: (output, _location, test) =>
            push({
              kind: "output",
              text: String(output ?? ""),
              ...(test && testOf(test) && { test: testOf(test) }),
            }),
          end() {
            if (ended) return;
            send(true);
            ended = true;
            cancelListeners.clear();
            if (!hostKey) cancels.delete(key);
          },
        };
      };

      const off = [
        onCall(`tests.${cid}.resolve`, async (args: { item?: unknown }) => {
          const item = typeof args?.item === "string" ? byWid.get(args.item) : undefined;
          if (typeof args?.item === "string" && !item) return null;
          await resolveHandler?.(item);
          return null;
        }),
        onCall(
          `tests.${cid}.run`,
          async (args: {
            profile?: unknown;
            include?: unknown;
            exclude?: unknown;
            key?: unknown;
          }) => {
            const profile = profiles.get(String(args?.profile));
            if (!profile) throw new Error("That run profile is gone.");
            const pick = (v: unknown) =>
              Array.isArray(v)
                ? v.map((w) => byWid.get(String(w))).filter((i): i is TestItem => i !== undefined)
                : undefined;
            const include = pick(args?.include);
            const exclude = pick(args?.exclude);
            const key = typeof args?.key === "string" ? args.key : `k${runSeq}`;
            let cancelled = false;
            const listeners = new Set<() => void>();
            const token: CancellationToken = {
              get isCancellationRequested() {
                return cancelled;
              },
              onCancellationRequested(listener) {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
              },
            };
            cancels.set(key, () => {
              cancelled = true;
              for (const l of [...listeners]) l();
            });
            const runRequest = {
              ...(include && { include }),
              ...(exclude && { exclude }),
              profile,
              hostKey: key,
            } as TestRunRequest;
            try {
              await profile.runHandler(runRequest, token);
            } finally {
              cancels.delete(key);
            }
            return null;
          },
        ),
        onCall(`tests.${cid}.cancel`, (args: { key?: unknown }) => {
          const keys = typeof args?.key === "string" ? [args.key] : [...cancels.keys()];
          for (const k of keys) cancels.get(k)?.();
          return null;
        }),
      ];

      void request("tests.createController", { controller: cid, id: String(controllerId), label })
        .then(() => sync())
        .catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
        });

      return {
        id: String(controllerId),
        get label() {
          return label;
        },
        set label(value: string) {
          label = String(value ?? "");
          sync();
        },
        items,
        createTestItem,
        createRunProfile(profileLabel, kind, runHandler, isDefault = false) {
          const pid = `p${++profileSeq}`;
          let currentLabel = String(profileLabel ?? "");
          let currentDefault = isDefault === true;
          let currentTag: { id: string } | undefined;
          const profile: TestRunProfile = {
            get label() {
              return currentLabel;
            },
            set label(v: string) {
              currentLabel = String(v ?? "");
              sync();
            },
            kind: profileKind(kind),
            get isDefault() {
              return currentDefault;
            },
            set isDefault(v: boolean) {
              currentDefault = v === true;
              sync();
            },
            get tag() {
              return currentTag;
            },
            set tag(v: { id: string } | undefined) {
              currentTag = v && typeof v.id === "string" ? { id: v.id } : undefined;
              sync();
            },
            runHandler,
            dispose: () => {
              if (profiles.delete(pid)) sync();
            },
          };
          profiles.set(pid, profile);
          sync();
          return profile;
        },
        createTestRun,
        get resolveHandler() {
          return resolveHandler;
        },
        set resolveHandler(handler) {
          resolveHandler = handler;
          sync();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const o of off) o();
          for (const c of cancels.values()) c();
          cancels.clear();
          void request("tests.dispose", { controller: cid }).catch(() => {});
        },
      };
    },
  };
}
