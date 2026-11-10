// browser_batch (D316), DOM-free: several browser tool calls in one round trip, run in order,
// stopping at the first that fails or is refused. The results come back as one text with each
// step's result in turn, and the screenshots in the order they were taken (the text says which
// step each image is).

export interface BatchStep {
  name: string;
  input: Record<string, unknown>;
}

/** What one step returned (a ToolOutcome's shape). */
export interface StepOutcome {
  result: string;
  isError?: boolean;
  denied?: boolean;
  summary?: string;
  images?: string[];
}

export const MAX_BATCH_STEPS = 25;

/** Reads browser_batch's `actions` (an array, or one as JSON text); `allowed` are the tool names. */
export function parseBatch(value: unknown, allowed: readonly string[]): BatchStep[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      throw new Error("actions: a list of {name, input}.");
    }
  }
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("actions: a list of {name, input}, at least one.");
  if (list.length > MAX_BATCH_STEPS)
    throw new Error(`actions: at most ${MAX_BATCH_STEPS} at a time.`);
  return list.map((raw, i) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    if (name === "browser_batch") throw new Error(`actions[${i}]: browser_batch can't be nested.`);
    if (!allowed.includes(name))
      throw new Error(`actions[${i}]: unknown tool "${name}". Use one of: ${allowed.join(", ")}.`);
    let input = item.input ?? item.arguments ?? {};
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        throw new Error(`actions[${i}].input: an object.`);
      }
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error(`actions[${i}].input: an object.`);
    return { name, input: input as Record<string, unknown> };
  });
}

export interface BatchResult {
  result: string;
  isError: boolean;
  denied: boolean;
  images: string[];
  summary: string;
  /** Steps that ran (the failing one included). */
  ran: number;
}

/**
 * Runs the steps in order. A step that throws, fails or is refused ends the batch there; one
 * stopped by the user (`cancelled`) ends it before the next.
 */
export async function runBatch(
  steps: readonly BatchStep[],
  exec: (step: BatchStep, index: number) => Promise<StepOutcome>,
  label: (step: BatchStep) => string = (s) => s.name,
  cancelled: () => boolean = () => false,
): Promise<BatchResult> {
  const parts: string[] = [];
  const images: string[] = [];
  let ran = 0;
  let failed: { denied: boolean } | null = null;
  for (const [i, step] of steps.entries()) {
    if (cancelled()) {
      parts.push(`Stopped by the user before step ${i + 1}.`);
      failed = { denied: false };
      break;
    }
    ran++;
    let outcome: StepOutcome;
    try {
      outcome = await exec(step, i);
    } catch (err) {
      outcome = { result: err instanceof Error ? err.message : String(err), isError: true };
    }
    const shots = outcome.images ?? [];
    const imageNote = shots.length
      ? ` (image ${images.length + 1}${shots.length > 1 ? `–${images.length + shots.length}` : ""} attached)`
      : "";
    images.push(...shots);
    const bad = outcome.isError || outcome.denied;
    parts.push(
      `[${i + 1}] ${label(step)}${bad ? (outcome.denied ? " — refused" : " — error") : ""}${imageNote}:\n${outcome.result}`,
    );
    if (bad) {
      failed = { denied: !!outcome.denied };
      if (i + 1 < steps.length)
        parts.push(
          `Stopped at step ${i + 1} of ${steps.length}; step${i + 2 < steps.length ? `s ${i + 2}–${steps.length}` : ` ${i + 2}`} didn't run.`,
        );
      break;
    }
  }
  return {
    result: parts.join("\n\n"),
    isError: failed !== null && !failed.denied,
    denied: failed?.denied ?? false,
    images,
    summary: failed
      ? `${ran} of ${steps.length}, stopped`
      : `${steps.length} step${steps.length === 1 ? "" : "s"}`,
    ran,
  };
}
