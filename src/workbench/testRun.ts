// `--run-test-script <file>`: runs a command script (core/testing) as `caller: test` once the
// workbench is up, prints TAP-like lines on stdout and exits with 0 (passed) or 1 (failed).
import type { Dispatcher } from "../core/dispatcher/index";
import { appIpc } from "../core/ipc/system";
import type { StateTree } from "../core/state/index";
import { parseTestScript, runTestScript } from "../core/testing/script";

const TEST: { kind: "test" } = Object.freeze({ kind: "test" });

export async function runTestScriptFile(
  file: { path: string; text: string },
  dispatcher: Dispatcher,
  state: StateTree,
): Promise<never | undefined> {
  // Lines go out one at a time so stdout keeps their order.
  let queue = Promise.resolve();
  const log = (line: string) => {
    console.info(line);
    queue = queue.then(() => appIpc.testLog(line)).catch(() => {});
  };
  let code = 1;
  try {
    const script = parseTestScript(file.text);
    const result = await runTestScript(script, {
      execute: (command, input) => dispatcher.execute(command, input, TEST),
      state: async (path) => (await state.get(path, { budget: 200_000 })).value,
      log,
    });
    code = result.failed === 0 ? 0 : 1;
  } catch (err) {
    log(`Bail out! ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await queue;
  await appIpc.exit(code);
  return undefined;
}
