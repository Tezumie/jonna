// The chat's cards for suggest_skill (D342), suggest_mcp_server and mcp_status (D343). Plain DOM
// with tokens; what a card does goes through the host to commands (agent.addSuggestedSkill,
// agent.addSuggestedMcpServer, agent.reconnectMcpServer, agent.showSkills / showMcpPage). The
// cards are drawn from their call's detail and rebuilt when it changes (added, reconnected) or
// while a button works, so their own state is only what's typed in the fields meanwhile.

import type { Item } from "../../../core/agent/conversation";
import { parseAllowanceSuggestion } from "../../../core/agent/sandboxPolicy";
import { parseSkillSuggestion, type SkillSuggestion } from "../../../core/agent/skillSuggest";
import { h, on } from "../../../core/dom/index";
import {
  canReconnect,
  type McpStatusCard,
  type McpSuggestion,
  parseMcpStatus,
  parseMcpSuggestion,
  type SuggestedServer,
} from "../../../core/mcp/suggest";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { discoveryBusy, stashCardValues } from "../discoveryCommands";
import { sandboxAllowanceCard } from "./sandboxCard";
import type { ToolCardHost } from "./toolCards";

type ToolItem = Extract<Item, { type: "tool" }>;

/** The tools drawn here. */
export const DISCOVERY_CARDS = new Set([
  "suggest_skill",
  "suggest_mcp_server",
  "mcp_status",
  // D350, view/sandboxCard.ts.
  "suggest_sandbox_allowance",
]);

/** What redraws a discovery card besides its status: its detail and what's busy now. */
export function discoveryCardState(item: ToolItem): string {
  if (!DISCOVERY_CARDS.has(item.name)) return "";
  return `${item.detail ?? ""}${[...discoveryBusy(item.id)].join()}`;
}

/** A discovery tool's card, or null (not one, or nothing to draw: shown as a row). */
export function discoveryCard(item: ToolItem, host: ToolCardHost): HTMLElement | null {
  const busy = discoveryBusy(item.id);
  let card: HTMLElement | null = null;
  if (item.name === "suggest_skill") {
    const data = parseSkillSuggestion(item.detail);
    card = data ? skillsCard(data, host, busy) : null;
  } else if (item.name === "suggest_mcp_server") {
    const data = parseMcpSuggestion(item.detail);
    card = data ? mcpServersCard(data, host, busy) : null;
  } else if (item.name === "mcp_status") {
    const data = parseMcpStatus(item.detail);
    card = data?.servers.length ? mcpStatusCard(data, host, busy) : null;
  } else if (item.name === "suggest_sandbox_allowance") {
    const data = parseAllowanceSuggestion(item.detail);
    card = data ? sandboxAllowanceCard(data, host) : null;
  }
  if (card) card.dataset.key = `rb-tool-${item.id}-${discoveryCardState(item)}`;
  return card;
}

const target = (host: ToolCardHost) => ({
  ...(host.session && { session: host.session }),
  item: host.item ?? "",
});

function actionButton(
  label: string,
  options: { primary: boolean; disabled: boolean; onClick?: () => void },
): HTMLButtonElement {
  const button = h(
    "button",
    {
      class: {
        button: true,
        "button-sm": true,
        "button-primary": options.primary,
        "button-secondary": !options.primary,
        "rb-discovery-action": true,
      },
      type: "button",
      ...(options.disabled && { disabled: "" }),
    },
    label,
  );
  if (!options.disabled && options.onClick) on(button, "click", options.onClick);
  return button;
}

// ---- suggest_skill ---------------------------------------------------------------------------

export function skillsCard(
  s: SkillSuggestion,
  host: ToolCardHost,
  busy: ReadonlySet<string>,
): HTMLElement {
  return h(
    "div",
    { class: "rb rb-discovery rb-skills" },
    s.reason ? h("div", { class: "rb-discovery-reason" }, s.reason) : null,
    ...s.items.map((x) => {
      const adding = busy.has(x.name);
      const button = actionButton(
        x.added
          ? x.source === "off"
            ? "Turned on"
            : "Added"
          : adding
            ? "Adding…"
            : x.source === "off"
              ? "Turn on"
              : "Add",
        {
          primary: !x.added,
          disabled: !!x.added || adding || !host.run,
          onClick: () => host.run?.("agent.addSuggestedSkill", { ...target(host), name: x.name }),
        },
      );
      const name = h("button", { class: "rb-discovery-name", type: "button" }, x.name);
      setTooltip(name, "Open the Skills page");
      on(name, "click", () => host.run?.("agent.showSkills", {}));
      return h(
        "div",
        { class: "rb-discovery-row", "data-skill": x.name },
        h("span", { class: "rb-discovery-icon" }, icon("zap")),
        h(
          "div",
          { class: "rb-discovery-text" },
          h(
            "div",
            { class: "rb-discovery-title" },
            name,
            h(
              "span",
              { class: "rb-discovery-meta" },
              x.source === "off" ? `Turned off${x.where ? ` · ${x.where}` : ""}` : "Skill catalog",
            ),
          ),
          h("div", { class: "rb-discovery-description" }, x.description),
        ),
        button,
      );
    }),
  );
}

// ---- suggest_mcp_server ----------------------------------------------------------------------

const RUNNER_LABEL: Record<SuggestedServer["runner"], string> = {
  npx: "npx",
  uvx: "uvx",
  docker: "Docker",
  remote: "Remote",
  other: "Local",
};

/** One input's field: a choice list, a hidden box for a key, or a text box. */
function inputField(
  server: SuggestedServer,
  input: SuggestedServer["inputs"][number],
): { row: HTMLElement; read: () => string } {
  const id = `rb-mcp-${server.id}-${input.id}`.replace(/[^\w-]/g, "_");
  let field: HTMLInputElement | HTMLSelectElement;
  if (input.options?.length) {
    const select = h(
      "select",
      { class: "input rb-discovery-field", id },
      ...input.options.map((o) =>
        h("option", { value: o, ...(o === input.default && { selected: "" }) }, o),
      ),
    );
    field = select;
  } else {
    field = h("input", {
      class: "input rb-discovery-field",
      id,
      type: input.password ? "password" : "text",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: input.password ? "Stored on this computer" : (input.default ?? ""),
      ...(input.default && !input.password && { value: input.default }),
      "data-input": input.id,
    });
  }
  const row = h(
    "label",
    { class: "rb-discovery-input", for: id },
    h("span", { class: "rb-discovery-input-label" }, input.description || input.id),
    field,
  );
  return { row, read: () => field.value };
}

export function mcpServersCard(
  s: McpSuggestion,
  host: ToolCardHost,
  busy: ReadonlySet<string>,
): HTMLElement {
  return h(
    "div",
    { class: "rb rb-discovery rb-mcp-servers" },
    s.reason ? h("div", { class: "rb-discovery-reason" }, s.reason) : null,
    ...s.items.map((x) => {
      const adding = busy.has(x.id);
      const fields = x.added ? [] : x.inputs.map((i) => ({ id: i.id, ...inputField(x, i) }));
      const button = actionButton(x.added ? "Added" : adding ? "Adding…" : "Add", {
        primary: !x.added,
        disabled: !!x.added || adding || !host.run,
        onClick: () => {
          const values: Record<string, string> = {};
          for (const f of fields) {
            const v = f.read();
            if (v) values[f.id] = v;
          }
          if (host.item) stashCardValues(host.item, x.id, values);
          host.run?.("agent.addSuggestedMcpServer", { ...target(host), id: x.id });
        },
      });
      const title = x.homepage
        ? h("button", { class: "rb-discovery-name", type: "button" }, x.title)
        : h("span", { class: "rb-discovery-name" }, x.title);
      if (x.homepage) {
        const page = x.homepage;
        setTooltip(title, page);
        on(title, "click", () => host.openLink(page));
      }
      const needs = [
        x.needs ? `Needs ${x.needs}` : "",
        x.oauth ? "Signs in on the MCP servers page" : "",
        x.inputs.length && !x.added ? "Left empty, a value is asked for when it first starts" : "",
      ].filter(Boolean);
      return h(
        "div",
        { class: "rb-discovery-row rb-mcp-server", "data-server": x.id },
        h("span", { class: "rb-discovery-icon" }, icon(x.runner === "remote" ? "globe" : "server")),
        h(
          "div",
          { class: "rb-discovery-text" },
          h(
            "div",
            { class: "rb-discovery-title" },
            title,
            h("span", { class: "rb-discovery-chip" }, RUNNER_LABEL[x.runner]),
            h(
              "span",
              { class: "rb-discovery-meta" },
              x.source === "registry" ? "MCP registry (not reviewed)" : "Popular servers",
            ),
          ),
          x.description ? h("div", { class: "rb-discovery-description" }, x.description) : null,
          h("code", { class: "rb-discovery-runs" }, x.runs),
          needs.length ? h("div", { class: "rb-discovery-meta" }, needs.join(" · ")) : null,
          x.warnings?.length
            ? h("div", { class: "rb-discovery-warning" }, `Note: it ${x.warnings.join("; ")}.`)
            : null,
          x.added ? h("div", { class: "rb-discovery-meta" }, `Added as ${x.added}`) : null,
          fields.length
            ? h("div", { class: "rb-discovery-inputs" }, ...fields.map((f) => f.row))
            : null,
        ),
        button,
      );
    }),
  );
}

// ---- mcp_status ------------------------------------------------------------------------------

const STATE_LABEL: Record<string, string> = {
  running: "Running",
  starting: "Starting",
  failed: "Failed",
  waiting: "Waiting",
  "not started": "Not started",
};

export function mcpStatusCard(
  s: McpStatusCard,
  host: ToolCardHost,
  busy: ReadonlySet<string>,
): HTMLElement {
  const header = h(
    "div",
    { class: "rb-discovery-reason rb-mcp-status-header" },
    h("span", {}, `MCP servers (${s.servers.length})`),
  );
  const page = h("button", { class: "rb-discovery-name", type: "button" }, "Manage");
  setTooltip(page, "Open the MCP servers page");
  on(page, "click", () => host.run?.("agent.showMcpPage", {}));
  header.append(page);
  return h(
    "div",
    { class: "rb rb-discovery rb-mcp-status" },
    header,
    ...s.servers.map((r) => {
      const working = busy.has(r.name);
      const failed = r.state === "failed";
      return h(
        "div",
        {
          class: { "rb-discovery-row": true, "rb-mcp-status-row": true, "is-failed": failed },
          "data-server": r.name,
        },
        h(
          "span",
          { class: "rb-discovery-icon" },
          icon(r.transport === "http" ? "globe" : "server"),
        ),
        h(
          "div",
          { class: "rb-discovery-text" },
          h(
            "div",
            { class: "rb-discovery-title" },
            h("span", { class: "rb-discovery-name" }, r.name),
            h(
              "span",
              { class: "rb-mcp-state" },
              `${STATE_LABEL[r.state] ?? r.state}${r.state === "running" ? ` · ${r.tools} tools` : ""}`,
            ),
            h("span", { class: "rb-discovery-meta" }, r.source),
          ),
          r.error ? h("div", { class: "rb-discovery-warning" }, r.error) : null,
          r.needsSignIn ? h("div", { class: "rb-discovery-meta" }, "Needs you to sign in") : null,
          r.reconnected
            ? h(
                "div",
                { class: "rb-discovery-meta" },
                `Reconnected: ${STATE_LABEL[r.reconnected] ?? r.reconnected}`,
              )
            : null,
        ),
        canReconnect(r)
          ? actionButton(working ? "Reconnecting…" : "Reconnect", {
              primary: failed,
              disabled: working || !host.run,
              onClick: () =>
                host.run?.("agent.reconnectMcpServer", { ...target(host), name: r.name }),
            })
          : null,
      );
    }),
  );
}
