// Test extension for the caller checks (tests/scripts/windows-m7-12.jsonc): runs `command` with
// `input` as this extension and returns its result or its error, so the script can see both.
exports.activate = (ide) => {
  ide.commands.register("guards.try", async (input) => {
    try {
      const result = await ide.commands.execute(input.command, input.input ?? {});
      return { ok: true, result: result ?? null, error: null };
    } catch (err) {
      return { ok: false, result: null, error: String(err && err.message ? err.message : err) };
    }
  });
};
