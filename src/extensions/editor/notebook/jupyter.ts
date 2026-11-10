// What the notebook editor knows about the built-in Jupyter extension (D203), which runs Jupyter
// notebooks' cells (the .ipynb format itself is the IDE's, D204): the message when it's off, and
// reading kernels remembered by earlier versions. DOM-free and tested (notebook.test.ts).

import {
  JUPYTER_EXTENSION,
  JUPYTER_KERNELS,
  type KernelOption,
} from "../../../core/notebook/providers";

/** Why a Jupyter notebook's cells can't run: nothing runs them (the Jupyter extension is off). */
export const jupyterOff = (): string =>
  `Running Jupyter notebooks needs the Jupyter extension: choose "Enable the Jupyter extension" in Select kernel, or turn it on in Extensions (${JUPYTER_EXTENSION}).`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A kernel remembered for a notebook, as saved by any version: a KernelOption; one of the IDE's
 * own Jupyter kernels (D202, source "jupyter"); or a Jupyter choice from before D202
 * ({ python, kernel?, label, detail, language }). Null when it's none of them.
 */
export function rememberedOption(v: unknown): KernelOption | null {
  if (!isObject(v)) return null;
  const label = typeof v.label === "string" ? v.label : "";
  const detail = typeof v.detail === "string" ? v.detail : "";
  const language = typeof v.language === "string" ? v.language : "python";
  if (typeof v.source === "string" && typeof v.id === "string")
    return {
      source: v.source === "jupyter" ? JUPYTER_KERNELS : v.source,
      id: v.id,
      label,
      detail,
      language,
      ...(v.data !== undefined && { data: v.data }),
    };
  const python = v.python as { command?: unknown; args?: unknown } | undefined;
  if (!isObject(python) || typeof python.command !== "string") return null;
  const args = Array.isArray(python.args)
    ? python.args.filter((a): a is string => typeof a === "string")
    : [];
  const kernel = typeof v.kernel === "string" ? v.kernel : undefined;
  return {
    source: JUPYTER_KERNELS,
    id: [python.command, ...args, kernel ?? "(plain)"].join(" "),
    label,
    detail,
    language,
    data: { python: { command: python.command, args }, ...(kernel && { kernel }) },
  };
}
