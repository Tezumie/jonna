// Writes what tests/scripts/tasks-m7-12.jsonc runs, in the sample copy: shell tasks through
// cmd.exe whose command lines have double quotes (portable-pty's C quoting turned each `"` into
// `\"`, which cmd doesn't read), replacing the copy's .vscode/tasks.json.
const fs = require("node:fs");
const tasks = {
  version: "2.0.0",
  tasks: [
    {
      label: "cmd quotes",
      type: "shell",
      command: 'echo "two words" & echo end-of-task',
      options: { shell: { executable: "cmd.exe" } },
    },
    {
      label: "cmd quoted program",
      type: "shell",
      command: '"node" -e "console.log(process.argv[1])" "arg with spaces"',
      options: { shell: { executable: "cmd.exe" } },
    },
  ],
};
fs.writeFileSync(".vscode/tasks.json", `${JSON.stringify(tasks, null, 2)}\n`);
