# extensions/viewers

Special views for file types, beside the text editor (D78). Each is a dock view taking
`{ path }`, registered in `services.viewers` (`ViewerRegistry`, `src/workbench/services.ts`):

| Viewer | View type | Files | Opens |
|---|---|---|---|
| Image preview | `image` | .png .jpg .jpeg .gif .webp .bmp .ico .avif | by default (`editor.openFile` sends images here) |
| Markdown preview | `markdownPreview` | .md .markdown .mdx | from the editor: "Open preview" (in place, Ctrl/Cmd+Shift+V) and "Open preview to the side" (Ctrl/Cmd+K V) tab actions |
| SVG preview | `svgPreview` | .svg | the same |
| Hex viewer | `hexView` | .pyc .class .wasm .exe .dll .so .o .bin … | by default; any file via "Reopen with… → Hex viewer" and the editor's "binary file" notice |
| Media player | `media` | .mp3 .wav .ogg .m4a .flac … .mp4 .webm .mov | by default |
| Table preview | `csvPreview` | .csv .tsv | from the editor, like Markdown's |
| Font preview | `fontPreview` | .ttf .otf .woff .woff2 | by default |
| Notebook | `notebook` | .ipynb | by default; edited and run there (`editor/notebook`, D188) |
| Archive contents | `archive` | .zip .jar .war .vsix .whl .nupkg .epub .apk | by default |
| Search editor | `searchEditor` | .code-search | by default (registered by the search extension, D196) |

- `more.ts` / `formats.ts` (D118) — the hex dump (virtualised rows, files up to 50 MB), the media
  player (blob: URL; CSP `media-src blob:`) and the CSV table (RFC 4180 quotes, delimiter guessed,
  first 5000 rows, live as you type).
- `rich.ts` (D120) — the font preview and the archive contents.

- `image.ts` — `ImageCanvas`: checkerboard, fit until zoomed, click / Alt+click / Ctrl+wheel zoom,
  size label. Images are read through IPC into blob: URLs (CSP allows `blob:` images only).
- `views.ts` — the three views. Previews read the open document's live text
  (`services.documents`, unsaved edits included) and re-render 150 ms after typing; the Markdown
  preview follows the editor's scroll, opens links (files in the editor, http(s) in the browser,
  `#anchors` in place), highlights code with the editor engine (each block patched in when it's
  colored, not a re-render: long documents have hundreds, D278) in `markdown.preview.fontFamily`,
  `fontSize` and `lineHeight` (D279) and shows workspace images, and
  https:// images (fetched by the backend's `remote_image`, public hosts only, shown as blob: URLs:
  `core/ipc/remoteImage.ts`, D210) unless `markdown.preview.remoteImages` is off (then their alt
  text). Double-click a block to jump to its source line. Scroll sync works both
  ways and the editor's cursor block is marked (D83); `.md` links open in the same preview.
  Raw HTML renders through the sanitizer (`ui/markdown/sanitize.ts`, D210), its images by the same
  rule as Markdown images; an image that can't load shows its alt text. No sticky headings (D210).
- `previewFind.ts` (DOM-free, tested) / `previewFindBar.ts` / `previewFindCommands.ts` — find in
  the Markdown preview (D210), VS Code's preview find: Ctrl/Cmd+F with the preview focused, match
  case / whole word / regex, "n of m", Enter / Shift+Enter and F3 / Shift+F3, Escape; matches are
  CSS highlights (the current one distinct), may span inline markup but not blocks, and a closed
  `<details>` opens to show one. Context keys `markdownPreviewFocus`, `markdownFindVisible`,
  `markdownFindInputFocus`; state `ide://markdownPreview` (the active preview's file and search).

**Commands:** `viewer.open`, `viewer.openPreview` (`toSide`), `viewer.openPreviewToSide`,
`viewer.togglePreview` (Ctrl/Cmd+Shift+V, D134: the file and its preview swap in the same tab; from
a preview whose file is open beside it, focuses the file),
`editor.reopenWith` (text editor or any viewer), `viewer.zoom`, `markdown.find` (`query`,
`caseSensitive`, `wholeWord`, `regex`, `focus`), `markdown.findNext`, `markdown.findPrevious`,
`markdown.closeFind` (each takes `path`, default the active preview). **Tab actions:** zoom out / in /
fit-or-100% on images and SVG previews, "Open source" on previews.

A new viewer: register a dock view type taking `{ path }` and a `ViewerContribution`
(`kind: "default"` to open such files in it, `"preview"` to offer it from the editor).
