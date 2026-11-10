// The exception widget (D204), VS Code's: when the program stops on an exception, a zone under
// the line shows what was thrown — its type, message and stack — from the debugger's
// `exceptionInfo` (DAP) or the paused event's exception object (Node's inspector). And the
// adapter's own exception filters (DAP `exceptionBreakpointFilters`: debugpy's "Raised" /
// "Uncaught" / "User uncaught", GDB's "throw" / "catch"…), shown as checkboxes in Breakpoints,
// with a condition where the adapter supports one. DOM-free and tested.

/** What was thrown (DAP's ExceptionInfoResponse, flattened). */
export interface ExceptionDetails {
  /** The exception's id: its type or class ("TypeError", "ValueError"). */
  exceptionId: string;
  description?: string;
  /** "always" (every exception), "unhandled", "userUnhandled", "never". */
  breakMode: string;
  typeName?: string;
  message?: string;
  stackTrace?: string;
  /** Exceptions it wraps, innermost last. */
  inner?: ExceptionDetails[];
}

/** What the widget shows. */
export interface ExceptionWidgetModel {
  /** "Exception has occurred: TypeError". */
  title: string;
  message: string;
  /** Stack lines, trimmed, at most `STACK_LINES`. */
  stack: string[];
  /** Lines left out of `stack`. */
  more: number;
}

const STACK_LINES = 12;

/** DAP's `exceptionInfo` answer → details (null when it says nothing useful). */
export function fromDapExceptionInfo(body: Record<string, unknown>): ExceptionDetails | null {
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);
  const details = (body.details ?? {}) as Record<string, unknown>;
  const id = str(body.exceptionId) ?? str(details.typeName) ?? str(details.fullTypeName);
  if (!id && !str(body.description)) return null;
  const inner = Array.isArray(details.innerException)
    ? details.innerException.flatMap((d) => {
        const x = fromDapExceptionInfo({ details: d, breakMode: body.breakMode });
        return x ? [x] : [];
      })
    : [];
  const description = str(body.description);
  const typeName = str(details.typeName) ?? str(details.fullTypeName);
  const message = str(details.message);
  const stackTrace = str(details.stackTrace);
  return {
    exceptionId: id ?? "Exception",
    ...(description ? { description } : {}),
    breakMode: str(body.breakMode) ?? "always",
    ...(typeName ? { typeName } : {}),
    ...(message ? { message } : {}),
    ...(stackTrace ? { stackTrace } : {}),
    ...(inner.length ? { inner } : {}),
  };
}

/**
 * Node's inspector: the paused event's exception object (`className`, `description` = V8's
 * "TypeError: msg\n    at …" text) and whether it's uncaught.
 */
export function fromCdpException(
  o: { className?: string; description?: string; type?: string; value?: unknown },
  uncaught: boolean,
): ExceptionDetails {
  const description =
    o.description ?? (o.value !== undefined ? JSON.stringify(o.value) : String(o.type ?? ""));
  const lines = description.split("\n");
  const firstStack = lines.findIndex((l, i) => i > 0 && /^\s+at /.test(l));
  const head = (firstStack > 0 ? lines.slice(0, firstStack) : lines).join("\n");
  const stack = firstStack > 0 ? lines.slice(firstStack).join("\n") : undefined;
  // A thrown primitive ("throw 'x'") has no class.
  const id = o.className ?? (o.type === "object" ? "Object" : (o.type ?? "Exception"));
  return {
    exceptionId: id,
    description: head,
    breakMode: uncaught ? "unhandled" : "always",
    ...(stack ? { stackTrace: stack } : {}),
  };
}

/** The widget's text for `d`. */
export function exceptionWidget(d: ExceptionDetails): ExceptionWidgetModel {
  const uncaught = d.breakMode === "unhandled" || d.breakMode === "userUnhandled";
  const title = `Exception has occurred: ${d.exceptionId}${uncaught ? " (uncaught)" : ""}`;
  // V8 and Python both start the description with the type: "TypeError: x is not a function".
  let message = d.message ?? d.description ?? "";
  const prefix = `${d.exceptionId}: `;
  if (message.startsWith(prefix)) message = message.slice(prefix.length);
  if (message === d.exceptionId) message = "";
  const all = [
    ...(d.stackTrace ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    ...(d.inner ?? []).flatMap((x) => [
      `Caused by ${x.exceptionId}${x.message ? `: ${x.message}` : ""}`,
    ]),
  ];
  return {
    title,
    message,
    stack: all.slice(0, STACK_LINES),
    more: Math.max(0, all.length - STACK_LINES),
  };
}

/** An adapter's exception filter (DAP `ExceptionBreakpointsFilter`). */
export interface ExceptionFilter {
  filter: string;
  label: string;
  description?: string;
  default: boolean;
  supportsCondition: boolean;
  conditionDescription?: string;
}

export function parseExceptionFilters(value: unknown): ExceptionFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): ExceptionFilter[] => {
    const f = raw as Record<string, unknown> | null;
    if (!f || typeof f.filter !== "string" || !f.filter) return [];
    return [
      {
        filter: f.filter,
        label: typeof f.label === "string" && f.label ? f.label : f.filter,
        ...(typeof f.description === "string" ? { description: f.description } : {}),
        default: f.default === true,
        supportsCondition: f.supportsCondition === true,
        ...(typeof f.conditionDescription === "string"
          ? { conditionDescription: f.conditionDescription }
          : {}),
      },
    ];
  });
}

/** The user's choice for a filter (kept per filter id across sessions). */
export interface FilterChoice {
  enabled: boolean;
  condition?: string;
}

/**
 * What `setExceptionBreakpoints` gets: the filters on (the user's choice, else the adapter's
 * default), and — when the adapter takes them — their conditions as `filterOptions`.
 */
export function exceptionBreakpointsArgs(
  filters: readonly ExceptionFilter[],
  choices: Readonly<Record<string, FilterChoice>>,
  supportsFilterOptions: boolean,
): { filters: string[]; filterOptions?: { filterId: string; condition?: string }[] } {
  const on = filters.filter((f) => choices[f.filter]?.enabled ?? f.default);
  if (!supportsFilterOptions) return { filters: on.map((f) => f.filter) };
  return {
    filters: [],
    filterOptions: on.map((f) => {
      const condition = f.supportsCondition ? choices[f.filter]?.condition?.trim() : undefined;
      return { filterId: f.filter, ...(condition ? { condition } : {}) };
    }),
  };
}
