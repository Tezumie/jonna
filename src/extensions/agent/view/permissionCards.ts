// The cards above the composer (split from view.ts in D245): a permission request (Deny / Allow,
// "always allow") and the "Where should this project live?" folder card (D121).

import { h } from "../../../core/dom/index";
import { joinPath } from "../../../core/paths/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { PermissionRequest } from "../session";
import type { AgentViewHost } from "./view";

/** "Run `npm test`" → text with the backticked part as code. */
/**
 * An approval card: what's asked (icon, heading, where), the exact command or call as code, an
 * "always allow" checkbox, and Deny / Allow with their keys (Esc, Enter).
 */
export function permissionCard(r: PermissionRequest, first: boolean): HTMLElement {
  const always = r.always && !r.danger ? h("input", { type: "checkbox", class: "checkbox" }) : null;
  // Lasting beyond "always" (D374): ticking it ticks "always" too.
  const remember =
    always && r.remember
      ? (h("input", { type: "checkbox", class: "checkbox" }) as HTMLInputElement)
      : null;
  remember?.addEventListener("change", () => {
    if (remember.checked && always) (always as HTMLInputElement).checked = true;
  });
  always?.addEventListener("change", () => {
    if (remember && !(always as HTMLInputElement).checked) remember.checked = false;
  });
  const key = (k: string) => h("kbd", { class: "agent-permission-key" }, k);
  const button = (label: string, cls: string, k: string, onClick: () => void) => {
    const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label, key(k));
    b.addEventListener("click", onClick);
    return b;
  };
  // The folder card's buttons (D402): the answer that goes ahead is primary, Deny secondary.
  const allow = button("Allow", r.danger ? "button-danger" : "button-primary", "\u23CE", () => {
    if (remember?.checked) r.remember?.run();
    r.resolve((always as HTMLInputElement | null)?.checked ? "always" : "once");
  });
  const glyph = r.danger
    ? "triangle-alert"
    : r.kind === "command"
      ? "square-terminal"
      : r.kind === "tool"
        ? "blocks"
        : r.kind === "agent"
          ? "agent"
          : "shield";
  const card = h(
    "div",
    {
      class: { "agent-permission": true, "is-danger": !!r.danger },
      role: "alertdialog",
      "aria-label": r.title,
    },
    h(
      "div",
      { class: "agent-permission-head" },
      h("span", { class: "agent-permission-icon" }, icon(glyph)),
      h(
        "div",
        { class: "agent-permission-text" },
        h(
          "div",
          { class: "agent-permission-title" },
          ...(r.heading ? [r.heading] : renderTitle(r.title)),
        ),
        r.detail ? h("div", { class: "agent-permission-detail" }, r.detail) : null,
      ),
    ),
    r.code ? h("pre", { class: "agent-permission-code" }, r.code) : null,
    h(
      "div",
      { class: "agent-permission-actions" },
      always
        ? h(
            "label",
            { class: "agent-permission-always" },
            always,
            r.alwaysLabel
              ? h("span", {}, r.alwaysLabel)
              : h("span", {}, "Always allow ", h("code", {}, r.always ?? "")),
          )
        : h("span", { class: "agent-permission-spacer" }),
      remember && r.remember
        ? h(
            "label",
            { class: "agent-permission-always is-remember" },
            remember,
            h("span", {}, r.remember.label),
          )
        : null,
      button("Deny", "button-secondary", "Esc", () => r.resolve("deny")),
      allow,
    ),
  );
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") r.resolve("deny");
  });
  // Focus starts on "Allow" (Enter confirms, Esc denies), but only when the chat has focus:
  // an Enter meant for the editor must not approve a command.
  if (first)
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest(".agent-view")) allow.focus();
    });
  return card;
}

function renderTitle(title: string): (string | HTMLElement)[] {
  return title
    .split(/(`[^`]+`)/)
    .map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));
}

/**
 * "Where should I work?" (D121): a message was sent with no folder open. A project folder is
 * suggested (name from the request, place from the request or agent.projectsFolder); the name can
 * be edited and the place changed. Or open an existing folder, or just chat.
 */
export function folderCard(
  session: string,
  request: { message: string; name: string; parent: string },
  host: AgentViewHost,
): HTMLElement {
  let parent = request.parent;
  const name = h("input", {
    class: "input agent-folder-name",
    value: request.name,
    "aria-label": "Folder name",
    id: `agent-folder-name-${session}`,
    spellcheck: "false",
  }) as HTMLInputElement;
  const where = h("span", { class: "agent-folder-where" }, parent || "Choose a place…");
  const change = h(
    "button",
    { class: "icon-button agent-folder-change", type: "button", "aria-label": "Change location" },
    icon("folder-open"),
  );
  setTooltip(change, "Change location");
  // The whole path box picks a place too (it looks like a field, so it acts like one).
  const place = h(
    "div",
    { class: "agent-folder-place", role: "button", tabindex: "0", "aria-label": "Location" },
    where,
    change,
  );
  // What will be made, in full: the folder the agent is about to create.
  const result = h("div", { class: "agent-folder-result" });
  const showResult = () => {
    const value = name.value.trim();
    result.textContent = value && parent ? `Creates ${joinPath(parent, value)}` : "";
  };
  showResult();
  name.addEventListener("input", showResult);
  const create = h(
    "button",
    { class: "button button-primary button-sm", type: "button" },
    "Create and start",
  );
  const run = (choice: string, extra: Record<string, unknown> = {}) =>
    host.run("agent.startInFolder", { session, choice, ...extra });
  const start = () => {
    const value = name.value.trim();
    if (!value || !parent) return name.focus();
    run("create", { name: value, parent });
  };
  const pick = () => {
    void host.pickFolder("Where should the project folder go?").then((picked) => {
      if (!picked) return;
      parent = picked;
      where.textContent = picked;
      showResult();
    });
  };
  place.addEventListener("click", pick);
  place.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  });
  create.addEventListener("click", start);
  name.addEventListener("keydown", (e) => {
    // Not the Enter that ends an IME composition (a name typed in Japanese or Chinese).
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      start();
    } else if (e.key === "Escape") run("cancel");
  });
  const card = h(
    "div",
    {
      class: "agent-permission agent-folder-card",
      role: "dialog",
      "aria-label": "Choose a folder",
    },
    h(
      "div",
      { class: "agent-permission-head" },
      h("span", { class: "agent-permission-icon" }, icon("folder-plus")),
      h(
        "div",
        { class: "agent-permission-text" },
        h("div", { class: "agent-permission-title" }, "Where should this project live?"),
        h(
          "div",
          { class: "agent-permission-detail" },
          "No folder is open, so I'll make one for this project.",
        ),
      ),
    ),
    // Labels above their fields (D268: a column of labels beside them looked crowded).
    h(
      "div",
      { class: "agent-folder-fields" },
      h(
        "div",
        { class: "agent-folder-field" },
        h("label", { class: "agent-folder-key", for: `agent-folder-name-${session}` }, "Name"),
        name,
      ),
      h(
        "div",
        { class: "agent-folder-field" },
        h("span", { class: "agent-folder-key" }, "Location"),
        place,
        result,
      ),
    ),
    h(
      "div",
      { class: "agent-permission-actions agent-folder-actions" },
      // The other choices, quieter, on the left; the suggested one on the right.
      button("Open folder…", () => run("open")),
      button("Just chat", () => run("chat")),
      h("span", { class: "agent-permission-spacer" }),
      create,
    ),
  );
  requestAnimationFrame(() => {
    name.focus();
    name.select();
  });
  return card;
}

/** The folder card's other choices: real buttons, quieter than Create (D345). */
function button(label: string, onClick: () => void): HTMLElement {
  const b = h("button", { class: "button button-secondary button-sm", type: "button" }, label);
  b.addEventListener("click", onClick);
  return b;
}
