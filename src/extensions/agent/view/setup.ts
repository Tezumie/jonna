// AI setup UI (D164): the "AI models" page. An empty chat without a model offers one button to it
// (`setupPrompt`, D166).
// - Connected providers, each with its status, model count, Change key and Remove.
// - Provider tiles (Anthropic, OpenAI, Gemini, xAI, OpenRouter…) that open an inline key form;
//   Connect checks the key by listing the models before anything is saved. "View more" shows the
//   rest of the presets; "Other server" suggests a preset as its name is typed, and takes an
//   optional image of its own (D212).
// - Ollama: found, running, has models, or how to get there (download, start, pull a model).
// - Agent CLIs a person may already pay for (Claude Code, Codex, Gemini CLI, GitHub Copilot), the
//   agents installed from the ACP registry, and the registry's gallery (agentGallery.ts, D215).
// Everything runs through commands (agent.connectProvider, agent.removeProvider…).

import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";
import { ACP_PRESETS } from "../acpAgents";
import { type AcpRegistryState, installedAgents } from "../acpRegistry";
import {
  AGENT_SETUP,
  brandPresetFor,
  PROVIDER_PRESETS,
  type ProviderPreset,
  presetFor,
  STARTER_OLLAMA_MODEL,
  SUGGESTED_REGISTRY_AGENTS,
} from "../catalog";
import { matchPresets } from "../providerMatch";
import { OLLAMA_ID, type ProviderRegistry, type ProviderStatus } from "../providers";
import { providerImage, type SetupState } from "../setupCommands";
import { AgentGallery, agentIcon } from "./agentGallery";
import { brandMark as mark } from "./brandMark";
import { pickRowAction } from "./pageKit";

export interface SetupDeps {
  services: WorkbenchServices;
  providers: ProviderRegistry;
  setup: SetupState;
  /** The ACP agent registry's list and installs (D215). */
  registry: AcpRegistryState;
  /** The chat an agent choice ("Use") applies to; none on the page (the active one then). */
  session?: () => string | undefined;
}

/** The open form: a preset's key, a connected provider's new key, or a custom server. */
type Form =
  | { kind: "preset"; preset: ProviderPreset }
  | { kind: "rekey"; status: ProviderStatus }
  | { kind: "custom" };

export class SetupPanel implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private form: Form | null = null;
  private draft = { key: "", name: "", url: "", image: "" };
  /** "View more": the presets that aren't featured are shown too (D212). */
  private showMore = false;
  /** "View more agents": the ACP registry's gallery (its search and cards) is shown (D216). */
  private showAgents = false;
  /** The highlighted suggestion under the custom form's name box (-1: none). */
  private suggestIndex = -1;
  private busy = false;
  private error: string | null = null;
  /** "Connected OpenRouter · 312 models": shown once, after a connect. */
  private notice: string | null = null;
  private focusInput = false;
  /** Kept across renders (its search box and cards update themselves). */
  private readonly gallery: AgentGallery;

  constructor(private readonly deps: SetupDeps) {
    this.element = h("div", { class: "ai-setup" });
    const { providers, services, setup } = deps;
    this.gallery = this.store.add(
      new AgentGallery({
        services,
        registry: deps.registry,
        presetFound: (name) => {
          const program = AGENT_SETUP[name]?.program;
          return program ? setup.installed.value?.get(program) : undefined;
        },
        ...(deps.session && { session: deps.session }),
      }),
    );
    // agent.registry.browse asks for the gallery's search box: open the gallery first.
    this.store.add(
      effect(() => {
        if (deps.registry.focusSearch.value && !this.showAgents) {
          this.showAgents = true;
          this.gallery.open();
          queueMicrotask(() => this.render());
        }
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        providers.statuses.value;
        providers.models.value;
        services.settings.version.value;
        setup.installed.value;
        setup.images.value;
        deps.registry.installedVersion.value;
        this.render();
        return undefined;
      }),
    );
    // Looked for every time the page opens, and when the window gets the focus back (an agent
    // installed in a terminal, or outside the IDE, shows as installed without a restart, D192).
    void this.run("agent.detectTools");
    this.store.add(
      on(window, "focus", () => {
        if (this.element.isConnected) void this.run("agent.detectTools");
      }),
    );
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return this.deps.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.deps.services.notifications.show(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });
  }

  private render(): void {
    // A refresh (models listed, settings changed) mustn't take the field being typed in away.
    const active = this.element.ownerDocument.activeElement;
    const typing =
      active instanceof HTMLInputElement && this.element.contains(active)
        ? active.getAttribute("aria-label")
        : null;
    if (typing) this.focusInput = false;
    const sections = [
      this.header(),
      this.connected(),
      this.addSection(),
      this.localSection(),
      this.agents(),
    ];
    this.element.replaceChildren(...sections.filter((x): x is HTMLElement => !!x));
    if (typing) {
      const again = [...this.element.querySelectorAll<HTMLInputElement>("input")].find(
        (i) => i.getAttribute("aria-label") === typing,
      );
      again?.focus();
    } else if (this.focusInput) {
      this.focusInput = false;
      const input = this.element.querySelector<HTMLInputElement>(".ai-form input");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // ---- Page parts ------------------------------------------------------------------------------

  private header(): HTMLElement {
    const choice = this.deps.providers.defaultModel();
    const pill = h(
      "button",
      { class: "ai-default", type: "button" },
      h("span", { class: "ai-default-label" }, "Default model"),
      h("span", { class: "ai-default-value" }, choice ? choice.model : "None yet"),
      icon("chevron-down"),
    );
    setTooltip(pill, "The model new chats use");
    on(pill, "click", () => void this.run("agent.selectModel"));
    if (!choice) pill.setAttribute("disabled", "");
    return h(
      "header",
      { class: "ai-header" },
      h("div", null, h("h1", { class: "ai-title" }, "AI models")),
      h(
        "div",
        { class: "ai-header-actions" },
        pill,
        // Providers by hand (D169): agent.providers in the user settings.json; keys stay here.
        this.button(
          "Edit in settings.json",
          "file-json",
          () => this.run("settings.openJson", { scope: "user" }),
          "ai-header-button",
        ),
      ),
    );
  }

  private connected(): HTMLElement | null {
    const list = this.deps.providers.statuses.value.filter((st) => st.id !== OLLAMA_ID);
    if (!list.length) return null;
    return this.section(
      "Connected",
      null,
      h(
        "div",
        { class: "ai-list" },
        ...list.map((st) => {
          const row = this.providerRow(st);
          return this.form?.kind === "rekey" && this.form.status.id === st.id
            ? h("div", { class: "ai-list-item is-open" }, row, this.formElement())
            : row;
        }),
      ),
    );
  }

  private providerRow(st: ProviderStatus): HTMLElement {
    const preset = presetFor(st);
    // The logo: the user's own image, else the preset it is by id, address, host or name (D212).
    const image = providerImage(this.deps.services, st.id);
    const brand = brandPresetFor(st);
    const hosted = preset?.needsKey ?? !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(st.baseUrl);
    const detail =
      st.state === "ok"
        ? `${st.models} model${st.models === 1 ? "" : "s"}`
        : st.state === "loading"
          ? "Checking…"
          : (st.error?.split("\n")[0]?.slice(0, 90) ?? "Not answering");
    const rekey = hosted
      ? this.textButton("Change key", () => this.open({ kind: "rekey", status: st }))
      : null;
    const remove = this.textButton(
      "Remove",
      () => void this.run("agent.removeProvider", { id: st.id }),
    );
    remove.classList.add("is-danger");
    // A server of the user's own (no known logo) can show an image they pick.
    const picture =
      image || !brand
        ? this.textButton(
            image ? "Remove image" : "Set image",
            () =>
              void this.run(
                "agent.setProviderImage",
                image ? { id: st.id, clear: true } : { id: st.id },
              ).then((r) => this.showResult(r)),
          )
        : null;
    return h(
      "div",
      { class: "ai-row", "data-provider": st.id, "data-brand-preset": brand?.id ?? "" },
      mark(brand?.mark ?? st.name.slice(0, 2), brand?.brand ?? "custom", st.state, image),
      h(
        "div",
        { class: "ai-row-main" },
        h("span", { class: "ai-row-name" }, st.name),
        h("span", { class: "ai-row-detail" }, detail),
      ),
      h("div", { class: "ai-row-actions" }, picture, rekey, remove),
    );
  }

  // ---- Providers -------------------------------------------------------------------------------

  private addSection(): HTMLElement {
    const configured = new Set(
      this.deps.providers.providers().flatMap((p) => [p.id, presetFor(p)?.id ?? p.id]),
    );
    const free = [...PROVIDER_PRESETS, ...contributedPresets(this.deps.services)].filter(
      (p) => !configured.has(p.id),
    );
    // Built-in presets first (the featured ones, then View more's), extensions' after them.
    const featured = free.filter((p) => p.featured || !PROVIDER_PRESETS.includes(p));
    const more = free.filter((p) => !featured.includes(p));
    const formOpen = this.form && this.form.kind !== "rekey";
    const other = this.tileButton(
      "Other server",
      "OpenAI-compatible address",
      h("span", { class: "ai-mark", "data-brand": "custom" }, icon("plus")),
      () => (this.form?.kind === "custom" ? this.close() : this.open({ kind: "custom" })),
    );
    other.dataset.preset = "custom";
    other.classList.toggle("is-selected", this.form?.kind === "custom");
    const tiles = h(
      "div",
      { class: "ai-tiles" },
      ...featured.map((p) => this.tile(p)),
      ...(this.showMore ? more.map((p) => this.tile(p)) : []),
      other,
    );
    const toggle = more.length
      ? this.textButton(
          this.showMore ? "View fewer" : `View more (${more.length})`,
          () => {
            this.showMore = !this.showMore;
            this.render();
          },
          "chevron-down",
        )
      : null;
    toggle?.classList.add("ai-more");
    toggle?.setAttribute("aria-expanded", String(this.showMore));
    return this.section(
      "Add a provider",
      null,
      this.notice ? h("div", { class: "ai-notice" }, icon("circle-check"), this.notice) : null,
      tiles,
      toggle,
      formOpen ? this.formElement() : null,
    );
  }

  /** A result to tell the user about: an error from a command that returns { ok: false }. */
  private showResult(result: unknown): void {
    const r = result as { ok?: boolean; error?: string } | null;
    if (r && r.ok === false && r.error) this.deps.services.notifications.show("error", r.error);
  }

  private tile(p: ProviderPreset): HTMLElement {
    const selected = this.form?.kind === "preset" && this.form.preset.id === p.id;
    const el = this.tileButton(p.name, p.blurb ?? "", mark(p.mark, p.brand), () =>
      selected ? this.close() : this.open({ kind: "preset", preset: p }),
    );
    el.dataset.brand = p.brand;
    el.dataset.preset = p.id;
    el.classList.toggle("is-selected", selected);
    return el;
  }

  private tileButton(
    name: string,
    blurb: string,
    badge: HTMLElement,
    click: () => void,
  ): HTMLElement {
    const el = h(
      "button",
      { class: "ai-tile", type: "button" },
      badge,
      h(
        "span",
        { class: "ai-tile-text" },
        h("span", { class: "ai-tile-name" }, name),
        blurb ? h("span", { class: "ai-tile-blurb" }, blurb) : null,
      ),
    );
    on(el, "click", click);
    return el;
  }

  private open(form: Form, keep: Partial<typeof this.draft> = {}): void {
    this.form = form;
    this.error = null;
    this.notice = null;
    this.suggestIndex = -1;
    this.draft = {
      key: "",
      name: "",
      url:
        form.kind === "preset" && (!form.preset.needsKey || form.preset.editAddress)
          ? form.preset.baseUrl
          : "",
      image: "",
      ...keep,
    };
    // A preset under View more opened from a suggestion: its tile is shown, selected.
    if (form.kind === "preset" && !form.preset.featured) this.showMore = true;
    this.focusInput = true;
    this.render();
  }

  /** A suggestion picked in the custom form: that preset's form, with the key typed so far. */
  private pickSuggestion(preset: ProviderPreset): void {
    this.open({ kind: "preset", preset }, { key: this.draft.key });
  }

  private close(): void {
    this.form = null;
    this.error = null;
    this.render();
  }

  private formElement(): HTMLElement {
    const form = this.form;
    if (!form) return h("div");
    const preset =
      form.kind === "preset"
        ? form.preset
        : form.kind === "rekey"
          ? presetFor(form.status)
          : undefined;
    const name = form.kind === "rekey" ? form.status.name : (preset?.name ?? "Other server");
    const needsKey = form.kind === "rekey" || (form.kind === "preset" && form.preset.needsKey);
    const field = (
      key: "key" | "name" | "url",
      label: string,
      attrs: Record<string, string>,
      extra?: (input: HTMLInputElement) => HTMLElement | null,
    ): HTMLElement => {
      const input = h("input", {
        class: "input",
        spellcheck: "false",
        autocomplete: "off",
        "aria-label": label,
        ...attrs,
      }) as HTMLInputElement;
      input.value = this.draft[key];
      on(input, "input", () => {
        this.draft[key] = input.value;
      });
      const after = extra?.(input) ?? null;
      on(input, "keydown", (e) => {
        if (e.defaultPrevented) return;
        if (e.key === "Enter") void this.connect();
        else if (e.key === "Escape") this.close();
      });
      return h(
        "label",
        { class: "ai-field" },
        h("span", { class: "ai-field-label" }, label),
        input,
        after,
      );
    };
    const fields: HTMLElement[] = [];
    if (form.kind === "custom") {
      fields.push(
        field("name", "Name", { placeholder: "My server" }, (input) => this.suggestions(input)),
      );
      fields.push(
        field("url", "Address", { placeholder: "http://127.0.0.1:1234/v1", type: "url" }),
      );
      fields.push(field("key", "API key (if it needs one)", { type: "password" }));
      fields.push(this.imageField());
    } else if (!needsKey) {
      fields.push(field("url", "Address", { type: "url" }));
    } else {
      if (form.kind === "preset" && form.preset.editAddress)
        fields.push(
          field("url", `${name} address`, {
            type: "url",
            placeholder: form.preset.addressPlaceholder ?? "https://…",
          }),
        );
      fields.push(
        field("key", form.kind === "rekey" ? `New ${name} API key` : `${name} API key`, {
          type: "password",
          placeholder: preset?.keyPlaceholder ?? "Paste the key",
        }),
      );
    }
    const connect = h(
      "button",
      { class: "button button-primary button-sm", type: "button" },
      this.busy ? "Checking…" : form.kind === "rekey" ? "Save key" : "Connect",
    );
    if (this.busy) connect.setAttribute("disabled", "");
    on(connect, "click", () => void this.connect());
    const cancel = this.textButton("Cancel", () => this.close());
    const getKey = preset?.keyHint
      ? this.textButton(
          "Get a key",
          () => void this.run("agent.openLink", { url: `https://${preset.keyHint}` }),
          "external-link",
        )
      : null;
    return h(
      "div",
      { class: "ai-form", "data-form": form.kind === "custom" ? "custom" : (preset?.id ?? "") },
      ...fields,
      this.error ? h("div", { class: "ai-error", role: "alert" }, this.error) : null,
      h(
        "div",
        { class: "ai-form-actions" },
        connect,
        cancel,
        h("span", { class: "ai-grow" }),
        getKey,
      ),
    );
  }

  /**
   * The presets the custom form's name could mean (D212), as a list under the box: typing
   * "groqai" offers Groq; picking one turns the form into that preset's (its address, key link and
   * logo). Arrow keys move through it, Enter picks, Escape hides it; a name that matches nothing
   * stays a custom server. Updated in place as the user types (no re-render, the caret stays).
   */
  private suggestions(input: HTMLInputElement): HTMLElement {
    const list = h("div", {
      class: "ai-suggest",
      role: "listbox",
      "aria-label": "Known providers",
    });
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    let matches: ProviderPreset[] = [];
    let dismissed = false;
    const paint = () => {
      const configured = new Set(
        this.deps.providers.providers().flatMap((p) => [p.id, presetFor(p)?.id ?? p.id]),
      );
      matches = dismissed
        ? []
        : matchPresets(input.value)
            .map((m) => m.preset)
            .filter((p) => !configured.has(p.id));
      if (this.suggestIndex >= matches.length) this.suggestIndex = matches.length - 1;
      list.hidden = matches.length === 0;
      input.setAttribute("aria-expanded", String(matches.length > 0));
      list.replaceChildren(
        ...matches.map((p, i) => {
          let host = "";
          try {
            host = p.baseUrl ? new URL(p.baseUrl).host : (p.addressPlaceholder ?? "");
          } catch {
            // A preset's address is always a URL; keep it blank otherwise.
          }
          const item = h(
            "button",
            {
              class: { "ai-suggest-item": true, "is-active": i === this.suggestIndex },
              type: "button",
              role: "option",
              tabindex: "-1",
              "aria-selected": String(i === this.suggestIndex),
              "data-preset": p.id,
            },
            mark(p.mark, p.brand),
            h("span", { class: "ai-suggest-name" }, p.name),
            h("span", { class: "ai-suggest-host" }, host),
          );
          // Keeps the focus in the box (no blur before the click lands).
          on(item, "mousedown", (e) => e.preventDefault());
          on(item, "click", () => this.pickSuggestion(p));
          return item;
        }),
      );
    };
    on(input, "input", () => {
      dismissed = false;
      this.suggestIndex = -1;
      paint();
    });
    on(input, "blur", () => {
      list.hidden = true;
    });
    on(input, "focus", () => paint());
    on(input, "keydown", (e) => {
      if (list.hidden || !matches.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        this.suggestIndex = (this.suggestIndex + step + matches.length + 1) % (matches.length + 1);
        if (this.suggestIndex === matches.length) this.suggestIndex = -1;
        paint();
      } else if (e.key === "Enter" && this.suggestIndex >= 0) {
        e.preventDefault();
        const p = matches[this.suggestIndex];
        if (p) this.pickSuggestion(p);
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismissed = true;
        paint();
      }
    });
    paint();
    return list;
  }

  /** The custom form's optional image: a preview badge, Choose image… and Remove. */
  private imageField(): HTMLElement {
    const letters = (this.draft.name.match(/[A-Za-z0-9]/g) ?? ["?"]).slice(0, 2).join("");
    const choose = this.textButton(this.draft.image ? "Change image…" : "Choose image…", () => {
      void this.run("agent.chooseProviderImage").then((r) => {
        const result = r as { ok?: boolean; dataUrl?: string; error?: string } | null;
        if (result?.ok && result.dataUrl) {
          this.draft.image = result.dataUrl;
          this.error = null;
        } else if (result?.error) this.error = result.error;
        this.render();
      });
    });
    const remove = this.draft.image
      ? this.textButton("Remove", () => {
          this.draft.image = "";
          this.render();
        })
      : null;
    return h(
      "div",
      { class: "ai-field ai-image-field" },
      h("span", { class: "ai-field-label" }, "Image (optional)"),
      h(
        "div",
        { class: "ai-image-row" },
        mark(letters, "custom", undefined, this.draft.image || undefined),
        h(
          "span",
          { class: "ai-image-hint" },
          this.draft.image ? "Shown as its logo" : "PNG, SVG, JPEG or WebP, up to 256 KB",
        ),
        choose,
        remove,
      ),
    );
  }

  private async connect(): Promise<void> {
    const form = this.form;
    if (!form || this.busy) return;
    this.busy = true;
    this.error = null;
    this.render();
    const input =
      form.kind === "custom"
        ? {
            name: this.draft.name,
            baseUrl: this.draft.url,
            apiKey: this.draft.key || undefined,
            ...(this.draft.image && { image: this.draft.image }),
          }
        : form.kind === "rekey"
          ? {
              id: form.status.id,
              name: form.status.name,
              baseUrl: form.status.baseUrl,
              apiKey: this.draft.key,
            }
          : {
              id: form.preset.id,
              ...(form.preset.needsKey && { apiKey: this.draft.key }),
              ...((!form.preset.needsKey || form.preset.editAddress) && {
                baseUrl: this.draft.url || form.preset.baseUrl,
              }),
            };
    const result = (await this.run("agent.connectProvider", input)) as {
      ok: boolean;
      error?: string;
      models?: number;
    } | null;
    this.busy = false;
    if (result?.ok) {
      const name =
        form.kind === "custom"
          ? this.draft.name || "Server"
          : form.kind === "rekey"
            ? form.status.name
            : form.preset.name;
      this.notice = `Connected ${name} · ${result.models ?? 0} models`;
      this.form = null;
      this.draft = { key: "", name: "", url: "", image: "" };
    } else {
      this.error = result?.error ?? "It didn't answer.";
      this.focusInput = true;
    }
    this.render();
  }

  // ---- Local models ------------------------------------------------------------------------------

  private localSection(): HTMLElement {
    const status = this.deps.providers.statuses.value.find((st) => st.id === OLLAMA_ID);
    const installed = this.deps.setup.installed.value?.get("ollama");
    let state: ProviderStatus["state"] | "off" = status?.state ?? "off";
    let detail: string;
    const actions: (HTMLElement | null)[] = [];
    const check = this.textButton("Check again", () => {
      void this.run("agent.detectTools");
      void this.run("agent.refreshModels");
    });
    if (!status) {
      detail = "Turned off.";
      actions.push(
        this.button("Turn on", "play", () =>
          this.run("settings.set", { key: "agent.ollama.enabled", value: true }),
        ),
      );
    } else if (status.state === "loading") {
      detail = "Looking for Ollama…";
    } else if (status.state === "ok" && status.models > 0) {
      detail = `Running · ${status.models} model${status.models === 1 ? "" : "s"}`;
      actions.push(check);
    } else if (status.state === "ok") {
      detail = "Running, but no models yet.";
      actions.push(
        this.button(`Download ${STARTER_OLLAMA_MODEL}`, "download", () =>
          this.run("agent.pullStarterModel"),
        ),
        check,
      );
      state = "error";
    } else if (installed) {
      detail = "Installed, not running.";
      actions.push(
        this.button("Start Ollama", "play", () =>
          this.run("terminal.runCommand", { command: "ollama serve", timeoutMs: 1000 }),
        ),
        check,
      );
    } else {
      detail = "Free, private, runs on your machine. Needs about 8 GB of memory.";
      actions.push(
        this.button("Get Ollama", "external-link", () =>
          this.run("agent.openLink", { url: "https://ollama.com/download" }),
        ),
        check,
      );
      state = "off";
    }
    return this.section(
      "Run models locally",
      null,
      h(
        "div",
        { class: "ai-row ai-local" },
        mark("O", "ollama", state),
        h(
          "div",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, "Ollama"),
          h("span", { class: "ai-row-detail" }, detail),
        ),
        h("div", { class: "ai-row-actions" }, ...actions),
      ),
    );
  }

  // ---- Agents ------------------------------------------------------------------------------------

  private agents(): HTMLElement {
    const installed = this.deps.setup.installed.value;
    const rows = ACP_PRESETS.map((preset) => {
      const info = AGENT_SETUP[preset.name];
      const has = info ? installed?.get(info.program) : undefined;
      const action =
        has === true
          ? this.button("Use", "agent", () =>
              this.run("agent.selectModel", {
                model: `acp/${preset.name}`,
                ...(this.deps.session?.() && { session: this.deps.session() }),
              }),
            )
          : has === false
            ? this.button("Install", "download", () =>
                this.run("agent.installAgent", { name: preset.name }),
              )
            : null;
      if (action && has === false && info) setTooltip(action, `Runs ${info.install} in a terminal`);
      // Its own sign-in and sign-out, in a terminal (D401): an expired login is fixed here.
      const more =
        has === true && info
          ? h(
              "button",
              { class: "icon-button", type: "button", "aria-label": `More for ${preset.name}` },
              icon("ellipsis"),
            )
          : null;
      if (more && info) {
        setTooltip(more, "Sign in or out");
        on(more, "click", () =>
          pickRowAction(this.deps.services, preset.name, [
            {
              id: "in",
              label: "Sign in",
              run: () => this.run("agent.signInAgent", { name: preset.name }),
            },
            ...(info.signOut
              ? [
                  {
                    id: "out",
                    label: "Sign out",
                    run: () => this.run("agent.signOutAgent", { name: preset.name }),
                  },
                ]
              : []),
          ]),
        );
      }
      return h(
        "div",
        { class: "ai-row", "data-agent": preset.name },
        mark(info?.mark ?? preset.name.slice(0, 2), info?.brand ?? "custom", has ? "ok" : "off"),
        h(
          "div",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, preset.name),
          h(
            "span",
            { class: "ai-row-detail" },
            has === true ? `Installed · ${info?.blurb ?? ""}` : (info?.blurb ?? ""),
          ),
        ),
        h("div", { class: "ai-row-actions" }, action, more),
      );
    });
    // Suggested registry agents not installed yet (D401: OpenCode V2): Install downloads it.
    const installedNow = installedAgents(this.deps.services);
    for (const suggested of SUGGESTED_REGISTRY_AGENTS) {
      if (installedNow[suggested.id]) continue;
      const info = this.deps.registry.find(suggested.id);
      const install = this.button("Install", "download", () =>
        this.run("agent.registry.install", { id: suggested.id, from: "download" }),
      );
      setTooltip(install, "Downloads it from the ACP registry (asks first)");
      rows.push(
        h(
          "div",
          { class: "ai-row", "data-agent": suggested.name, "data-registry-id": suggested.id },
          agentIcon(info ?? { name: suggested.name }),
          h(
            "div",
            { class: "ai-row-main" },
            h("span", { class: "ai-row-name" }, suggested.name),
            h("span", { class: "ai-row-detail" }, suggested.blurb),
          ),
          h("div", { class: "ai-row-actions" }, install),
        ),
      );
    }
    // Installed from the ACP registry (D215): Use and Remove, like the presets' rows.
    for (const a of Object.values(installedNow)) {
      const info = this.deps.registry.find(a.id);
      const suggested = SUGGESTED_REGISTRY_AGENTS.find((x) => x.id === a.id);
      rows.push(
        h(
          "div",
          { class: "ai-row", "data-agent": a.name, "data-registry-id": a.id },
          agentIcon(info ?? { name: a.name }),
          h(
            "div",
            { class: "ai-row-main" },
            h("span", { class: "ai-row-name" }, a.name),
            h(
              "span",
              { class: "ai-row-detail" },
              `Installed ${a.version} ${suggested ? `· ${suggested.blurb}` : "from the ACP registry"}${a.kind === "binary" && !a.verified ? " · not checksum-verified" : ""}`,
            ),
          ),
          h(
            "div",
            { class: "ai-row-actions" },
            this.button("Use", "agent", () =>
              this.run("agent.selectModel", {
                model: `acp/${a.name}`,
                ...(this.deps.session?.() && { session: this.deps.session() }),
              }),
            ),
            this.button("Remove", "trash-2", () =>
              this.run("agent.registry.uninstall", { id: a.id }),
            ),
          ),
        ),
      );
    }
    if (this.showAgents) this.gallery.update();
    const count = this.deps.registry.agents.value.length;
    const toggle = this.textButton(
      this.showAgents ? "View fewer" : `View more agents${count ? ` (${count})` : ""}`,
      () => {
        this.showAgents = !this.showAgents;
        if (this.showAgents) this.gallery.open();
        this.render();
      },
      "chevron-down",
    );
    toggle.classList.add("ai-more", "acp-gallery-toggle");
    toggle.setAttribute("aria-expanded", String(this.showAgents));
    return this.section(
      "Use an agent you already have",
      null,
      h("div", { class: "ai-list" }, ...rows),
      toggle,
      this.showAgents ? this.gallery.element : null,
    );
  }

  // ---- Small parts -------------------------------------------------------------------------------

  private section(
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

  private button(
    label: string,
    glyph: IconName,
    click: () => unknown,
    className = "button button-secondary button-sm",
  ): HTMLElement {
    const el = h("button", { class: className, type: "button" }, icon(glyph), label);
    on(el, "click", () => void click());
    return el;
  }

  private textButton(label: string, click: () => void, glyph?: IconName): HTMLElement {
    const el = h("button", { class: "ai-link", type: "button" }, label, glyph ? icon(glyph) : null);
    on(el, "click", click);
    return el;
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** The marks on the setup card, left to right: [letters, brand, name]. */
const START_BRANDS: readonly (readonly [string, string, string])[] = [
  ["A", "anthropic", "Anthropic"],
  ["Op", "openai", "OpenAI"],
  ["G", "gemini", "Gemini"],
  ["O", "ollama", "Ollama"],
  ["CC", "claudecode", "Claude Code"],
  ["Cx", "codex", "Codex"],
  ["GH", "github", "GitHub Copilot"],
  ["Or", "openrouter", "OpenRouter"],
];

/**
 * An empty chat with no model to use (D166): what's missing, and one button to the AI models page,
 * styled like the page's rows. `preview` (AI: Preview first-run setup) adds Close preview.
 */
export function setupPrompt(
  preview: boolean,
  run: (command: string) => void,
  /** Another way to start under the button (D239: Start free with OpenCode). */
  extra?: HTMLElement | null,
  /** The chat's greeting (D240). */
  greeting = "Ask, or describe a change",
): HTMLElement {
  const open = h(
    "button",
    { class: "ai-start", type: "button" },
    h(
      "span",
      { class: "ai-tile-text" },
      h("span", { class: "ai-tile-name" }, "Set up AI models"),
      // The services you can connect, as an overlapping row of their marks (D180) rather than a
      // sentence listing them; the names are the row's accessible label (no tooltip: D185).
      h(
        "span",
        {
          class: "ai-start-brands",
          "aria-label": `Connect ${START_BRANDS.map(([, , name]) => name).join(", ")}`,
        },
        ...START_BRANDS.map(([letters, brand]) => mark(letters, brand)),
        h("span", { class: "ai-start-more" }, "and more"),
      ),
    ),
    icon("chevron-right"),
  );
  on(open, "click", () => run("agent.showSetup"));
  const close = preview ? h("button", { class: "ai-link", type: "button" }, "Close preview") : null;
  if (close) on(close, "click", () => run("agent.closeSetupPreview"));
  return h(
    "div",
    { class: "agent-empty ai-prompt" },
    h("div", { class: "agent-empty-title" }, greeting),
    h("div", { class: "agent-empty-text" }, "Connect a model to start."),
    open,
    extra ?? null,
    close,
  );
}

/**
 * Providers extensions offer (D176), as tiles after the built-in ones: marked as an extension's,
 * with the server's host in the blurb, so the user sees where a key would go before pasting it.
 */
function contributedPresets(services: WorkbenchServices): ProviderPreset[] {
  return services.extensionFeatures.providers.peek().map((c) => {
    let host = c.baseUrl;
    try {
      host = new URL(c.baseUrl).host;
    } catch {
      // Checked when the manifest was read; keep the text.
    }
    return {
      id: `ext-${c.owner.replace(/[^a-z0-9]+/gi, "-")}-${c.id}`.toLowerCase(),
      name: c.name,
      baseUrl: c.baseUrl,
      needsKey: c.needsKey,
      ...(c.keyHint && { keyHint: c.keyHint }),
      ...(c.kind === "anthropic" && { kind: "anthropic" as const }),
      ...(c.defaultModel && { defaultModel: c.defaultModel }),
      blurb: `${c.blurb ? `${c.blurb} · ` : ""}${host} · from ${c.owner}`,
      tags: ["Extension"],
      mark: (c.name.match(/[A-Za-z0-9]/)?.[0] ?? "E").toUpperCase(),
      brand: "custom",
    };
  });
}
