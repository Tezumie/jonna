// Diff view toggles (D200, VS Code's diff editor menu): inline or side by side, whitespace
// changes shown or ignored, unchanged regions collapsed. Each flips its diffEditor.* user setting,
// so every diff view follows.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export const DIFF_TOGGLES = [
  {
    id: "diffEditor.toggleInline",
    key: "diffEditor.renderSideBySide",
    fallback: true,
    title: "Toggle inline diff view",
    label: "Inline view",
    /** The menu's check shows the opposite of the setting (inline = not side by side). */
    inverted: true,
  },
  {
    id: "diffEditor.toggleWhitespace",
    key: "diffEditor.ignoreTrimWhitespace",
    fallback: true,
    title: "Toggle showing whitespace changes in diffs",
    label: "Show leading and trailing whitespace changes",
    inverted: true,
  },
  {
    id: "diffEditor.toggleCollapseUnchanged",
    key: "diffEditor.hideUnchangedRegions.enabled",
    fallback: false,
    title: "Toggle collapsing unchanged regions in diffs",
    label: "Collapse unchanged regions",
    inverted: false,
  },
] as const;

export function registerDiffToggles(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings } = services;
  for (const t of DIFF_TOGGLES)
    sub.add(
      dispatcher.register({
        id: t.id,
        title: t.title,
        category: "Diff",
        description: `Flips the ${t.key} setting (user settings); every diff view follows. Returns the new value.`,
        input: s.object({}),
        effects: ["write"],
        run: async () => {
          const value = !(settings.peek<boolean>(t.key) ?? t.fallback);
          await settings.update(t.key, value, "user");
          return { [t.key]: value };
        },
      }),
    );
}

/** The diff toggles as checked menu items (the diff toolbar's ⋯ menu). */
export function diffToggleItems(
  services: WorkbenchServices,
): { label: string; checked: boolean; run(): void }[] {
  return DIFF_TOGGLES.map((t) => {
    const on = services.settings.peek<boolean>(t.key) ?? t.fallback;
    return {
      label: t.label,
      checked: t.inverted ? !on : on,
      run: () => void services.dispatcher.execute(t.id).catch(() => {}),
    };
  });
}
