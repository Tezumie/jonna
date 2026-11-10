// The Styles pane of Elements (D146), as in Chrome's DevTools: element.style and every matched
// rule in cascade order, with each declaration editable in place — a checkbox switches it off
// and on, a click edits its name or value (Tab moves on, Enter keeps, Escape puts it back),
// Up / Down step the number under the caret (Shift ×10, Alt ×0.1) while the page updates
// live, a swatch opens a color picker, a click on a rule's empty end adds a declaration.
// Overridden declarations are struck through. `.cls` switches the element's classes. Changes go
// to the page only (as in Chrome without workspace mapping): the files stay as they are.
import { h, on } from "../../../core/dom/index";
import type { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { DevtoolsHost } from "./common";
import { bumpNumber, byPrecedence, colorTokens, overridden } from "./cssEdit";

export interface StyleRule {
  /** "inline" for element.style; else the bridge's rule id. */
  id: string;
  selector: string;
  source: string;
  specificity: number[];
  order: number;
  props: [string, string, boolean, boolean][];
}

/** Classes switched off per element (kept so their chip stays, unchecked). */
const offClasses = new Map<string, Set<string>>();

export interface StylesContext {
  host: DevtoolsHost;
  /** Listeners of this rendering (cleared on the next). */
  store: DisposableStore;
  /** The element's ref. */
  id: string;
  /** Its class attribute now. */
  className: string;
  inline: StyleRule["props"];
  rules: (Omit<StyleRule, "specificity" | "order"> & { specificity?: number[]; order?: number })[];
  filter: string;
  setFilter(text: string): void;
  /** Re-reads the styles and renders again (after a change). */
  refresh(): Promise<void>;
}

/** A color as #rrggbb for <input type="color"> (null when it can't be one). */
function toHex(color: string): string | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "black";
  ctx.fillStyle = color;
  const v = String(ctx.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m
    ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`
    : null;
}

/**
 * Edits `target`'s text in place with an input; `onInput` runs as it's typed, `done` once
 * with the outcome. Up / Down step numbers when `numbers` is set.
 */
function editInPlace(
  store: DisposableStore,
  target: HTMLElement,
  initial: string,
  options: {
    numbers?: boolean;
    onInput?(value: string): void;
    done(value: string, how: "enter" | "tab" | "shift-tab" | "blur" | "escape"): void;
  },
): HTMLInputElement {
  const input = h("input", {
    class: "dt-edit",
    type: "text",
    spellcheck: "false",
    value: initial,
  });
  const size = () => {
    input.size = Math.max(1, input.value.length + 1);
  };
  size();
  target.replaceChildren(input);
  let finished = false;
  const finish = (how: "enter" | "tab" | "shift-tab" | "blur" | "escape") => {
    if (finished) return;
    finished = true;
    options.done(input.value, how);
  };
  store.add(
    on(input, "input", () => {
      size();
      options.onInput?.(input.value);
    }),
  );
  store.add(
    on(input, "keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish("enter");
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish("escape");
      } else if (e.key === "Tab") {
        e.preventDefault();
        finish(e.shiftKey ? "shift-tab" : "tab");
      } else if (options.numbers && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        const r = bumpNumber(
          input.value,
          input.selectionStart ?? input.value.length,
          e.key === "ArrowUp" ? step : -step,
        );
        if (!r) return;
        e.preventDefault();
        input.value = r.value;
        input.setSelectionRange(r.start, r.end);
        size();
        options.onInput?.(input.value);
      }
    }),
  );
  store.add(on(input, "blur", () => finish("blur")));
  input.focus();
  input.select();
  return input;
}

export function renderStyles(ctx: StylesContext): HTMLElement {
  const { host, store, id } = ctx;
  const call = (method: string, params: Record<string, unknown>) =>
    host.page.call(method, { id, ...params }).catch((err: unknown) => {
      host.services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  const all: StyleRule[] = byPrecedence([
    {
      id: "inline",
      selector: "element.style",
      source: "",
      specificity: [1, 0, 0],
      order: -1,
      props: ctx.inline,
    },
    ...ctx.rules.map((r, i) => ({
      ...r,
      specificity: r.specificity ?? [0, 0, 0],
      order: r.order ?? i,
    })),
  ]);
  const losing = overridden(all);
  const filter = ctx.filter;
  const matches = (name: string, value: string) =>
    !filter || name.includes(filter) || value.toLowerCase().includes(filter);

  /** A declaration's row; `index` is its place in the rule (for the cascade marks). */
  const propRow = (
    rule: StyleRule,
    [name, value, important, enabled]: StyleRule["props"][number],
    index: number,
  ) => {
    const full = `${value}${important ? " !important" : ""}`;
    const check = h("input", {
      type: "checkbox",
      class: "dt-prop-check",
      "aria-label": `${enabled ? "Switch off" : "Switch on"} ${name}`,
    });
    check.checked = enabled;
    store.add(
      on(
        check,
        "change",
        () =>
          void call("css.toggle", { rule: rule.id, name, enabled: check.checked }).then(() =>
            ctx.refresh(),
          ),
      ),
    );
    const nameEl = h("span", { class: "dt-prop-name dt-editable" }, name);
    const valueEl = h("span", { class: "dt-prop-value dt-editable" });
    // Colors get a swatch that opens the color picker.
    const fillValue = () => {
      const parts: (string | HTMLElement)[] = [];
      let at = 0;
      for (const c of colorTokens(full)) {
        parts.push(full.slice(at, c.start));
        const swatch = h("span", {
          class: "dt-swatch",
          role: "button",
          "aria-label": `Pick a color for ${name}`,
        });
        swatch.style.background = c.text;
        store.add(
          on(swatch, "click", (e) => {
            e.stopPropagation();
            const picker = h("input", { type: "color", class: "dt-color-input" });
            picker.value = toHex(c.text) ?? toHex("black") ?? "";
            document.body.append(picker);
            const apply = () =>
              void call("css.set", {
                rule: rule.id,
                name,
                value: full.slice(0, c.start) + picker.value + full.slice(c.end),
              });
            store.add(on(picker, "input", apply));
            store.add(
              on(picker, "change", () => {
                apply();
                picker.remove();
                void ctx.refresh();
              }),
            );
            store.add(on(picker, "blur", () => picker.remove()));
            picker.click();
          }),
        );
        parts.push(swatch, c.text);
        at = c.end;
      }
      parts.push(full.slice(at));
      valueEl.replaceChildren(...parts);
    };
    fillValue();
    const row = h(
      "div",
      {
        class: {
          "dt-prop": true,
          "is-off": !enabled,
          "is-overridden": losing.has(`${rule.id}:${index}`),
        },
        "data-prop": name,
      },
      check,
      nameEl,
      h("span", { class: "dt-prop-sep" }, ": "),
      valueEl,
      ";",
    );
    row.hidden = !matches(name, full);
    const editValue = () => {
      let timer = 0;
      editInPlace(store, valueEl, full, {
        numbers: true,
        // The page follows the typing.
        onInput: (v) => {
          clearTimeout(timer);
          timer = window.setTimeout(
            () => void call("css.set", { rule: rule.id, name, value: v }),
            60,
          );
        },
        done: (v, how) => {
          clearTimeout(timer);
          const next = how === "escape" ? full : v;
          void call("css.set", { rule: rule.id, name, value: next }).then(() => ctx.refresh());
          if (how === "shift-tab") void ctx.refresh().then(() => startEdit(rule.id, name, "name"));
        },
      });
    };
    const editName = () =>
      editInPlace(store, nameEl, name, {
        done: (v, how) => {
          const next = v.trim();
          if (how === "escape" || next === name) {
            nameEl.textContent = name;
            if (how === "tab") editValue();
            return;
          }
          void call("css.rename", { rule: rule.id, from: name, to: next }).then(async () => {
            await ctx.refresh();
            if (how === "tab" && next) startEdit(rule.id, next, "value");
          });
        },
      });
    store.add(
      on(nameEl, "click", (e) => {
        e.stopPropagation();
        editName();
      }),
    );
    store.add(
      on(valueEl, "click", (e) => {
        e.stopPropagation();
        editValue();
      }),
    );
    return row;
  };

  /** A new declaration at the end of a rule: its name, then its value. */
  const addProp = (rule: StyleRule, body: HTMLElement) => {
    const nameEl = h("span", { class: "dt-prop-name" });
    const valueEl = h("span", { class: "dt-prop-value" });
    const row = h(
      "div",
      { class: "dt-prop is-new" },
      h("span", { class: "dt-prop-check-space" }),
      nameEl,
      h("span", { class: "dt-prop-sep" }, ": "),
      valueEl,
      ";",
    );
    body.append(row);
    editInPlace(store, nameEl, "", {
      done: (name, how) => {
        const n = name.trim();
        if (!n || how === "escape" || how === "blur") {
          row.remove();
          return;
        }
        // "color: red" typed in one go.
        const both = /^([\w-]+)\s*:\s*(.+?);?$/.exec(n);
        if (both?.[1] && both[2]) {
          void call("css.set", { rule: rule.id, name: both[1], value: both[2] }).then(() =>
            ctx.refresh(),
          );
          return;
        }
        nameEl.textContent = n;
        editInPlace(store, valueEl, "", {
          numbers: true,
          done: (value, how2) => {
            if (how2 === "escape" || !value.trim()) {
              row.remove();
              return;
            }
            void call("css.set", { rule: rule.id, name: n, value }).then(() => ctx.refresh());
          },
        });
      },
    });
  };

  const rulesEl = all.map((rule) => {
    const body = h("div", { class: "dt-rule-body" });
    rule.props.forEach((p, i) => {
      body.append(propRow(rule, p, i));
    });
    const anyShown = rule.props.some(([n, v]) => matches(n, v));
    const add = h(
      "button",
      {
        class: "icon-button dt-icon dt-rule-add",
        type: "button",
        "aria-label": "Add a declaration",
      },
      icon("plus"),
    );
    setTooltip(add, "Add a declaration");
    store.add(on(add, "click", () => addProp(rule, body)));
    // A click on the rule's empty end adds a declaration, as in Chrome.
    const end = h("div", { class: "dt-rule-end" }, rule.id === "inline" ? "}" : "}");
    store.add(on(end, "click", () => addProp(rule, body)));
    const source =
      rule.source && rule.id !== "inline"
        ? h(
            "button",
            { class: "dt-rule-source", type: "button" },
            rule.source.split("/").pop() ?? rule.source,
          )
        : null;
    if (source) {
      setTooltip(source, rule.source);
      store.add(
        on(
          source,
          "click",
          () => /^(https?|file):/.test(rule.source) && host.revealSource(rule.source),
        ),
      );
    }
    const el = h(
      "div",
      { class: "dt-rule", "data-rule": rule.id },
      h(
        "div",
        { class: "dt-rule-head" },
        h("span", { class: "dt-selector" }, rule.selector),
        h("span", { class: "dt-rule-open" }, " {"),
        source,
        add,
      ),
      body,
      end,
    );
    el.hidden = Boolean(filter) && !anyShown && rule.id !== "inline";
    return el;
  });

  /** Starts editing a declaration after a re-render (Tab from a renamed name). */
  const startEdit = (ruleId: string, name: string, what: "name" | "value") => {
    const row = document.querySelector<HTMLElement>(
      `.dt-rule[data-rule="${CSS.escape(ruleId)}"] .dt-prop[data-prop="${CSS.escape(name)}"]`,
    );
    row?.querySelector<HTMLElement>(what === "name" ? ".dt-prop-name" : ".dt-prop-value")?.click();
  };

  // The toolbar: filter and classes.
  const filterBox = h("input", {
    class: "input dt-filter",
    type: "search",
    placeholder: "Filter",
    spellcheck: "false",
    value: filter,
  });
  store.add(on(filterBox, "input", () => ctx.setFilter(filterBox.value.trim().toLowerCase())));
  const classes = ctx.className.split(/\s+/).filter(Boolean);
  const off = offClasses.get(id) ?? new Set<string>();
  offClasses.set(id, off);
  const clsPanel = h("div", { class: "dt-cls" });
  clsPanel.hidden = true;
  const clsButton = h(
    "button",
    { class: "dt-chip", type: "button", "aria-pressed": "false" },
    ".cls",
  );
  setTooltip(clsButton, "Element classes");
  store.add(
    on(clsButton, "click", () => {
      clsPanel.hidden = !clsPanel.hidden;
      clsButton.setAttribute("aria-pressed", String(!clsPanel.hidden));
    }),
  );
  const setClasses = (list: string[]) =>
    call("dom.setAttribute", { name: "class", value: list.join(" ") }).then(() => ctx.refresh());
  const addClass = h("input", {
    class: "input dt-filter",
    type: "text",
    placeholder: "Add new class",
    spellcheck: "false",
  });
  store.add(
    on(addClass, "keydown", (e) => {
      if (e.key !== "Enter") return;
      const more = addClass.value.trim().split(/\s+/).filter(Boolean);
      if (more.length) void setClasses([...new Set([...classes, ...more])]);
    }),
  );
  const chips = [...new Set([...classes, ...off])].map((c) => {
    const box = h("input", { type: "checkbox", class: "dt-prop-check" });
    box.checked = !off.has(c);
    store.add(
      on(box, "change", () => {
        if (box.checked) off.delete(c);
        else off.add(c);
        const all2 = [...new Set([...classes, ...off])];
        void setClasses(all2.filter((x) => !off.has(x)));
      }),
    );
    return h("label", { class: "dt-cls-chip" }, box, c);
  });
  clsPanel.append(addClass, h("div", { class: "dt-cls-list" }, ...chips));
  return h(
    "div",
    { class: "dt-styles" },
    h("div", { class: "dt-styles-bar" }, filterBox, clsButton),
    clsPanel,
    ...rulesEl,
  );
}
