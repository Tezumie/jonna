// An extension command's input schema (D202): `contributes.commands[].input` is a small JSON
// Schema that becomes the dispatcher's schema, so agents see the shape in the tool definition and
// the dispatcher validates input before the extension's handler runs. Supported: objects (with
// `properties`, `required`, `additionalProperties`), string, number, integer, boolean and arrays
// (`items`), with `description`, `enum`, `minimum` / `maximum`, `minLength` / `maxLength`.
// Anything else is reported, and the command takes any input as before. DOM-free and unit-tested.
import type { Caller } from "../dispatcher/types";
import { type AnySchema, type JsonSchema, Schema, s, type ValidationIssue } from "../schema/index";

const MAX_DEPTH = 8;
const MAX_PROPERTIES = 100;
const TYPES = ["object", "string", "number", "integer", "boolean", "array"] as const;

class InvalidSchema extends Error {}

/** What a tree row's context menu passes (`{ item }`, treeMenus.ts `treeMenuInput`). */
const TREE_ITEM_INPUT = {
  type: "object",
  description: "The tree row a view's context menu ran it on",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    view: { type: "string", description: "The tree view's id" },
    contextValue: { type: "string" },
  },
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * The dispatcher schema for a command's `input`. The top level must be an object (commands take
 * `{}`); an invalid schema gives `s.unknown()` and the reason in `error`.
 */
export function commandInputSchema(
  raw: unknown,
  options: { treeItem?: boolean } = {},
): { schema: AnySchema; error?: string } {
  if (raw === undefined) return { schema: s.unknown() };
  try {
    if (!isObject(raw) || raw.type !== "object")
      throw new InvalidSchema('the input must be { "type": "object", "properties": … }');
    // Explorer and editor menus run it with `{ path }`: always allowed (a menu click whose input
    // is refused would do nothing, quietly). So is `{ item }` for a command in a tree row's menu
    // (`view/item/context`).
    const props = isObject(raw.properties) ? raw.properties : {};
    const added: Record<string, unknown> = {};
    if (!("path" in props))
      added.path = { type: "string", description: "The file or folder a menu ran it on" };
    if (options.treeItem && !("item" in props)) added.item = TREE_ITEM_INPUT;
    const withMenus = { ...raw, properties: { ...props, ...added } };
    return { schema: convert(withMenus, "", 0) };
  } catch (err) {
    if (!(err instanceof InvalidSchema)) throw err;
    return { schema: s.unknown(), error: err.message };
  }
}

function convert(raw: unknown, at: string, depth: number): AnySchema {
  const where = at || "(input)";
  if (depth > MAX_DEPTH) throw new InvalidSchema(`${where}: nested more than ${MAX_DEPTH} deep`);
  if (!isObject(raw)) throw new InvalidSchema(`${where}: expected a schema object`);
  const description = typeof raw.description === "string" ? raw.description.slice(0, 2000) : "";
  const withDescription = (schema: AnySchema) =>
    description ? schema.describe(description) : schema;
  if (raw.enum !== undefined) {
    const values = raw.enum;
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 500 ||
      !values.every((v) => typeof v === "string" || typeof v === "number")
    )
      throw new InvalidSchema(`${where}: enum must be a list of strings or numbers`);
    return withDescription(s.enum(values as (string | number)[]) as AnySchema);
  }
  const type = raw.type;
  if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type))
    throw new InvalidSchema(
      `${where}: type must be one of ${TYPES.join(", ")} (got ${JSON.stringify(type)})`,
    );
  switch (type as (typeof TYPES)[number]) {
    case "string": {
      const minLength = finite(raw.minLength);
      const maxLength = finite(raw.maxLength);
      return withDescription(
        s.string({
          ...(minLength !== undefined && { minLength }),
          ...(maxLength !== undefined && { maxLength }),
        }),
      );
    }
    case "number":
    case "integer": {
      const min = finite(raw.minimum);
      const max = finite(raw.maximum);
      const opts = { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
      return withDescription(type === "integer" ? s.integer(opts) : s.number(opts));
    }
    case "boolean":
      return withDescription(s.boolean());
    case "array": {
      const items =
        raw.items === undefined ? s.unknown() : convert(raw.items, `${at}/items`, depth + 1);
      const maxItems = finite(raw.maxItems);
      return withDescription(
        s.array(items, maxItems !== undefined ? { maxItems } : {}) as AnySchema,
      );
    }
    case "object":
      return withDescription(objectSchema(raw, at, depth));
  }
}

function objectSchema(raw: Record<string, unknown>, at: string, depth: number): AnySchema {
  const where = at || "(input)";
  const props = raw.properties === undefined ? {} : raw.properties;
  if (!isObject(props)) throw new InvalidSchema(`${where}: properties must be an object`);
  const names = Object.keys(props);
  if (names.length > MAX_PROPERTIES)
    throw new InvalidSchema(`${where}: more than ${MAX_PROPERTIES} properties`);
  const required = raw.required === undefined ? [] : raw.required;
  if (!Array.isArray(required) || !required.every((r) => typeof r === "string"))
    throw new InvalidSchema(`${where}: required must be a list of property names`);
  for (const r of required as string[])
    if (!names.includes(r)) throw new InvalidSchema(`${where}: required "${r}" isn't a property`);
  const shape: Record<string, AnySchema> = {};
  for (const name of names) {
    const child = convert(props[name], `${at}/${name}`, depth + 1);
    shape[name] = (required as string[]).includes(name) ? child : (child.optional() as AnySchema);
  }
  if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== "boolean")
    throw new InvalidSchema(`${where}: additionalProperties must be true or false`);
  // Unknown keys are refused, like built-in commands (it catches agents' typos), unless the
  // schema allows them.
  if (raw.additionalProperties !== true) return s.object(shape) as AnySchema;
  return openObject(shape);
}

/** An object that also accepts properties it doesn't name (`additionalProperties: true`). */
function openObject(shape: Record<string, AnySchema>): AnySchema {
  const strict = s.object(shape);
  const json: JsonSchema = { ...strict.json, additionalProperties: true };
  return new Schema<unknown>(json, (value, path, issues: ValidationIssue[]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      issues.push({ path, message: "expected object" });
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, schema] of Object.entries(shape)) {
      const v = record[key];
      if (v === undefined) {
        if (!schema.isOptional) issues.push({ path: `${path}/${key}`, message: "required" });
      } else schema.checkAt(v, `${path}/${key}`, issues);
    }
  });
}

/** Who ran an extension's command, as its handler is told (`{ caller }`, D202). */
export type CommandCallerKind = "user" | "agent" | "extension" | "other";

export function commandCallerKind(caller: Caller): CommandCallerKind {
  switch (caller.kind) {
    case "user":
    case "test": // test scripts stand in for the user
      return "user";
    case "agent":
    case "acp":
    case "mcp":
      return "agent";
    case "ext":
      return "extension";
    default:
      // Callers added later.
      return "other";
  }
}
