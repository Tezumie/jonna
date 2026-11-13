// One row of the settings editor (DESIGN.md §12.16; D121 layout): title and description on the
// left, the control on the right, chosen by the schema type (a switch, a select, a number/text
// input, or "Edit in settings.json" for objects and arrays). Changes go through `settings.set` /
// `settings.reset` so they are ordinary commands. With a language (the search's `@lang:`, D201) the
// row shows and edits that language's value, the `"[language]": {…}` block of the scope. The
// "folder" scope (D251) shows and edits one folder's own settings in a multi-root workspace.
import { h, on } from "../../core/dom/index";
import { clipboardIpc } from "../../core/ipc/system";
import { startLayoutOf } from "../../core/layout/startLayout";
import { DisposableStore } from "../../core/lifecycle/index";
import { languageOverrideKey } from "../../core/settings/languageOverrides";
import type { SettingsScope } from "../../core/settings/model";
import { isValid, type SettingInfo } from "../../core/settings/schema";
import { icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { type EditScope, folderInherited, inspectFolder } from "./folderScope";
import { layoutChoice } from "./layoutChoice";

export interface SettingRow {
  readonly element: HTMLElement;
  /** Re-reads the value and modified state (not while the user is typing in its input). */
  update(): void;
  dispose(): void;
}

/** Wraps case-insensitive matches of `query` in <mark>. */
function highlight(text: string, query: string): (string | HTMLElement)[] {
  if (!query) return [text];
  const out: (string | HTMLElement)[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(query, i); at >= 0; at = lower.indexOf(query, i)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(h("mark", { class: "settings-match" }, text.slice(at, at + query.length)));
    i = at + query.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/** What a scope's file says for `key` (undefined: not set there); "folder" needs the folder. */
export function inspectScope(
  services: Pick<WorkbenchServices, "settings">,
  scope: EditScope,
  folder: string | null | undefined,
  key: string,
  language?: string,
): unknown {
  const { settings } = services;
  if (scope === "folder")
    return folder ? inspectFolder(settings, folder, key, language) : undefined;
  return language
    ? settings.model.inspectForLanguage(key, scope, language)
    : settings.model.inspect(key, scope);
}

export function settingRow(
  info: SettingInfo,
  scope: EditScope,
  query: string,
  services: WorkbenchServices,
  language?: string,
  /** The folder of the "folder" scope (its path). */
  folder?: string | null,
): SettingRow {
  const { settings, dispatcher } = services;
  const store = new DisposableStore();
  const inFolder = scope === "folder" && folder ? folder : null;
  const where = inFolder ? { scope, folder: inFolder } : { scope };
  const target = language ? { key: info.key, ...where, language } : { key: info.key, ...where };
  const exec = (command: string, input: Record<string, unknown>) =>
    void dispatcher.execute(command, input).catch(() => {});
  /** Set in this scope (in its block for the language). */
  const isModified = () =>
    inspectScope(services, scope, inFolder, info.key, language) !== undefined;
  const scopeLabel = scope === "folder" ? "folder" : scope;
  // Changing a setting back to what it would be anyway (the default, or for workspace settings
  // the user's value) removes it from settings.json, so it no longer shows as modified (D189).
  const inherited = (): unknown => {
    // A folder's: what its files would get without its own value (the workspace's, the user's…).
    if (scope === "folder")
      return inFolder ? folderInherited(settings, inFolder, info.key, language) : undefined;
    // A language's value: what its files would get without this scope's block.
    if (language) {
      if (scope === "workspace") {
        const user = settings.model.inspectForLanguage(info.key, "user", language);
        if (user !== undefined) return user;
        return settings.model.resolve(info.key).value;
      }
      return settings.model.inspect(info.key, "user") ?? settings.registry.get(info.key)?.default;
    }
    if (scope === "workspace") {
      if (settings.aliasFolderOf(info.key)) return Symbol("set by another folder");
      const user = settings.model.inspect(info.key, "user");
      if (user !== undefined) return user;
    }
    return settings.registry.get(info.key)?.default;
  };
  const write = (value: unknown) =>
    JSON.stringify(value) === JSON.stringify(inherited())
      ? exec("settings.reset", target)
      : exec("settings.set", { ...target, value });
  /** The value this scope shows: its own, else what it inherits. */
  const current = () => {
    if (scope === "folder") {
      const own = inspectScope(services, scope, inFolder, info.key, language);
      return own !== undefined ? own : inherited();
    }
    if (language) {
      const own = settings.model.inspectForLanguage(info.key, scope, language);
      return own !== undefined ? own : inherited();
    }
    return scope === "user"
      ? (settings.model.inspect(info.key, "user") ?? info.default)
      : settings.model.resolve(info.key).value;
  };

  const id = `setting-${info.key.replaceAll(".", "-")}`;
  const description = h(
    "div",
    { class: "setting-description" },
    ...highlight(info.description, query),
  );
  const note = h("div", { class: "setting-note" });
  let control: HTMLElement;
  let read: () => void;

  const picker = info.type === "string" ? settings.picker(info.key) : undefined;
  const choices = info.type === "string" ? settings.choices(info.key) : undefined;
  if (info.key === "workbench.defaultLayout") {
    // Cards with a drawing of each layout (D424), not a dropdown of three words.
    const choice = layoutChoice(store, id, info.title, info.enumDescriptions, (v) => void write(v));
    control = choice.element;
    read = () => {
      choice.show(current());
      const index = info.enum?.indexOf(startLayoutOf(current())) ?? -1;
      note.textContent = info.enumDescriptions?.[Math.max(0, index)] ?? "";
    };
  } else if (picker) {
    // A popup of its own (D288: models open the chat's model picker): a button with the value.
    const text = h("span", { class: "setting-picker-text" });
    const button = h(
      "button",
      {
        class: "input setting-select setting-picker",
        id,
        type: "button",
        "aria-haspopup": "dialog",
      },
      text,
      icon("chevron-down"),
    );
    store.add(
      on(button, "click", () =>
        picker.open(button, String(current() ?? ""), (value) => void write(value)),
      ),
    );
    control = button;
    read = () => {
      const shown = picker.label(String(current() ?? ""));
      text.textContent = shown.text;
      note.textContent = shown.detail ?? "";
    };
  } else if (choices) {
    // Values known at runtime (themes): a dropdown rebuilt on each read, keeping a value that
    // isn't available (any more) as its own entry.
    const select = h("select", { class: "input setting-select", id });
    store.add(on(select, "change", () => write(select.value)));
    control = select;
    // The options are rebuilt only when the list or the value changed (every setting change reads
    // each row, D275: rebuilding the theme lists each time was slow).
    let shownList = "";
    read = () => {
      const list = settings.choices(info.key) ?? [];
      const value = String(current() ?? "");
      const signature = JSON.stringify([value, list]);
      if (signature !== shownList) {
        shownList = signature;
        const options = list.map((c) => {
          const option = h("option", { value: c.value }, c.label);
          if (c.description) option.title = c.description;
          return option;
        });
        if (!list.some((c) => c.value === value))
          options.unshift(h("option", { value }, `${value} (not available)`));
        select.replaceChildren(...options);
      }
      select.value = value;
      note.textContent = list.find((c) => c.value === value)?.description ?? "";
    };
  } else if (info.type === "boolean") {
    const box = h("input", {
      type: "checkbox",
      class: "switch",
      id,
      role: "switch",
      "aria-label": info.title,
    }) as HTMLInputElement;
    store.add(on(box, "change", () => write(box.checked)));
    control = box;
    read = () => {
      box.checked = current() === true;
      box.setAttribute("aria-checked", String(box.checked));
    };
  } else if (info.enum) {
    const select = h("select", { class: "input setting-select", id });
    info.enum.forEach((value, i) => {
      const label = value === "\n" ? "LF" : value === "\r\n" ? "CRLF" : String(value);
      const option = h("option", { value: String(i) }, label);
      const detail = info.enumDescriptions?.[i];
      if (detail) option.title = detail;
      select.append(option);
    });
    store.add(on(select, "change", () => write(info.enum?.[Number(select.value)])));
    control = select;
    read = () => {
      const index = info.enum?.indexOf(current() as string | number) ?? -1;
      select.value = String(Math.max(0, index));
      note.textContent = info.enumDescriptions?.[Math.max(0, index)] ?? "";
    };
  } else if (info.type === "number" || info.type === "integer" || info.type === "string") {
    const numeric = info.type !== "string";
    const input = h("input", {
      class: "input setting-input",
      id,
      type: numeric ? "number" : "text",
      spellcheck: "false",
      ...(info.minimum !== undefined && { min: String(info.minimum) }),
      ...(info.maximum !== undefined && { max: String(info.maximum) }),
    });
    const commit = () => {
      const value = numeric ? Number(input.value) : input.value;
      const ok = input.value !== "" && isValid(info, value);
      input.classList.toggle("is-invalid", !ok);
      if (ok && value !== current()) write(value);
    };
    store.add(on(input, "change", commit));
    store.add(on(input, "keydown", (e) => e.key === "Enter" && commit()));
    control = input;
    read = () => {
      if (document.activeElement === input) return;
      input.value = String(current() ?? "");
      input.classList.remove("is-invalid");
    };
  } else {
    const link = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      "Edit in settings.json",
    );
    store.add(on(link, "click", () => exec("settings.openJson", where)));
    control = link;
    read = () => {};
  }

  const reset = h(
    "button",
    { class: "icon-button setting-reset", type: "button" },
    icon("rotate-ccw"),
  );
  setTooltip(
    reset,
    language
      ? `Remove from ${languageOverrideKey(language)} in ${scopeLabel} settings`
      : `Reset to ${scope === "folder" ? "the workspace, user or default value" : scope === "workspace" ? "the user or default value" : "default"}`,
  );
  store.add(on(reset, "click", () => exec("settings.reset", target)));

  // Changed from the default: a small dot after the title (quiet; no accent bar, D179).
  const changedDot = h("span", { class: "setting-modified-dot", "aria-hidden": "true" });
  setTooltip(
    changedDot,
    language
      ? `Changed for ${language} in ${scopeLabel} settings`
      : `Changed in ${scopeLabel} settings`,
  );
  const title = h(
    "label",
    { class: "setting-title", for: id },
    ...highlight(info.title, query),
    changedDot,
    reset,
  );
  const element = h(
    "div",
    { class: "setting-row", "data-key": info.key },
    h("div", { class: "setting-text" }, title, description, note),
    h("div", { class: "setting-control" }, control),
  );

  store.add(
    on(element, "contextmenu", (e) => {
      if ((e.target as Element).closest("input, textarea, select")) return;
      e.preventDefault();
      const modified = isModified();
      const value = language
        ? settings.peekForLanguageAt(info.key, language, inFolder)
        : settings.peekAt(info.key, inFolder);
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "Reset setting",
          disabled: !modified,
          run: () => exec("settings.reset", target),
        },
        {
          label: "Copy setting ID",
          separatorBefore: true,
          run: () => void clipboardIpc.writeText(info.key).catch(() => {}),
        },
        {
          label: "Copy setting as JSON",
          run: () =>
            void clipboardIpc
              .writeText(`"${info.key}": ${JSON.stringify(value ?? info.default, null, 2)}`)
              .catch(() => {}),
        },
        {
          label: "Open settings.json",
          separatorBefore: true,
          run: () => exec("settings.openJson", where),
        },
      ]);
    }),
  );

  const update = () => {
    read();
    const modified = isModified();
    element.classList.toggle("is-modified", modified);
    reset.hidden = !modified;
    // A folder's values are compared with the workspace's (the layer under them).
    const other: SettingsScope = scope === "workspace" ? "user" : "workspace";
    const elsewhere = inspectScope(services, other, null, info.key, language) !== undefined;
    // A multi-root workspace's folders that set it themselves (D251; theirs win for their files).
    const folders = scope === "folder" ? [] : foldersSetting(services, info.key, language);
    const also = [
      ...(elsewhere ? [`${other} settings`] : []),
      ...(folders.length ? [`${folders.join(", ")} (folder settings)`] : []),
    ];
    const alsoText = also.length ? `Also modified in ${also.join(" and ")}.` : "";
    if (!info.enum && !choices) note.textContent = alsoText;
    else if (alsoText) note.textContent += ` ${alsoText}`;
    // Another workspace folder's settings.json sets it (.vscode, the legacy folder name; nothing in the IDE's
    // own workspace settings wins, D189).
    if (scope !== "folder" && !language && settings.model.resolve(info.key).source === "vscode")
      note.textContent =
        `${note.textContent} Set by ${settings.aliasFolderOf(info.key) ?? ".vscode"}/settings.json.`.trim();
  };
  update();
  return { element, update, dispose: () => store.dispose() };
}

/** The names of a multi-root workspace's folders whose own settings set `key` (none with one folder). */
function foldersSetting(services: WorkbenchServices, key: string, language?: string): string[] {
  const { workspace, settings } = services;
  if (!workspace.isMultiRoot()) return [];
  return workspace.folders
    .peek()
    .filter((f) => inspectFolder(settings, f.path, key, language) !== undefined)
    .map((f) => f.name);
}
