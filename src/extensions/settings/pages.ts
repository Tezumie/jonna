// The settings editor's pages (D179, after Cursor's settings and docs sites): groups of pages
// in the navigation, separated by dividers; a page gathers one or more setting categories
// ("Appearance" holds Workbench and Window); each page lists its sections as cards with a
// label above, and the navigation lists the open page's sections under it, like a docs page's
// table of contents. Pages that open elsewhere (the AI models page, keyboard shortcuts,
// extensions) are links with an arrow. A category no page claims (a third-party extension's)
// gets a page of its own in the last group; an extension's categories share one page as sections
// (`groupByExtension`). DOM-free.

import { describeKey } from "../../core/settings/schema";
import type { IconName } from "../../ui/Icon";

export interface SettingsPage {
  id: string;
  title: string;
  icon: IconName;
  /** Setting categories shown on this page, in order. */
  categories: readonly string[];
}

/** A navigation entry that opens something else (a page of its own, a view). */
export interface SettingsLink {
  title: string;
  icon: IconName;
  command: string;
  input?: unknown;
  /** Shown as the link's tooltip. */
  detail: string;
}

export interface SettingsGroup {
  id: string;
  items: readonly (SettingsPage | SettingsLink)[];
}

export const isLink = (item: SettingsPage | SettingsLink): item is SettingsLink =>
  "command" in item;

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "general",
    items: [
      {
        id: "appearance",
        title: "Appearance",
        icon: "layout-dashboard",
        categories: ["Workbench", "Window"],
      },
      {
        id: "editor",
        title: "Editor",
        icon: "file-code",
        categories: ["Editor", "Breadcrumbs", "Outline", "Markdown"],
      },
      {
        id: "files",
        title: "Files and explorer",
        icon: "files",
        categories: ["Files", "Explorer"],
      },
      { id: "search", title: "Search", icon: "search", categories: ["Search"] },
      { id: "terminal", title: "Terminal", icon: "square-terminal", categories: ["Terminal"] },
      {
        title: "Keyboard shortcuts",
        icon: "keyboard",
        command: "keybindings.show",
        detail: "Every command's keys, and your own",
      },
    ],
  },
  {
    id: "ai",
    items: [
      { id: "agent", title: "Agent", icon: "agent", categories: ["Agent"] },
      {
        id: "ai-features",
        title: "AI in the editor",
        icon: "sparkles",
        categories: ["AI features"],
      },
      {
        title: "Models and providers",
        icon: "box",
        command: "agent.showSetup",
        detail: "Connect Anthropic, OpenAI, Gemini, Ollama… or Claude Code, Codex, Copilot",
      },
      {
        title: "Agents",
        icon: "bot",
        command: "agent.showAgentConfig",
        detail: "Plan and build models, subagents, external agents and AI features as a tree",
      },
      {
        title: "Usage",
        icon: "chart-column",
        command: "agent.showUsage",
        detail: "Tokens, cost and provider limits by day, model and chat",
      },
      {
        title: "Rules",
        icon: "book-open",
        command: "agent.showRules",
        detail: "AGENTS.md, Cursor, Copilot and Claude Code rules: scope, on / off, new",
      },
      { id: "mcp", title: "MCP server", icon: "radio-tower", categories: ["MCP"] },
      {
        title: "Customize",
        icon: "sliders-horizontal",
        command: "agent.customize",
        detail: "Models, agents, rules, skills, commands, auto-approve, MCP servers and docs",
      },
    ],
  },
  {
    id: "tools",
    items: [
      {
        id: "source-control",
        title: "Source control",
        icon: "git-branch",
        categories: ["Git", "Github"],
      },
      { id: "browser", title: "Browser and network", icon: "globe", categories: ["Browser"] },
      { id: "debug", title: "Run and debug", icon: "bug-play", categories: ["Debug", "Task"] },
      { id: "testing", title: "Testing", icon: "flask-conical", categories: ["Testing"] },
      {
        id: "language-servers",
        title: "Language servers",
        icon: "braces",
        categories: ["Language servers"],
      },
    ],
  },
  {
    id: "more",
    items: [
      { id: "accounts", title: "Accounts", icon: "circle-user-round", categories: ["Accounts"] },
      {
        title: "Extensions",
        icon: "blocks",
        command: "extensions.show",
        detail: "Install, configure and build extensions",
      },
    ],
  },
];

/** The pages for these categories, in navigation order; unclaimed categories get pages last. */
export function pagesFor(categories: readonly string[]): {
  groups: { id: string; items: (SettingsPage | SettingsLink)[] }[];
  pageOf: (category: string) => SettingsPage | undefined;
} {
  const present = new Set(categories);
  const claimed = new Set(
    SETTINGS_GROUPS.flatMap((g) => g.items.flatMap((i) => (isLink(i) ? [] : i.categories))),
  );
  const groups = SETTINGS_GROUPS.map((g) => ({
    id: g.id,
    // A page whose categories have no settings in this scope isn't shown.
    items: g.items.filter((i) => isLink(i) || i.categories.some((c) => present.has(c))),
  }));
  const extra: SettingsPage[] = categories
    .filter((c) => !claimed.has(c))
    .map((c) => ({ id: `category:${c}`, title: c, icon: "puzzle" as IconName, categories: [c] }));
  // Extensions' categories go in the last group, before its links.
  const last = groups[groups.length - 1];
  if (last && extra.length) last.items = [...extra, ...last.items];
  const pages = groups.flatMap((g) => g.items.filter((i): i is SettingsPage => !isLink(i)));
  return {
    groups: groups.filter((g) => g.items.length),
    pageOf: (category) => pages.find((p) => p.categories.includes(category)),
  };
}

/**
 * Extensions' settings one page per extension (VS Code's Extensions › <name>): a third-party
 * extension's settings whose category no page claims share one page, named after its single
 * category (a VS Code package's one configuration title) or else its keys' common first word
 * ("Gitlens"), with each of its categories (configuration titles) a section there. Settings of
 * the IDE's own extensions (`builtin.*`) and ones on a claimed page ("Editor") stay as they are;
 * two extensions that would share a page title get their ids added. DOM-free.
 */
export function groupByExtension<
  T extends { key: string; category: string; section?: string; extension?: string },
>(settings: readonly T[]): T[] {
  const claimed = new Set(
    SETTINGS_GROUPS.flatMap((g) => g.items.flatMap((i) => (isLink(i) ? [] : i.categories))),
  );
  const own = (s: T) =>
    !!s.extension && !s.extension.startsWith("builtin.") && !claimed.has(s.category);
  const byExtension = new Map<string, T[]>();
  for (const s of settings)
    if (own(s) && s.extension) {
      const list = byExtension.get(s.extension) ?? [];
      list.push(s);
      byExtension.set(s.extension, list);
    }
  const titles = new Map<string, string>();
  for (const [id, list] of byExtension) {
    const categories = new Set(list.map((s) => s.category));
    const [only] = categories;
    if (categories.size === 1 && only) {
      titles.set(id, only);
      continue;
    }
    // The first word most of its keys share ("gitlens" in "gitlens.codeLens.enabled").
    const counts = new Map<string, number>();
    for (const s of list) {
      const first = s.key.split(".")[0] ?? s.key;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? id;
    titles.set(id, describeKey(top).category);
  }
  // A title another extension (or a page of the IDE) has too: the id tells them apart.
  const seen = new Map<string, number>();
  for (const t of titles.values()) seen.set(t.toLowerCase(), (seen.get(t.toLowerCase()) ?? 0) + 1);
  const pageTitles = new Set(
    SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.title.toLowerCase())),
  );
  for (const [id, t] of titles)
    if ((seen.get(t.toLowerCase()) ?? 0) > 1 || pageTitles.has(t.toLowerCase()))
      titles.set(id, `${t} (${id})`);
  return settings.map((s) => {
    const title = own(s) && s.extension ? titles.get(s.extension) : undefined;
    if (!title || title === s.category) return s;
    return { ...s, category: title, section: s.section ?? s.category };
  });
}

/** A setting's section on its page: its own, else its category. */
export function sectionOf(info: { section?: string; category: string }): string {
  return info.section ?? info.category;
}

/**
 * The sections of a page in order: by the page's category order, then first appearance (the
 * registry sorts settings by category, order and key, so a manifest's `order` arranges them).
 */
export function pageSections<T extends { section?: string; category: string }>(
  page: SettingsPage,
  settings: readonly T[],
): { title: string; settings: T[] }[] {
  const out: { title: string; settings: T[] }[] = [];
  for (const category of page.categories)
    for (const s of settings.filter((x) => x.category === category)) {
      const title = sectionOf(s);
      let section = out.find((x) => x.title === title);
      if (!section) {
        section = { title, settings: [] };
        out.push(section);
      }
      section.settings.push(s);
    }
  return out;
}
