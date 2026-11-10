# styles

- `tokens.css` — **hand-authored** design tokens (DESIGN.md Appendix A plus terminal ANSI and the
  syntax-theme name). The only file with color values; everything else uses semantic tokens.
  `npm run check` enforces this (`scripts/check-colors.mjs`).
- `base.css` (reset, focus ring, kbd, scrollbars), `workbench.css` (title bar, activity bar,
  sidebar, sashes, status bar, flush mode), `dock.css` (groups, tabs, drag and drop),
  `components.css` (buttons, inputs, rows, menus, palette, toasts, dialogs, empty states),
  `extensions.css` (explorer, editor, terminal, welcome, agent, dev views).
