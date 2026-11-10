// File icon themes (D132): `workbench.iconTheme` picks one — Material Icon Theme (bundled, the
// default), "minimal" (the IDE's own small set), or any VS Code icon theme an installed extension
// contributes (`contributes.iconThemes`). The workbench's FileIconThemes draws them.
import { asIconTheme } from "../../core/iconTheme/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { IconThemeEntry } from "../../workbench/contributions";
import { FileIconThemes } from "../../workbench/fileIcons";
import type { WorkbenchServices } from "../../workbench/services";
import { languageForPath } from "../editor/languages";

export const MINIMAL_ICON_THEME = "minimal";
export const DEFAULT_ICON_THEME = "material-icon-theme";

/** The bundled themes: copied into dist/icon-themes by build.mjs. */
const BUILT_IN: IconThemeEntry[] = [
  {
    id: DEFAULT_ICON_THEME,
    label: "Material Icon Theme",
    source: "built-in",
    load: async () => {
      // The manifest is a lazy chunk (no fetch: custom-scheme fetches fail in some webviews);
      // its icon paths ("./../icons/x.svg") are relative to where build.mjs puts it.
      const doc = asIconTheme(
        (await import("material-icon-theme/dist/material-icons.json")).default as unknown,
      );
      const base = new URL("./icon-themes/material/dist/material-icons.json", document.baseURI);
      return { doc, url: async (path) => new URL(path, base).href };
    },
  },
  {
    id: MINIMAL_ICON_THEME,
    label: "Minimal",
    source: "built-in",
    load: async () => null,
  },
];

export function registerIconThemes(sub: DisposableStore, services: WorkbenchServices): void {
  const { contributions, settings, dispatcher, theme, notifications } = services;
  const themes = sub.add(new FileIconThemes());
  themes.languageOf = (name) => {
    const id = languageForPath(name);
    return id === "plaintext" ? undefined : id;
  };
  sub.add(contributions.addIconThemes(BUILT_IN));
  // Settings → File icon theme: a dropdown (D134).
  sub.add(
    settings.registerChoices("workbench.iconTheme", () =>
      contributions.iconThemes.peek().map((t) => ({
        value: t.id,
        label: t.label,
        description: t.id === MINIMAL_ICON_THEME ? "The IDE's own small icons" : t.source,
      })),
    ),
  );

  let failed = "";
  sub.add(
    effect(() => {
      const wanted = settings.get<string | null>("workbench.iconTheme") || MINIMAL_ICON_THEME;
      const entries = contributions.iconThemes.value;
      const light = theme.theme.value === "light";
      // An extension's theme that isn't loaded (yet): the default meanwhile.
      const entry =
        entries.find((e) => e.id === wanted) ??
        (wanted === MINIMAL_ICON_THEME
          ? undefined
          : entries.find((e) => e.id === DEFAULT_ICON_THEME));
      void themes
        .apply(entry && entry.id !== MINIMAL_ICON_THEME ? entry : null, light)
        .catch((err: unknown) => {
          if (failed === wanted) return;
          failed = wanted;
          notifications.show(
            "error",
            `Couldn't load the file icon theme "${wanted}": ${err instanceof Error ? err.message : String(err)}`,
          );
          void themes.apply(null, light);
        });
      return undefined;
    }),
  );

  sub.add(
    dispatcher.register({
      id: "ui.selectFileIconTheme",
      title: "File icon theme…",
      category: "Preferences",
      description:
        "Picks the file icon theme: Material Icon Theme (built in), Minimal (the IDE's own icons) or one from an installed extension (VS Code icon themes work). Without `id`, shows a picker. Sets workbench.iconTheme.",
      input: s.object({ id: s.string().describe("Icon theme id").optional() }),
      effects: [],
      run: async ({ id }) => {
        let pick = id;
        if (pick === undefined) {
          const current = settings.get<string>("workbench.iconTheme") || MINIMAL_ICON_THEME;
          const items = contributions.iconThemes.peek().map((t) => ({
            id: t.id,
            label: t.label,
            description: t.id === current ? `${t.source} · current` : t.source,
          }));
          const picked = await services.quickInput.pick(
            [...items.filter((i) => i.id === current), ...items.filter((i) => i.id !== current)],
            { placeholder: "File icon theme" },
          );
          if (!picked) return { id: current };
          pick = picked.id;
        }
        if (!contributions.iconThemes.peek().some((t) => t.id === pick))
          throw new Error(`No file icon theme "${pick}".`);
        await settings.update(
          "workbench.iconTheme",
          pick === DEFAULT_ICON_THEME ? undefined : pick,
          "user",
        );
        return { id: pick };
      },
    }),
  );
}
