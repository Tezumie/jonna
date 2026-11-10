// A provider's or agent's badge (D167, D168): its logo from src/assets/brands, or a letter or two
// in its color (`--brand-<brand>`). Shared by the AI models page and the model picker (D227).

import { PRESET_REGISTRY_IDS, type RegistryIcon } from "../../../core/acp/registry";
import { h } from "../../../core/dom/index";
import type { WorkbenchServices } from "../../../workbench/services";
import { installedAgents } from "../acpRegistry";
import { BRAND_LOGOS } from "../brandLogos";
import { AGENT_SETUP, brandPresetFor } from "../catalog";
import { OLLAMA_ID } from "../providers";
import { providerImage } from "../setupCommands";

let registryIconFor: (id: string) => RegistryIcon | undefined = () => undefined;

/** How a registry agent's icon is found (the ACP registry, set up by the agent extension). */
export function setRegistryIcons(find: (id: string) => RegistryIcon | undefined): void {
  registryIconFor = find;
}

/**
 * A preset agent with no logo in src/assets/brands: the icon its entry in the ACP registry has
 * (D239: OpenCode), which the agent's makers publish there.
 */
function presetIcon(brand: string): RegistryIcon | undefined {
  const name = Object.keys(AGENT_SETUP).find((n) => AGENT_SETUP[n]?.brand === brand);
  const id = name ? PRESET_REGISTRY_IDS[name] : undefined;
  return id ? registryIconFor(id) : undefined;
}

/**
 * The badge: an official logo (src/assets/brands, generated into BRAND_LOGOS) replaces the
 * letters, a colored one as it is, a one-color one in white on the brand's color (D168). The
 * user's own image (D212) comes first, shown as it is. With `state`, a status dot on its corner.
 */
export function brandMark(
  text: string,
  brand: string,
  state?: string,
  image?: string | RegistryIcon,
): HTMLElement {
  const logo =
    typeof image === "string"
      ? { src: image, mono: false }
      : (image ?? BRAND_LOGOS[brand] ?? presetIcon(brand));
  let glyph: HTMLElement | string = text;
  if (logo?.mono) {
    glyph = h("span", { class: "ai-logo-mask" });
    glyph.style.setProperty("--logo", `url("${logo.src}")`);
  } else if (logo) glyph = h("img", { src: logo.src, alt: "", draggable: "false" });
  return h(
    "span",
    {
      class: { "ai-mark": true, "has-logo": !!logo, "is-mono": !!logo?.mono },
      "data-brand": brand,
    },
    glyph,
    state ? h("span", { class: `ai-dot is-${state}` }) : null,
  );
}

/** A configured provider's badge: its own image, else the logo of the preset it is. */
export function providerMark(
  services: WorkbenchServices,
  provider: { id: string; name: string; baseUrl: string },
): HTMLElement {
  // Ollama is built in, not a preset: its own logo.
  if (provider.id === OLLAMA_ID) return brandMark("Ol", "ollama");
  const preset = brandPresetFor(provider);
  return brandMark(
    preset?.mark ?? provider.name.slice(0, 2),
    preset?.brand ?? "custom",
    undefined,
    providerImage(services, provider.id),
  );
}

/**
 * An external agent's badge: the presets' logos (Claude Code, Codex…), an agent installed from
 * the ACP registry its registry icon (`registryIcon` looks it up by id), others their initials.
 */
export function agentMark(
  services: WorkbenchServices,
  name: string,
  registryIcon?: (id: string) => RegistryIcon | undefined,
): HTMLElement {
  const info = AGENT_SETUP[name];
  if (info) return brandMark(info.mark, info.brand);
  const installed = Object.values(installedAgents(services)).find((a) => a.name === name);
  const icon = installed && registryIcon?.(installed.id);
  return brandMark(name.slice(0, 2), "custom", undefined, icon);
}
