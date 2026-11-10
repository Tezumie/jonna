// The "Language server settings" tab (D204, after VS Code's per-extension settings): pick a
// server; its known settings (a built-in list for the common servers) as controls, then its
// settings and initialization options as JSON (the user's overrides, merged over the server's
// own). Everything goes through the lsp.setServerSetting / lsp.setServerSettingsJson commands.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { ServerConfig } from "./servers";
import type { ServerSettingsInfo, ServerSettingValue } from "./settingsCommands";

export function serverSettingsViewDescriptor(
  services: WorkbenchServices,
  info: (server: string) => ServerSettingsInfo,
  configs: () => ServerConfig[],
): DockViewDescriptor {
  return {
    type: "lspServerSettings",
    title: () => "Language server settings",
    icon: () => "server",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) => new ServerSettingsView(services, info, configs, stateField(state, "server")),
  };
}

const pretty = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v, null, 2));

class ServerSettingsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows = this.store.add(new DisposableStore());
  private readonly picker: HTMLSelectElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly settingsJson: HTMLTextAreaElement;
  private readonly initJson: HTMLTextAreaElement;
  private readonly jsonNote: HTMLElement;
  private server: string;
  /** The JSON shown last: text the user is editing isn't replaced on refresh. */
  private shownJson = { settings: "", init: "" };

  constructor(
    private readonly services: WorkbenchServices,
    private readonly info: (server: string) => ServerSettingsInfo,
    private readonly configs: () => ServerConfig[],
    initial: unknown,
  ) {
    this.server = typeof initial === "string" ? initial : (configs()[0]?.name ?? "");
    this.picker = h("select", {
      class: "input setting-select",
      "aria-label": "Language server",
    }) as HTMLSelectElement;
    this.store.add(
      on(this.picker, "change", () => {
        this.server = this.picker.value;
        this.shownJson = { settings: "", init: "" };
        this.render(true);
      }),
    );
    this.status = h("span", { class: "setting-note" });
    this.list = h("div", { class: "settings-card" });
    this.settingsJson = this.jsonArea("Settings (workspace/configuration sections)");
    this.initJson = this.jsonArea("Initialization options");
    this.jsonNote = h("div", { class: "setting-note lsp-settings-json-note" });
    const save = h(
      "button",
      { class: "button button-accent button-sm", type: "button" },
      "Save JSON",
    );
    this.store.add(on(save, "click", () => void this.saveJson()));
    const log = h("button", { class: "icon-button", type: "button" }, icon("file-text"));
    setTooltip(log, "Show the server's log", "lsp.showLog");
    this.store.add(on(log, "click", () => this.run("lsp.showLog", { server: this.server })));
    this.element = h(
      "div",
      { class: "settings-view lsp-settings-view", tabindex: "-1" },
      h(
        "div",
        { class: "settings-scroll" },
        h(
          "div",
          { class: "settings-page-head" },
          h("h2", { class: "settings-page-title" }, "Language server settings"),
          h("div", { class: "settings-page-tools" }, this.picker, log),
        ),
        h(
          "div",
          { class: "settings-list" },
          this.status,
          h(
            "section",
            { class: "settings-section" },
            h("h3", { class: "settings-section-title" }, h("span", null, "Settings")),
            this.list,
          ),
          h(
            "section",
            { class: "settings-section lsp-settings-json" },
            h("h3", { class: "settings-section-title" }, h("span", null, "JSON")),
            h(
              "div",
              { class: "settings-card lsp-settings-json-card" },
              h(
                "p",
                { class: "setting-description" },
                "Your overrides in lsp.servers, merged over the server's own. Settings are sent to the running server; a change to initialization options restarts it.",
              ),
              this.settingsJson,
              this.initJson,
              h("div", { class: "lsp-settings-json-actions" }, this.jsonNote, save),
            ),
          ),
        ),
      ),
    );
    this.store.add(
      effect(() => {
        services.settings.version.value;
        this.render(false);
        return undefined;
      }),
    );
  }

  private jsonArea(label: string): HTMLTextAreaElement {
    return h("textarea", {
      class: "input lsp-settings-textarea",
      spellcheck: "false",
      "aria-label": label,
      placeholder: `${label}: {}`,
    }) as HTMLTextAreaElement;
  }

  private render(resetJson: boolean): void {
    const configs = this.configs();
    if (!configs.some((c) => c.name === this.server)) this.server = configs[0]?.name ?? "";
    this.picker.replaceChildren(
      ...configs.map((c) => h("option", { value: c.name }, c.title ?? c.name)),
    );
    this.picker.value = this.server;
    this.rows.clear();
    if (!this.server) {
      this.status.textContent = "No language servers are set up.";
      this.list.replaceChildren();
      return;
    }
    let data: ServerSettingsInfo;
    try {
      data = this.info(this.server);
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    this.status.textContent = data.running
      ? `${data.title} is running.`
      : `${data.title} isn't running: changes apply when it starts.`;
    this.list.replaceChildren(
      ...(data.fields.length
        ? data.fields.map((f) => this.row(f))
        : [
            h(
              "div",
              { class: "setting-row" },
              h(
                "div",
                { class: "setting-text" },
                h(
                  "div",
                  { class: "setting-description" },
                  "No known settings for this server: use the JSON below (see its documentation).",
                ),
              ),
            ),
          ]),
    );
    const settingsText = pretty(data.settings);
    const initText = pretty(data.initializationOptions);
    // Keep what the user is typing unless it's what we showed (or a new server was picked).
    if (resetJson || this.settingsJson.value === this.shownJson.settings)
      this.settingsJson.value = settingsText;
    if (resetJson || this.initJson.value === this.shownJson.init) this.initJson.value = initText;
    this.shownJson = { settings: settingsText, init: initText };
  }

  private row(f: ServerSettingValue): HTMLElement {
    const id = `lsp-setting-${f.key.replace(/[^\w-]/g, "-")}`;
    const set = (value: unknown) =>
      this.run("lsp.setServerSetting", {
        server: this.server,
        key: f.key,
        target: f.target,
        ...(value !== undefined && { value }),
      });
    let control: HTMLElement;
    if (f.type === "boolean") {
      const box = h("input", {
        type: "checkbox",
        class: "switch",
        id,
        role: "switch",
      }) as HTMLInputElement;
      box.checked = f.value === true;
      this.rows.add(on(box, "change", () => set(box.checked)));
      control = box;
    } else if (f.type === "enum") {
      const select = h("select", { class: "input setting-select", id }) as HTMLSelectElement;
      for (const v of f.enum ?? []) select.append(h("option", { value: v }, v));
      select.value = String(f.value ?? "");
      this.rows.add(on(select, "change", () => set(select.value)));
      control = select;
    } else {
      const json = f.type === "string[]" || f.type === "json";
      const input = h("input", {
        class: "input setting-input",
        id,
        type: f.type === "number" ? "number" : "text",
        spellcheck: "false",
      }) as HTMLInputElement;
      input.value = json ? JSON.stringify(f.value ?? null) : String(f.value ?? "");
      const commit = () => {
        let value: unknown = input.value;
        if (f.type === "number") value = Number(input.value);
        if (json) {
          try {
            value = JSON.parse(input.value || "null");
          } catch {
            input.classList.add("is-invalid");
            return;
          }
          if (
            f.type === "string[]" &&
            !(Array.isArray(value) && value.every((x) => typeof x === "string"))
          ) {
            input.classList.add("is-invalid");
            return;
          }
        }
        if (f.type === "number" && !Number.isFinite(value)) {
          input.classList.add("is-invalid");
          return;
        }
        input.classList.remove("is-invalid");
        set(value);
      };
      this.rows.add(on(input, "change", commit));
      this.rows.add(on(input, "keydown", (e) => e.key === "Enter" && commit()));
      control = input;
    }
    const reset = h(
      "button",
      { class: "icon-button setting-reset", type: "button" },
      icon("rotate-ccw"),
    );
    reset.hidden = !f.modified;
    setTooltip(reset, "Back to the server's own value");
    this.rows.add(on(reset, "click", () => set(undefined)));
    const where =
      f.target === "initializationOptions" ? " (initialization option: restarts the server)" : "";
    return h(
      "div",
      { class: `setting-row${f.modified ? " is-modified" : ""}`, "data-key": f.key },
      h(
        "div",
        { class: "setting-text" },
        h(
          "label",
          { class: "setting-title", for: id },
          f.key,
          h("span", { class: "setting-modified-dot", "aria-hidden": "true" }),
          reset,
        ),
        h("div", { class: "setting-description" }, `${f.description}${where}`),
      ),
      h("div", { class: "setting-control" }, control),
    );
  }

  private async saveJson(): Promise<void> {
    const parse = (text: string, label: string): { ok: true; value: unknown } | { ok: false } => {
      if (!text.trim()) return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (err) {
        this.jsonNote.textContent = `${label}: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false };
      }
    };
    const settings = parse(this.settingsJson.value, "Settings");
    if (!settings.ok) return;
    const init = parse(this.initJson.value, "Initialization options");
    if (!init.ok) return;
    try {
      await this.services.dispatcher.execute("lsp.setServerSettingsJson", {
        server: this.server,
        settings: settings.value,
        initializationOptions: init.value,
      });
      this.jsonNote.textContent = "Saved.";
      this.shownJson = { settings: "", init: "" };
      this.render(true);
    } catch (err) {
      this.jsonNote.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  private run(command: string, input: unknown): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  focus(): void {
    this.picker.focus();
  }

  serialize(): Json {
    return this.server ? { server: this.server } : null;
  }

  dispose(): void {
    this.store.dispose();
  }
}
