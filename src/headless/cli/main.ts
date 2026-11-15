// Node only. The command line's entry: reads the arguments, answers --help and --version
// without starting anything, and hands the rest to the mode asked for. The brain (a large
// bundle) is only loaded by the modes that need it.
import { product } from "../../core/product";
import { type CliArgs, decideMode, parseArgs, type Terminals, UsageError } from "./args";
import { helpText } from "./help";
import { leave, processIo } from "./io";
import { cliName } from "./name";
import { EXIT } from "./output";

export async function main(argv: readonly string[]): Promise<never> {
  const io = processIo();
  const name = cliName();
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`${name}: ${err.message}\nTry: ${name} --help\n`);
    return leave(EXIT.usage);
  }
  if (args.help) {
    io.out(`${helpText(name, args.command)}\n`);
    return leave(EXIT.ok);
  }
  if (args.version) {
    io.out(`${name} ${product.version}\n`);
    return leave(EXIT.ok);
  }
  const tty: Terminals = { stdin: io.stdin.isTTY === true, stdout: io.stdout.isTTY === true };
  let code: number;
  try {
    const mode = decideMode(args, tty);
    switch (mode) {
      case "run":
        code = await (await import("./oneShot")).runOneShot(args, io, tty);
        break;
      case "interactive":
        code = await (await import("./interactive")).runInteractive(args, io);
        break;
      case "sessions":
        code = await (await import("./sessionsCommand")).runSessions(args, io);
        break;
      case "serve":
        code = await (await import("./serve")).runServe(args, io);
        break;
      case "acp":
        code = await (await import("./acpAgent")).runAcp(args, io);
        break;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${name}: ${err.message}\nTry: ${name} --help\n`);
      return leave(EXIT.usage);
    }
    // A mode's own errors carry their class's name across the lazy import.
    const named = err instanceof Error ? err.name : "";
    io.err(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    return leave(named === "ConfigError" ? EXIT.usage : EXIT.failed);
  }
  return leave(code);
}
