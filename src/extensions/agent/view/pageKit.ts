// Small builders shared by the agent's pages (D204: Rules, Docs, Auto-approve, MCP servers,
// Worktree agents, Compare), on the AI pages' layout (ai-setup.css: .ai-page, .ai-header,
// .ai-section, .ai-list rows, .ai-form fields). Buttons only call commands (`run`), so every
// action stays a dispatcher command.
import { h, on } from "../../../core/dom/index";
import type { DisposableStore } from "../../../core/lifecycle/index";
import { type IconName, icon } from "../../../ui/Icon";
import type { WorkbenchServices } from "../../../workbench/services";

/** Runs a command; a failure is shown as a notification and gives null. */
export function runCommand(
  services: WorkbenchServices,
  command: string,
  input: unknown = {},
): Promise<unknown> {
  return services.dispatcher.execute(command, input).catch((err: unknown) => {
    services.notifications.show("error", err instanceof Error ? err.message : String(err));
    return null;
  });
}

export function pageHeader(
  title: string,
  lead: string | null,
  ...actions: (HTMLElement | null)[]
): HTMLElement {
  return h(
    "header",
    { class: "ai-header" },
    h(
      "div",
      null,
      h("h1", { class: "ai-title" }, title),
      lead ? h("p", { class: "ai-lead" }, lead) : null,
    ),
    h("div", { class: "ai-header-actions" }, ...actions),
  );
}

export function pageSection(
  title: string,
  lead: string | null,
  ...children: (HTMLElement | null)[]
): HTMLElement {
  return h(
    "section",
    { class: "ai-section" },
    h("h2", { class: "ai-section-title" }, title),
    lead ? h("p", { class: "ai-section-lead" }, lead) : null,
    ...children,
  );
}

/**
 * A section's add button, as Skills has it (D399): "+ New" at the right of its title, quiet
 * (ghost) and small. Every Customize page uses this one for adding.
 */
export function addButton(
  store: DisposableStore,
  label: string,
  click: () => unknown,
  attrs: Record<string, string> = {},
  glyph: IconName = "plus",
): HTMLButtonElement {
  const cls = ["button button-ghost button-sm page-add", attrs.class].filter(Boolean).join(" ");
  const el = h("button", { type: "button", ...attrs, class: cls }, icon(glyph), label);
  store.add(on(el, "click", () => void click()));
  return el;
}

/**
 * A titled group of rows (D399, the Skills page's): its title with a count, actions at the
 * right (addButton), then its rows as separate cards (.mcp-list) or an empty note.
 */
export function pageGroup(
  title: string,
  count: number | null,
  actions: (HTMLElement | null)[],
  body: (HTMLElement | null)[],
  attrs: Record<string, string> = {},
): HTMLElement {
  return h(
    "section",
    { ...attrs, class: ["mcp-group", attrs.class].filter(Boolean).join(" ") },
    h(
      "div",
      { class: "page-group-head" },
      h(
        "h2",
        { class: "mcp-group-title" },
        count === null ? title : `${title} `,
        count === null ? null : h("span", { class: "mcp-group-count" }, String(count)),
      ),
      actions.some(Boolean) ? h("div", { class: "page-group-actions" }, ...actions) : null,
    ),
    ...body,
  );
}

/** An item of a row's ⋯ menu. */
export interface RowAction {
  id: string;
  label: string;
  run: () => unknown;
}

/** Shows a row's ⋯ menu in the quick pick and runs the chosen item. */
export function pickRowAction(
  services: WorkbenchServices,
  placeholder: string,
  actions: RowAction[],
): Promise<void> {
  return services.quickInput
    .pick(
      actions.map(({ id, label }) => ({ id, label })),
      { placeholder },
    )
    .then((picked) => {
      void actions.find((a) => a.id === picked?.id)?.run();
    });
}

/**
 * A row as Skills draws it (D399): an icon tile, the name with its tags, detail lines, and a ⋯
 * that shows on hover. `open` runs on a click or Enter; without it the row is static.
 */
export function cardRow(
  store: DisposableStore,
  o: {
    attrs: Record<string, string>;
    glyph: Node;
    name: string | Node;
    label?: string;
    badges?: (string | null | false)[];
    details?: (string | null | false)[];
    open?: () => unknown;
    more?: () => unknown;
    end?: (HTMLElement | null)[];
    off?: boolean;
  },
): HTMLElement {
  const label = o.label ?? (typeof o.name === "string" ? o.name : "");
  const moreButton = o.more
    ? h(
        "button",
        { class: "icon-button mcp-row-more", type: "button", "aria-label": `More for ${label}` },
        icon("ellipsis"),
      )
    : null;
  const more = o.more;
  if (moreButton && more)
    store.add(
      on(moreButton, "click", (ev) => {
        ev.stopPropagation();
        void more();
      }),
    );
  const open = o.open;
  const classes = ["mcp-row", "page-row", o.off ? "is-off" : "", open ? "" : "is-static"];
  const el = h(
    "div",
    {
      ...o.attrs,
      class: classes.filter(Boolean).join(" "),
      ...(open && { tabindex: "0", role: "button" }),
    },
    h("span", { class: "mcp-row-icon" }, o.glyph),
    h(
      "span",
      { class: "mcp-row-main" },
      h(
        "span",
        { class: "mcp-row-title" },
        h("span", { class: "mcp-row-name" }, o.name),
        ...(o.badges ?? []).filter((x): x is string => !!x).map((x) => tag(x)),
      ),
      ...(o.details ?? [])
        .filter((x): x is string => !!x)
        .map((x) => h("span", { class: "mcp-row-detail", title: x }, x)),
    ),
    ...(o.end ?? []),
    moreButton,
  );
  if (open) {
    store.add(on(el, "click", () => void open()));
    store.add(
      on(el, "keydown", (ev) => {
        if (ev.target !== el) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void open();
        }
      }),
    );
  }
  return el;
}

export function pageButton(
  store: DisposableStore,
  label: string,
  glyph: IconName | null,
  click: () => unknown,
  className = "button button-secondary button-sm",
): HTMLButtonElement {
  const el = h("button", { class: className, type: "button" }, glyph ? icon(glyph) : null, label);
  store.add(on(el, "click", () => void click()));
  return el;
}

export function linkButton(
  store: DisposableStore,
  label: string,
  click: () => unknown,
  danger = false,
): HTMLButtonElement {
  const el = h("button", { class: `ai-link${danger ? " is-danger" : ""}`, type: "button" }, label);
  store.add(on(el, "click", () => void click()));
  return el;
}

/** A labelled field around an input, select or textarea. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "label",
    { class: "ai-field" },
    h("span", { class: "ai-field-label" }, label),
    control,
    hint ? h("span", { class: "ai-row-detail" }, hint) : null,
  );
}

export function textInput(label: string, value = "", placeholder = ""): HTMLInputElement {
  const el = h("input", {
    class: "input",
    type: "text",
    "aria-label": label,
    ...(placeholder && { placeholder }),
  });
  el.value = value;
  return el;
}

export function selectInput(
  label: string,
  options: readonly (readonly [string, string])[],
  value: string,
): HTMLSelectElement {
  const el = h(
    "select",
    { class: "input", "aria-label": label },
    ...options.map(([id, text]) => h("option", { value: id }, text)),
  );
  el.value = value;
  return el;
}

export function textArea(label: string, value = "", rows = 8): HTMLTextAreaElement {
  const el = h("textarea", {
    class: "input agent-page-textarea",
    "aria-label": label,
    rows: String(rows),
    spellcheck: "false",
  });
  el.value = value;
  return el;
}

/** An on/off switch (a checkbox styled as a switch). */
export function toggle(
  store: DisposableStore,
  label: string,
  checked: boolean,
  change: (on: boolean) => unknown,
): HTMLElement {
  const box = h("input", { type: "checkbox", class: "agent-page-switch", "aria-label": label });
  box.checked = checked;
  store.add(on(box, "change", () => void change(box.checked)));
  return box;
}

export function tag(text: string, title?: string): HTMLElement {
  return h("span", { class: "ai-tag", ...(title && { title }) }, text);
}

export function emptyNote(text: string): HTMLElement {
  return h("p", { class: "ai-section-lead agent-page-empty" }, text);
}
