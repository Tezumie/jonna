// The command's own name, for its help and messages: what the build named the launcher
// (`node build.mjs --headless [--cli-name=<name>]`), which by default is the product's short
// name in lower case (product.json). Never written in the code.
import { product } from "../../core/product";

declare const __CLI_NAME__: string | undefined;

export function cliName(): string {
  return typeof __CLI_NAME__ === "string" && __CLI_NAME__
    ? __CLI_NAME__
    : product.nameShort.toLowerCase();
}
