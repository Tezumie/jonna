// MCP elicitation (spec 2025-06-18, `elicitation/create`): a server asks the user for a few
// values. Its `requestedSchema` is a flat object of primitive fields (string with an optional
// format, number / integer with bounds, boolean, and string enums, titled with `enumNames` or,
// in later revisions, `oneOf` const/title pairs). This turns the schema into fields a form or a
// quick input can ask for, checks what the user typed and builds the `content` to send back.
// DOM-free; tested.

export type ElicitAction = "accept" | "decline" | "cancel";

export interface ElicitResult {
  action: ElicitAction;
  content?: Record<string, string | number | boolean>;
}

export interface ElicitRequest {
  message: string;
  requestedSchema?: unknown;
  /** Later revisions: "form" (the default) or "url" (which we don't support). */
  mode?: string;
}

export interface ElicitField {
  name: string;
  /** What the user sees: the field's title, else its name. */
  label: string;
  description?: string;
  kind: "string" | "number" | "integer" | "boolean" | "enum";
  required: boolean;
  /** enum: the values and their labels. */
  options?: { value: string; label: string }[];
  format?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The fields of a requested schema; throws on a schema we can't ask for (nested, arrays). */
export function elicitFields(schema: unknown): ElicitField[] {
  const s = (schema ?? {}) as { properties?: unknown; required?: unknown };
  const props =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(s.required)
    ? s.required.filter((x): x is string => typeof x === "string")
    : [];
  const out: ElicitField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const base = {
      name,
      label: str(p.title) || name,
      ...(str(p.description) && { description: str(p.description) }),
      required: required.includes(name),
    };
    const oneOf = Array.isArray(p.oneOf) ? p.oneOf : null;
    if (Array.isArray(p.enum) || oneOf) {
      const names = Array.isArray(p.enumNames) ? p.enumNames : [];
      const options = Array.isArray(p.enum)
        ? p.enum
            .map((v, i) => ({ value: String(v), label: str(names[i]) || String(v) }))
            .filter((o) => o.value !== "")
        : (oneOf ?? []).flatMap((o) => {
            const x = (o ?? {}) as { const?: unknown; title?: unknown };
            return typeof x.const === "string"
              ? [{ value: x.const, label: str(x.title) || x.const }]
              : [];
          });
      if (!options.length) throw new Error(`The field ${name} has no choices.`);
      const d = str(p.default);
      out.push({ ...base, kind: "enum", options, ...(d !== undefined && { default: d }) });
      continue;
    }
    const type = p.type;
    if (type === "boolean") {
      out.push({
        ...base,
        kind: "boolean",
        ...(typeof p.default === "boolean" && { default: p.default }),
      });
    } else if (type === "number" || type === "integer") {
      const min = num(p.minimum);
      const max = num(p.maximum);
      const d = num(p.default);
      out.push({
        ...base,
        kind: type,
        ...(min !== undefined && { min }),
        ...(max !== undefined && { max }),
        ...(d !== undefined && { default: d }),
      });
    } else if (type === "string") {
      const minLength = num(p.minLength);
      const maxLength = num(p.maxLength);
      const d = str(p.default);
      out.push({
        ...base,
        kind: "string",
        ...(str(p.format) && { format: str(p.format) }),
        ...(minLength !== undefined && { minLength }),
        ...(maxLength !== undefined && { maxLength }),
        ...(d !== undefined && { default: d }),
      });
    } else throw new Error(`The field ${name} isn't a simple value (${String(type)}).`);
  }
  return out;
}

/**
 * What the user typed for `field`, checked: the value to send, or an error to show. An empty
 * answer to an optional field is `undefined` (left out).
 */
export function parseFieldValue(
  field: ElicitField,
  text: string,
): { value?: string | number | boolean; error?: string } {
  const t = text.trim();
  if (!t) return field.required ? { error: `${field.label} is required.` } : {};
  switch (field.kind) {
    case "boolean": {
      if (/^(y|yes|true|on|1)$/i.test(t)) return { value: true };
      if (/^(n|no|false|off|0)$/i.test(t)) return { value: false };
      return { error: "Answer yes or no." };
    }
    case "enum": {
      const o = field.options?.find(
        (x) => x.value === t || x.label.toLowerCase() === t.toLowerCase(),
      );
      return o
        ? { value: o.value }
        : { error: `Pick one of: ${(field.options ?? []).map((x) => x.label).join(", ")}.` };
    }
    case "number":
    case "integer": {
      const n = Number(t);
      if (!Number.isFinite(n)) return { error: "Type a number." };
      if (field.kind === "integer" && !Number.isInteger(n))
        return { error: "Type a whole number." };
      if (field.min !== undefined && n < field.min) return { error: `At least ${field.min}.` };
      if (field.max !== undefined && n > field.max) return { error: `At most ${field.max}.` };
      return { value: n };
    }
    default: {
      if (field.minLength !== undefined && t.length < field.minLength)
        return { error: `At least ${field.minLength} characters.` };
      if (field.maxLength !== undefined && t.length > field.maxLength)
        return { error: `At most ${field.maxLength} characters.` };
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t))
        return { error: "Type an email address." };
      if (field.format === "uri" && !/^[a-z][\w+.-]*:\S+$/i.test(t))
        return { error: "Type an address (https://…)." };
      if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(t))
        return { error: "Type a date as YYYY-MM-DD." };
      if (field.format === "date-time" && Number.isNaN(Date.parse(t)))
        return { error: "Type a date and time (YYYY-MM-DDTHH:MM)." };
      return { value: t };
    }
  }
}

/** The answer for accepted values (only the fields the schema has, required ones present). */
export function acceptContent(
  fields: readonly ElicitField[],
  values: Record<string, string | number | boolean | undefined>,
): ElicitResult {
  const content: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined) {
      if (f.required) throw new Error(`${f.label} is required.`);
      continue;
    }
    content[f.name] = v;
  }
  return { action: "accept", content };
}

/** A field's prompt line: "Name (required): what it's for". */
export function fieldPrompt(field: ElicitField): string {
  const hints: string[] = [];
  if (field.kind === "number" || field.kind === "integer") {
    if (field.min !== undefined && field.max !== undefined)
      hints.push(`${field.min} to ${field.max}`);
    else if (field.min !== undefined) hints.push(`at least ${field.min}`);
    else if (field.max !== undefined) hints.push(`at most ${field.max}`);
  }
  if (field.format) hints.push(field.format);
  if (!field.required) hints.push("optional");
  return `${field.label}${hints.length ? ` (${hints.join(", ")})` : ""}${field.description ? `: ${field.description}` : ""}`;
}
