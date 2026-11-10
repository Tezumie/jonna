// The `vscode` shim's `tests` (D257) on the IDE's test controllers (`ide.tests`): VS Code's test
// items over the IDE's (a Uri for its path, a 0-based Range for its 1-based lines, TestTags),
// run profiles and requests in both directions, runs with VS Code's TestMessages, and coverage
// (a FileCoverage's statements, from its details or the profile's loadDetailedCoverage).
// DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import { markdownOf, pathOf } from "./convert";
import {
  CancellationTokenSource,
  EventEmitter,
  type MarkdownString,
  Position,
  Range,
  Uri,
} from "./types";
import {
  type FileCoverage,
  StatementCoverage,
  type TestMessage,
  TestRunRequest,
  TestTag,
} from "./workbenchTypes";

type IdeController = ReturnType<WorkerApi["tests"]["createTestController"]>;
type IdeItem = ReturnType<IdeController["createTestItem"]>;
type IdeCollection = IdeController["items"];
type IdeProfile = ReturnType<IdeController["createRunProfile"]>;
type IdeRun = ReturnType<IdeController["createTestRun"]>;

const PROFILE_KINDS = { 1: "run", 2: "debug", 3: "coverage" } as const;

export function createTesting(ide: WorkerApi, unsupported: (name: string) => void) {
  const shims = new WeakMap<IdeItem, ShimTestItem>();
  const wrap = (item: IdeItem): ShimTestItem => {
    let shim = shims.get(item);
    if (!shim) {
      shim = new ShimTestItem(item, wrap);
      shims.set(item, shim);
    }
    return shim;
  };

  const createTestController = (id: string, label: string) => {
    const c = ide.tests.createTestController(id, label);
    const profiles = new Map<IdeProfile, ShimProfile>();
    let resolveHandler: ((item: ShimTestItem | undefined) => unknown) | undefined;

    const toShimRequest = (r: {
      include?: readonly IdeItem[];
      exclude?: readonly IdeItem[];
      profile?: IdeProfile;
    }) =>
      new TestRunRequest(
        r.include?.map(wrap),
        r.exclude?.map(wrap),
        r.profile ? profiles.get(r.profile) : undefined,
      );

    const createRunProfile = (
      profileLabel: string,
      kind: 1 | 2 | 3,
      runHandler: (request: TestRunRequest, token: unknown) => unknown,
      isDefault = false,
      tag?: TestTag,
      supportsContinuousRun = false,
    ): ShimProfile => {
      let shim: ShimProfile | undefined;
      const inner = c.createRunProfile(
        profileLabel,
        PROFILE_KINDS[kind] ?? "run",
        async (request, token) => {
          await shim?.runHandler(toShimRequest(request), vsToken(token));
        },
        isDefault,
      );
      if (tag) inner.tag = { id: tag.id };
      shim = {
        get label() {
          return inner.label;
        },
        set label(v: string) {
          inner.label = v;
        },
        kind,
        get isDefault() {
          return inner.isDefault;
        },
        set isDefault(v: boolean) {
          inner.isDefault = v;
        },
        get tag() {
          return inner.tag ? new TestTag(inner.tag.id) : undefined;
        },
        set tag(t: TestTag | undefined) {
          inner.tag = t ? { id: t.id } : undefined;
        },
        supportsContinuousRun,
        runHandler,
        configureHandler: undefined,
        loadDetailedCoverage: undefined,
        loadDetailedCoverageForTest: undefined,
        onDidChangeDefault: new EventEmitter<boolean>().event,
        dispose: () => {
          profiles.delete(inner);
          inner.dispose();
        },
        inner,
      };
      profiles.set(inner, shim);
      return shim;
    };

    const createTestRun = (request: TestRunRequest, name?: string, persist = true) => {
      const profile = request.profile as ShimProfile | undefined;
      const run = c.createTestRun(
        {
          ...(request.include && {
            include: request.include.map((i) => (i as ShimTestItem).inner),
          }),
          ...(request.exclude && {
            exclude: request.exclude.map((i) => (i as ShimTestItem).inner),
          }),
          ...(profile && { profile: profile.inner }),
        },
        name,
        persist,
      );
      return shimRun(run, profile, name, persist, unsupported);
    };

    return {
      id,
      get label() {
        return c.label;
      },
      set label(v: string) {
        c.label = v;
      },
      items: collection(c.items, wrap),
      createTestItem: (itemId: string, itemLabel: string, uri?: Uri) =>
        wrap(c.createTestItem(itemId, itemLabel, uri ? pathOf(uri) : undefined)),
      createRunProfile,
      createTestRun,
      get resolveHandler() {
        return resolveHandler;
      },
      set resolveHandler(h: ((item: ShimTestItem | undefined) => unknown) | undefined) {
        resolveHandler = h;
        c.resolveHandler = h
          ? async (item) => void (await h(item ? wrap(item) : undefined))
          : undefined;
      },
      refreshHandler: undefined as unknown,
      invalidateTestResults: () => {},
      dispose: () => c.dispose(),
    };
  };

  return { createTestController };
}

interface ShimProfile {
  label: string;
  readonly kind: number;
  isDefault: boolean;
  tag: TestTag | undefined;
  supportsContinuousRun: boolean;
  runHandler: (request: TestRunRequest, token: unknown) => unknown;
  configureHandler: unknown;
  loadDetailedCoverage:
    | ((run: unknown, coverage: FileCoverage, token: unknown) => unknown)
    | undefined;
  loadDetailedCoverageForTest: unknown;
  onDidChangeDefault: unknown;
  dispose(): void;
  readonly inner: IdeProfile;
}

/** The IDE's cancellation token as VS Code's (an Event that takes thisArgs and disposables). */
function vsToken(token: {
  isCancellationRequested: boolean;
  onCancellationRequested(l: () => void): { dispose(): void };
}) {
  const source = new CancellationTokenSource();
  if (token.isCancellationRequested) source.cancel();
  else token.onCancellationRequested(() => source.cancel());
  return source.token;
}

function collection(inner: IdeCollection, wrap: (i: IdeItem) => ShimTestItem) {
  const self = {
    get size() {
      return inner.size;
    },
    add: (item: ShimTestItem) => inner.add(item.inner),
    delete: (id: string) => inner.delete(id),
    get: (id: string) => {
      const item = inner.get(id);
      return item ? wrap(item) : undefined;
    },
    replace: (items: readonly ShimTestItem[]) => inner.replace(items.map((i) => i.inner)),
    forEach: (callback: (item: ShimTestItem, collection: unknown) => unknown) =>
      inner.forEach((item) => {
        callback(wrap(item), self);
      }),
    *[Symbol.iterator](): IterableIterator<[string, ShimTestItem]> {
      for (const [id, item] of inner) yield [id, wrap(item)];
    },
  };
  return self;
}

export class ShimTestItem {
  constructor(
    readonly inner: IdeItem,
    private readonly wrap: (i: IdeItem) => ShimTestItem,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get label(): string {
    return this.inner.label;
  }
  set label(v: string) {
    this.inner.label = v;
  }
  get description(): string | undefined {
    return this.inner.description;
  }
  set description(v: string | undefined) {
    this.inner.description = v;
  }
  get uri(): Uri | undefined {
    return this.inner.uri ? Uri.file(this.inner.uri) : undefined;
  }
  get range(): Range | undefined {
    const r = this.inner.range;
    if (!r) return undefined;
    // The one it set, characters included, while the lines still match (D261: read back as
    // whole lines); the IDE keeps lines only.
    const own = this.ownRange;
    if (
      own &&
      own.start.line + 1 === r.startLine &&
      own.end.line + 1 === (r.endLine ?? r.startLine)
    )
      return own;
    return new Range(r.startLine - 1, 0, (r.endLine ?? r.startLine) - 1, 0);
  }
  set range(r: Range | undefined) {
    this.ownRange = r;
    this.inner.range = r ? { startLine: r.start.line + 1, endLine: r.end.line + 1 } : undefined;
  }
  private ownRange: Range | undefined;
  get canResolveChildren(): boolean {
    return this.inner.canResolveChildren;
  }
  set canResolveChildren(v: boolean) {
    this.inner.canResolveChildren = v;
  }
  get busy(): boolean {
    return this.inner.busy;
  }
  set busy(v: boolean) {
    this.inner.busy = v;
  }
  get sortText(): string | undefined {
    return this.inner.sortText;
  }
  set sortText(v: string | undefined) {
    this.inner.sortText = v;
  }
  get error(): string | MarkdownString | undefined {
    return this.inner.error;
  }
  set error(v: string | MarkdownString | undefined) {
    this.inner.error = v === undefined ? undefined : markdownOf(v);
  }
  get tags(): readonly TestTag[] {
    return this.inner.tags.map((t) => new TestTag(t.id));
  }
  set tags(list: readonly TestTag[]) {
    this.inner.tags = list.map((t) => ({ id: t.id }));
  }
  get children() {
    return collection(this.inner.children, this.wrap);
  }
  get parent(): ShimTestItem | undefined {
    return this.inner.parent ? this.wrap(this.inner.parent) : undefined;
  }
}

type VsMessage =
  | TestMessage
  | string
  | { message?: unknown; expectedOutput?: string; actualOutput?: string };

function messages(m: VsMessage | readonly VsMessage[]) {
  const list = Array.isArray(m) ? m : [m];
  return list.map((x: VsMessage) =>
    typeof x === "string"
      ? x
      : {
          message: markdownOf((x as TestMessage).message),
          ...((x as TestMessage).expectedOutput !== undefined && {
            expectedOutput: (x as TestMessage).expectedOutput,
          }),
          ...((x as TestMessage).actualOutput !== undefined && {
            actualOutput: (x as TestMessage).actualOutput,
          }),
          // Where it failed (D264): the file and 1-based line.
          ...((x as TestMessage).location && {
            location: {
              path: pathOf((x as TestMessage).location?.uri as Uri),
              line: ((x as TestMessage).location?.range.start.line ?? 0) + 1,
            },
          }),
        },
  );
}

/** Lines (1-based) and how often they ran, from VS Code's statement coverage. */
export function coverageLines(details: readonly unknown[]): {
  lines: [number, number][];
  branches: [number, number, number][];
} {
  const lines = new Map<number, number>();
  const branches: [number, number, number][] = [];
  const count = (e: number | boolean) => (typeof e === "number" ? e : e ? 1 : 0);
  for (const d of details) {
    if (!(d instanceof StatementCoverage)) continue;
    const loc = d.location;
    const start = loc instanceof Position ? loc.line : loc.start.line;
    const end = loc instanceof Position ? loc.line : loc.end.line;
    for (let line = start; line <= end; line++)
      lines.set(line + 1, Math.max(lines.get(line + 1) ?? 0, count(d.executed)));
    if (d.branches.length)
      branches.push([
        start + 1,
        d.branches.filter((b) => count(b.executed) > 0).length,
        d.branches.length,
      ]);
  }
  return { lines: [...lines].sort((a, b) => a[0] - b[0]), branches };
}

function shimRun(
  run: IdeRun,
  profile: ShimProfile | undefined,
  name: string | undefined,
  persist: boolean,
  unsupported: (name: string) => void,
) {
  const pending: Promise<void>[] = [];
  const onDidDispose = new EventEmitter<void>();
  const item = (t: unknown) => (t as ShimTestItem).inner;
  const self = {
    name,
    token: vsToken(run.token),
    isPersisted: persist,
    enqueued: (t: unknown) => run.enqueued(item(t)),
    started: (t: unknown) => run.started(item(t)),
    skipped: (t: unknown) => run.skipped(item(t)),
    passed: (t: unknown, duration?: number) => run.passed(item(t), duration),
    failed: (t: unknown, message: VsMessage | readonly VsMessage[], duration?: number) =>
      run.failed(item(t), messages(message), duration),
    errored: (t: unknown, message: VsMessage | readonly VsMessage[], duration?: number) =>
      run.errored(item(t), messages(message), duration),
    appendOutput: (output: string, _location?: unknown, test?: unknown) =>
      run.appendOutput(output, undefined, test ? item(test) : undefined),
    addCoverage: (coverage: FileCoverage) => {
      pending.push(
        (async () => {
          const details =
            (coverage as { details?: readonly unknown[] }).details ??
            ((await profile?.loadDetailedCoverage?.(self, coverage, self.token)) as
              | readonly unknown[]
              | undefined);
          if (!details) {
            unsupported("FileCoverage without details");
            return;
          }
          const { lines, branches } = coverageLines(details);
          run.addCoverage({
            path: pathOf(coverage.uri),
            lines,
            ...(branches.length && { branches }),
          });
        })().catch(() => {}),
      );
    },
    end: () => {
      void Promise.all(pending).then(() => {
        run.end();
        onDidDispose.fire();
      });
    },
    onDidDispose: onDidDispose.event,
  };
  return self;
}
