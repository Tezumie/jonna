// In-house schema builder: one definition gives a TS type, a JSON Schema (for agents/MCP) and a
// runtime validator (for the dispatcher). Deliberately small; covers what command inputs need.
//
//   const input = s.object({ path: s.string().describe("Absolute path"), line: s.integer().optional() });
//   type Input = Infer<typeof input>;   // { path: string; line?: number }

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
};

export interface ValidationIssue {
  /** JSON-pointer-like path, e.g. "/edits/0/text" ("" = root). */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** A schema for values of type `T`. `Opt` marks optional object properties at the type level. */
export class Schema<T, Opt extends boolean = false> {
  /** Type-only marker so `Infer` can read `T`; never set at runtime. */
  declare readonly __type: T;
  declare readonly __optional: Opt;

  constructor(
    private readonly schema: JsonSchema,
    private readonly check: (value: unknown, path: string, issues: ValidationIssue[]) => void,
    readonly isOptional: boolean = false,
  ) {}

  /** The JSON Schema (draft 2020-12 subset) for this value. */
  get json(): JsonSchema {
    return this.schema;
  }

  optional(): Schema<T | undefined, true> {
    return new Schema<T | undefined, true>(this.schema, this.check, true);
  }

  /** Adds a description (shown to models in tool definitions). */
  describe(description: string): Schema<T, Opt> {
    return new Schema<T, Opt>({ ...this.schema, description }, this.check, this.isOptional);
  }

  validate(value: unknown): ValidationResult<T> {
    const issues: ValidationIssue[] = [];
    if (value === undefined && this.isOptional) return { ok: true, value: value as T };
    this.check(value, "", issues);
    return issues.length === 0 ? { ok: true, value: value as T } : { ok: false, issues };
  }

  /** @internal used by containers to validate children. */
  checkAt(value: unknown, path: string, issues: ValidationIssue[]): void {
    this.check(value, path, issues);
  }
}

export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;

/** Any schema (Schema is covariant in T, so every Schema<T> is assignable). */
export type AnySchema = Schema<unknown, boolean>;
type Shape = Record<string, AnySchema>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Schema<unknown, true> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferObject<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

const describeValue = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
}

interface NumberOptions {
  min?: number;
  max?: number;
}

function numberSchema(integer: boolean, opts: NumberOptions): Schema<number> {
  return new Schema<number>(
    {
      type: integer ? "integer" : "number",
      ...(opts.min !== undefined && { minimum: opts.min }),
      ...(opts.max !== undefined && { maximum: opts.max }),
    },
    (v, path, issues) => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ path, message: `expected number, got ${describeValue(v)}` });
      } else if (integer && !Number.isInteger(v)) {
        issues.push({ path, message: "expected integer" });
      } else if (opts.min !== undefined && v < opts.min) {
        issues.push({ path, message: `must be >= ${opts.min}` });
      } else if (opts.max !== undefined && v > opts.max) {
        issues.push({ path, message: `must be <= ${opts.max}` });
      }
    },
  );
}

export const s = {
  string(opts: StringOptions = {}): Schema<string> {
    return new Schema<string>(
      {
        type: "string",
        ...(opts.minLength !== undefined && { minLength: opts.minLength }),
        ...(opts.maxLength !== undefined && { maxLength: opts.maxLength }),
        ...(opts.pattern && { pattern: opts.pattern.source }),
      },
      (v, path, issues) => {
        if (typeof v !== "string") {
          issues.push({ path, message: `expected string, got ${describeValue(v)}` });
        } else if (opts.minLength !== undefined && v.length < opts.minLength) {
          issues.push({ path, message: `must have at least ${opts.minLength} characters` });
        } else if (opts.maxLength !== undefined && v.length > opts.maxLength) {
          issues.push({ path, message: `must have at most ${opts.maxLength} characters` });
        } else if (opts.pattern && !opts.pattern.test(v)) {
          issues.push({ path, message: `must match ${opts.pattern}` });
        }
      },
    );
  },

  number(opts: NumberOptions = {}): Schema<number> {
    return numberSchema(false, opts);
  },

  integer(opts: NumberOptions = {}): Schema<number> {
    return numberSchema(true, opts);
  },

  boolean(): Schema<boolean> {
    return new Schema<boolean>({ type: "boolean" }, (v, path, issues) => {
      if (typeof v !== "boolean") {
        issues.push({ path, message: `expected boolean, got ${describeValue(v)}` });
      }
    });
  },

  enum<const V extends readonly (string | number)[]>(values: V): Schema<V[number]> {
    return new Schema<V[number]>({ enum: values }, (v, path, issues) => {
      if (!values.includes(v as V[number])) {
        issues.push({ path, message: `expected one of ${JSON.stringify(values)}` });
      }
    });
  },

  array<S extends AnySchema>(item: S, opts: { maxItems?: number } = {}): Schema<Infer<S>[]> {
    return new Schema<Infer<S>[]>({ type: "array", items: item.json }, (v, path, issues) => {
      if (!Array.isArray(v)) {
        issues.push({ path, message: `expected array, got ${describeValue(v)}` });
        return;
      }
      if (opts.maxItems !== undefined && v.length > opts.maxItems) {
        issues.push({ path, message: `must have at most ${opts.maxItems} items` });
      }
      v.forEach((el, i) => {
        item.checkAt(el, `${path}/${i}`, issues);
      });
    });
  },

  /** Object with known keys. Unknown keys are rejected (catches typos in agent calls). */
  object<S extends Shape>(shape: S): Schema<InferObject<S>> {
    const required = Object.entries(shape)
      .filter(([, schema]) => !schema.isOptional)
      .map(([key]) => key);
    const properties = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.json]));
    return new Schema<InferObject<S>>(
      { type: "object", properties, required, additionalProperties: false },
      (v, path, issues) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          issues.push({ path, message: `expected object, got ${describeValue(v)}` });
          return;
        }
        const record = v as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          // Own keys only: `in` would let "constructor" or "__proto__" through.
          if (!Object.hasOwn(shape, key))
            issues.push({ path: `${path}/${key}`, message: "unknown property" });
        }
        for (const [key, schema] of Object.entries(shape)) {
          const value = record[key];
          if (value === undefined) {
            if (!schema.isOptional) issues.push({ path: `${path}/${key}`, message: "required" });
          } else {
            schema.checkAt(value, `${path}/${key}`, issues);
          }
        }
      },
    );
  },

  /** One of several shapes (JSON Schema `anyOf`); the first that validates wins. */
  union<const S extends readonly AnySchema[]>(...options: S): Schema<Infer<S[number]>> {
    return new Schema<Infer<S[number]>>(
      { anyOf: options.map((o) => o.json) },
      (v, path, issues) => {
        const attempts = options.map((o) => {
          const found: ValidationIssue[] = [];
          o.checkAt(v, path, found);
          return found;
        });
        if (attempts.some((a) => a.length === 0)) return;
        const best = attempts.reduce((a, b) => (b.length < a.length ? b : a));
        issues.push({ path, message: `matches none of ${options.length} allowed shapes` }, ...best);
      },
    );
  },

  /** Any JSON value (use sparingly; prefer precise schemas). */
  unknown(): Schema<unknown> {
    return new Schema<unknown>({}, () => {});
  },

  /** The empty input `{}` (commands without arguments). */
  empty(): Schema<Record<string, never>> {
    return s.object({}) as unknown as Schema<Record<string, never>>;
  },
};

/** Formats issues as one readable line, for errors shown to users and models. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path || "(input)"}: ${i.message}`).join("; ");
}
