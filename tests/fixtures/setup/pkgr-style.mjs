// An output style file for tests (D356, agent-output-style-m7-98): Claude Code's project folder
// (.claude/output-styles), read by the IDE in a trusted folder. Without keep-coding-instructions:
// the IDE's coding guidance gives way to its essentials.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".claude/output-styles", { recursive: true });
writeFileSync(
  ".claude/output-styles/pkgr-pirate.md",
  "---\nname: Pirate\ndescription: Talks like a pirate (a test style)\n---\n\nPKGR-PIRATE-MARKER Speak like a pirate in every reply.\n",
);
console.log("pkgr style written");
