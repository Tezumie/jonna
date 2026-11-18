# styles

- `tokens.css` — **hand-authored** design tokens (DESIGN.md Appendix A plus terminal ANSI and the
  syntax-theme name). The only file with color values; everything else uses semantic tokens.
  `npm run check` enforces this (`scripts/check-colors.mjs`).
- `base.css` (reset, focus ring, kbd, scrollbars), `workbench.css` (title bar, activity bar,
  sidebar, sashes, status bar, flush mode), `dock.css` (groups, tabs, drag and drop),
  `components.css` (buttons, inputs, rows, menus, palette, toasts, dialogs, empty states),
  `extensions.css` (explorer, editor, terminal, welcome, agent, dev views).
- The agent's chat is `agent.css` (the panel, its header, messages and their actions) and, as
  `index.css` imports them right after it: `agent-tool-rows.css` (tool rows, diff cards, the side
  question, permission cards), `agent-composer.css` (folder card, changeset bar, jump pill, the
  message box, voice input), `agent-markdown.css` (`.md` prose, code blocks, tables),
  `agent-attachments.css` (attachment cards), `agent-work.css` (the work group, its steps, the
  plan card, a queued message), `agent-viewer.css` (screenshots and attachments, large) and
  `agent-asides.css` (plain-text reply, missing agent, the editor's review bar, a background
  command's output). They were one file: keep that import order, since rules of equal
  specificity in the same layer rely on it. The other `agent-*.css` files follow, one per feature.
