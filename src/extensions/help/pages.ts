// The user guide (docs/guide/*.md), bundled: shown in the Documentation tab and readable by the
// agent (help.readDocs). `{{product}}` becomes the product's name. DOM-free.
import gettingStarted from "../../../docs/guide/01-getting-started.md?raw";
import quickAccess from "../../../docs/guide/02-quick-access.md?raw";
import userInterface from "../../../docs/guide/03-user-interface.md?raw";
import editing from "../../../docs/guide/04-editing.md?raw";
import agent from "../../../docs/guide/05-agent.md?raw";
import agentsChannels from "../../../docs/guide/06-agents-channels.md?raw";
import agentCustomize from "../../../docs/guide/07-agent-customize.md?raw";
import git from "../../../docs/guide/08-git.md?raw";
import search from "../../../docs/guide/09-search.md?raw";
import terminal from "../../../docs/guide/10-terminal.md?raw";
import browser from "../../../docs/guide/11-browser.md?raw";
import tasks from "../../../docs/guide/12-tasks.md?raw";
import debugging from "../../../docs/guide/13-debugging.md?raw";
import testing from "../../../docs/guide/14-testing.md?raw";
import notebooks from "../../../docs/guide/15-notebooks.md?raw";
import settings from "../../../docs/guide/16-settings-themes.md?raw";
import keyboard from "../../../docs/guide/17-keyboard-shortcuts.md?raw";
import extensions from "../../../docs/guide/18-extensions.md?raw";
import remote from "../../../docs/guide/19-remote.md?raw";
import workspaces from "../../../docs/guide/20-workspaces.md?raw";
import troubleshooting from "../../../docs/guide/21-troubleshooting.md?raw";

export interface DocPage {
  /** The file name ("02-quick-access.md"); links between pages use it. */
  id: string;
  title: string;
  text: string;
}

const RAW: [string, string][] = [
  ["01-getting-started.md", gettingStarted],
  ["02-quick-access.md", quickAccess],
  ["03-user-interface.md", userInterface],
  ["04-editing.md", editing],
  ["05-agent.md", agent],
  ["06-agents-channels.md", agentsChannels],
  ["07-agent-customize.md", agentCustomize],
  ["08-git.md", git],
  ["09-search.md", search],
  ["10-terminal.md", terminal],
  ["11-browser.md", browser],
  ["12-tasks.md", tasks],
  ["13-debugging.md", debugging],
  ["14-testing.md", testing],
  ["15-notebooks.md", notebooks],
  ["16-settings-themes.md", settings],
  ["17-keyboard-shortcuts.md", keyboard],
  ["18-extensions.md", extensions],
  ["19-remote.md", remote],
  ["20-workspaces.md", workspaces],
  ["21-troubleshooting.md", troubleshooting],
];

export function docPages(product: string): DocPage[] {
  return RAW.map(([id, raw]) => {
    const text = raw.replaceAll("{{product}}", product);
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
    return { id, title, text };
  });
}

/** A page by id, "quick-access", or title (case-insensitive). */
export function findPage(pages: readonly DocPage[], name: string): DocPage | undefined {
  const n = name.trim().toLowerCase().replace(/\.md$/, "");
  return pages.find(
    (p) =>
      p.id.toLowerCase().replace(/\.md$/, "") === n ||
      p.id.toLowerCase().replace(/^\d+-|\.md$/g, "") === n ||
      p.title.toLowerCase() === n,
  );
}
