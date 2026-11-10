// The palette asks for a command's required input fields before running it (from its JSON
// Schema): a pick for enums, a text box (validated) for the rest.
import type { JsonSchema } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export /**
 * Prompts for each *required* property of an object schema (optional ones are left out, so the
 * command applies its defaults). Returns undefined if the user cancelled.
 */
async function collectInput(
  schema: JsonSchema,
  quickInput: WorkbenchServices["quickInput"],
  title: string,
): Promise<Record<string, unknown> | undefined> {
  const input: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties?.[key] ?? {};
    const what = prop.description ? `${key} — ${prop.description}` : key;
    if (prop.enum) {
      const options = prop.enum.map((v) => ({ id: String(v), label: String(v) }));
      const choice = await quickInput.pick(options, { placeholder: `${title}: ${what}` });
      if (!choice) return undefined;
      input[key] = prop.enum.find((v) => String(v) === choice.id);
      continue;
    }
    const numeric = prop.type === "integer" || prop.type === "number";
    const value = await quickInput.prompt({
      prompt: `${title}: ${what}`,
      validate: (v) => {
        if (prop.type === "string")
          return v.length === 0 && (prop.minLength ?? 0) > 0 ? "Required" : undefined;
        if (numeric)
          return v.trim() === "" || Number.isNaN(Number(v)) ? "Enter a number" : undefined;
        if (prop.type === "boolean")
          return /^(true|false)$/.test(v) ? undefined : "Enter true or false";
        return undefined;
      },
    });
    if (value === undefined) return undefined;
    input[key] = numeric ? Number(value) : prop.type === "boolean" ? value === "true" : value;
  }
  return input;
}
