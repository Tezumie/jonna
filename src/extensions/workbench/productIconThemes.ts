// Product icon themes (D267, VS Code's Preferences: Product Icon Theme): `workbench.productIconTheme`
// picks "Default" (the IDE's own icons) or one an installed extension contributes
// (`contributes.productIconThemes`); the workbench's ProductIconThemes draws it.
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { ProductIconThemes } from "../../workbench/productIcons";
import type { WorkbenchServices } from "../../workbench/services";

/** VS Code's id for its own icons: here, the IDE's. */
export const DEFAULT_PRODUCT_ICONS = "Default";

export function registerProductIconThemes(sub: DisposableStore, services: WorkbenchServices): void {
  const { contributions, settings, dispatcher, notifications } = services;
  const themes = sub.add(new ProductIconThemes());
  sub.add(
    settings.registerChoices("workbench.productIconTheme", () => [
      { value: DEFAULT_PRODUCT_ICONS, label: "Default", description: "The IDE's own icons" },
      ...contributions.productIconThemes.peek().map((t) => ({
        value: t.id,
        label: t.label,
        description: t.source,
      })),
    ]),
  );

  let failed = "";
  sub.add(
    effect(() => {
      const wanted =
        settings.get<string | null>("workbench.productIconTheme") || DEFAULT_PRODUCT_ICONS;
      // An extension's theme that isn't loaded (yet): the IDE's icons meanwhile.
      const entry = contributions.productIconThemes.value.find((t) => t.id === wanted) ?? null;
      void themes.apply(entry).catch((err: unknown) => {
        if (failed === wanted) return;
        failed = wanted;
        notifications.show(
          "error",
          `Couldn't load the product icon theme "${wanted}": ${err instanceof Error ? err.message : String(err)}`,
        );
        void themes.apply(null);
      });
      return undefined;
    }),
  );

  sub.add(
    dispatcher.register({
      id: "ui.selectProductIconTheme",
      title: "Product icon theme…",
      category: "Preferences",
      description:
        "Picks the product icon theme (VS Code's): Default (the IDE's own icons) or one from an installed extension, whose font redraws the workbench's icons (the activity bar's, views' and editors' actions, the status bar's). Without `id`, shows a picker. Sets workbench.productIconTheme.",
      input: s.object({ id: s.string().describe("Product icon theme id").optional() }),
      effects: [],
      run: async ({ id }) => {
        const current = settings.get<string>("workbench.productIconTheme") || DEFAULT_PRODUCT_ICONS;
        let pick = id;
        if (pick === undefined) {
          const items = [
            { id: DEFAULT_PRODUCT_ICONS, label: "Default", description: "The IDE's own icons" },
            ...contributions.productIconThemes
              .peek()
              .map((t) => ({ id: t.id, label: t.label, description: t.source })),
          ].map((i) =>
            i.id === current ? { ...i, description: `${i.description} · current` } : i,
          );
          const picked = await services.quickInput.pick(
            [...items.filter((i) => i.id === current), ...items.filter((i) => i.id !== current)],
            { placeholder: "Product icon theme" },
          );
          if (!picked) return { id: current };
          pick = picked.id;
        }
        if (
          pick !== DEFAULT_PRODUCT_ICONS &&
          !contributions.productIconThemes.peek().some((t) => t.id === pick)
        )
          throw new Error(`No product icon theme "${pick}".`);
        await settings.update(
          "workbench.productIconTheme",
          pick === DEFAULT_PRODUCT_ICONS ? undefined : pick,
          "user",
        );
        return { id: pick };
      },
    }),
  );
}
