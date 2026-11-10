# extensions/browser

The `browser` dock view (D89, D93): toolbar (back, forward, reload, address, console counts,
device mode, element picker, DevTools, more), the page, and DevTools on a resizable split
(bottom or side).

- **Local dev servers** (`localhost:5173`…) show in the tab's frame through the preview proxy
  (Rust `browser/proxy.rs`): bridge injected, frame-blocking headers dropped, WebSocket upgrades
  passed through (hot reload), every request logged for Network.
- **Workspace files** (`index.html`) are served as static files and update while typing
  (unsaved text served in place of the file; CSS swaps without reload — `browser.liveReload.onEdit`).
  HTML files have "Open preview" (Ctrl/Cmd+Shift+V).
- **Other sites** open in their own window with the same bridge; the tab controls it. With
  `browser.embedSites` (Windows, macOS; off by default until checked by hand) they show inside
  the tab instead: `embed.ts` keeps a child webview of the IDE window (Tauri multi-webview, Rust
  `browser/embed.rs`) over the page area, follows layout changes, hides it while the tab is hidden
  or an IDE overlay (menu, dialog, quick input, toast, drag preview) covers it, showing the page's
  last snapshot meanwhile (`embedGeometry.ts`, tested). It fails over to a window. "Open site in
  its own window" (More menu) pops one tab out; popped-out state is saved with the tab.
- **Links, redirects, forms and popups** stay in the IDE (D209; `links.ts` decides, tested;
  `opening.ts` applies it; the bridge half is `src-tauri/src/browser/links.js`): another local
  server (any port) comes back through its own proxy in the same tab (redirects through the
  proxy's goto page, form posts with their body); `target=_blank`, Ctrl/Cmd/middle-click and
  `window.open` open a new browser tab beside it; a `window.open` popup keeps a relay to its
  opener (`postMessage`, `close`, `closed`) so sign-in popups work. Named targets
  (`window.open(url, name)`, `target="name"`) reuse the tab of that name (its `window.name`; the
  frame's `name` attribute carries `ide-tab:{json}`); `opener.location = …` navigates the opener's
  tab; `document` of a popup or opener throws a SecurityError (as across origins); a form posted
  into a new tab is posted there from the proxy's passing page `/__ide/post` (`PendingForm`). Other sites follow
  `browser.externalLinks` (`ide`: the tab's own window, Back returns to the local page; `system`:
  the system browser); their windows hand local addresses (an OAuth callback) back to the tab.
  Cookies work in the frame (the proxy adapts SameSite / Domain; WebKitGTK is told to accept
  third-party-frame cookies).
- **Servers** terminals start are offered (status bar, toast, empty tab): D92;
  `browser.notifyOnServer` turns the offer off.
- **Debugging a page** with breakpoints runs in the user's Chrome or Edge, not in this pane
  (`extensions/debug`, D196).

**Downloads** (`downloads.ts`, `downloadsModel.ts` tested; Rust `browser/downloads.rs`): the tab's
frame, site windows and embedded sites report to the IDE's list (on Windows through WebView2's
download operation, with progress and cancel; elsewhere start and end only); a status bar entry
while there are any and a `downloads` dock tab with open, show in folder and cancel.
**Streaming:** the proxy forwards request bodies as they arrive and HTML as it comes, with the
bridge tag inserted once `<head>` is seen (Rust `browser/stream.rs`).

`view.ts` is the tab (`BrowserView`: loading, the frame and its messages, windows, device mode,
DevTools layout); `viewToolbar.ts` builds its toolbar (buttons, address field, the turning reload
arrow), `viewParts.ts` and `viewState.ts` hold what only uses its public side and its saved state.
`page.ts` (`Page`, tested): what the bridge reported (url, title, console with args/groups/counts,
errors, requests) and calls into it. `address.ts`, `devices.ts` (tested). `devtools/`: the
DevTools shell and panels — `elements.ts` (DOM search), `styles.ts` (editable Styles pane) with
`cssEdit.ts` (tested: number steps, colors, the cascade), `console.ts`, `network.ts`,
`sources.ts` (find in file), `performance.ts` (load metrics, recording, reload and record),
`timeline.ts` (the recording drawn as Chrome's tracks, D147) with `perfModel.ts` (tested: ruler,
frames, rows, range statistics), `application.ts` (storage, cookies, IndexedDB, Cache storage,
service workers), shared helpers in `common.ts` (`splitPanes`: resizable panes that stack when
narrow, D146/D147). The tab strip fits its width (`index.ts`: icons and names, shorter names,
icons; it scrolls past that). `commands.ts`: DevTools commands, `browser.performance`,
`browser.record`.

**Commands:** `browser.open` (`window` for its own window), `browser.navigate`, `back`, `forward`,
`reload`, `snapshot`, `click`, `hover`, `type`, `press`, `select`, `scroll`, `text`, `wait`,
`eval`, `console`, `list`, `devtools`, `network`, `record`, `request`, `dom`, `styles`, `storage`,
`setStorage`, `highlight`, `reveal`, `inspect`, `resize`, `focusAddress`, `toggleConsole`,
`popOut` (the page in its own window, through the proxy; the tab keeps toolbar and DevTools),
`downloads`, `showDownloads`, `openDownload`, `revealDownload`, `cancelDownload`,
`clearDownloads`,
`screenshot` (the page as shown; `inline` for agents — D96), and Go Live (`live.ts`:
`goLive`, `stopLive`, `toggleLive`; the status bar's Go Live / Port item, hidden by
`browser.goLive.statusBar` or while a Live Server extension is on, D284). D284: a static preview
open in an outside browser reloads on a change: the bridge waits on the proxy's `/__ide/live`
(Rust `Shared::bump_live`, bumped by `browser_overlay`, which saves call too).
Elements by `ref` (from a snapshot — also the Elements panel's node ids), `selector` or `name`.
**Keys** (`browserFocus`, also inside the page): F12 / Ctrl+Shift+I DevTools, Ctrl+Shift+C pick,
Ctrl+L address, F5 / Ctrl+R reload.
**Agent:** `browser_snapshot`, `browser_act`, `browser_inspect`, `browser_console`,
`browser_eval`, `browser_batch` while a browser tab is open, and `screenshot` (page or IDE) always.
**Input like a person's** (D316, `inputCommands.ts`, bridge half `src-tauri/src/browser/input.js`):
`browser.input` (click with a button and count, hover, drag — HTML drag and drop or pointer moves —,
wheel scroll at a point, keys with modifiers and their usual effect in text fields, typing at the
focus; points in the screenshot's coordinate frame: the viewport scaled to fit 1568 px, which
`browser.screenshot` `inline` reports as `frame` and draws at, with `region` to zoom and `scale`),
`browser.find` (outline lines with refs), `browser.selectTab`, `browser.closeTab`, `browser.text`
`main` (article or main first), `browser.eval` `repl` (last expression, top-level await, JSON),
`browser.console` `pattern`, and `browser.resize` `colorScheme` (D318: prefers-color-scheme by
rewriting the page's media rules and matchMedia, kept across the tab's reloads).
**Files and places** (D339, D340): `browser.upload` (workspace files or base64 data set on a file
input through a DataTransfer with input and change events, or dropped on any other element;
`core/agent/browserUpload.ts` plans which, tested; at most 10 MB), `browser.locate` (an element's
center in the screenshot's frame), `browser.screenshot` `ifShown` (never brings a tab forward).
**The user's own browser** (D341, `external.ts`, protocol half `core/browser/cdp.ts` tested):
`browser.launchExternal` starts the installed Chrome or Edge with a debugging port and its own
profile (the workspace's IDE folder, `external-browser-profile`), `browser.connectExternal`
attaches to one the user started with `--remote-debugging-port`, `browser.disconnectExternal`
lets go. Over the DevTools protocol (Rust's local-only debug socket, D143) the IDE installs the
same bridge (Rust `browser_bridge_source`), which reports through a protocol binding and is called
through Runtime.evaluate, so the page commands (snapshot, find, text, click, type, press, select,
scroll, wait, eval, console, input, upload, locate, navigate, back, forward, reload, screenshot)
take `tab: "external"`, or act on it by default after `browser.selectTab external` until another
browser tab comes forward. In that browser the bridge leaves links, popups, keys and scrollbars
alone. The data commands answer for it over the protocol (D347, `externalDevtools.ts`, mapping
in `core/browser/cdpDevtools.ts` tested): `network` / `request` (Network events into the same
records, bodies by getResponseBody / getRequestPostData), `dom` (DOM.getOuterHTML), `styles`
(CSS.getMatchedStylesForNode with each rule's file and line, getComputedStyleForNode, the box
model), `storage` / `setStorage` (DOMStorage, Network cookies with their attributes, HttpOnly
too), `highlight` (Overlay), `resize` (Emulation device metrics and prefers-color-scheme), and the
console gains the browser's own lines (Log.entryAdded: failed loads, security). The DevTools
panels stay with the tabs.
**Trusted input** (D346, `trustedInput.ts`, event sequences in `core/browser/trustedInput.ts`
tested): `browser.input` and `browser.click` / `hover` / `press` / `type` send a person's events
(`isTrusted`) through a DevTools protocol where they can — the user's own browser over its socket
(`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`, HTML drag and drop by drag
interception), the built-in tab on Windows through WebView2's in-process
`CallDevToolsProtocolMethod` (Rust `browser_trusted_input`, `Input.*` only, no port): into the
IDE's webview at the frame's place after checking the frame is what's there (else the bridge), or
into a site's webview. Keys focus the frame; focus goes back to the IDE text field the user was in.
The bridge (`input.prepare` / `input.report`) says where events land and reports. Elsewhere, with
`browser.trustedInput` off, or for HTML drag and drop in the built-in tab, the bridge synthesizes
them; results say `input: trusted | synthesized` (with `inputNote`), as does `ide://browser`.
**State:** `ide://browser` (`shownIn`:
frame, tab — a site inside the tab — or window), `ide://downloads`. **Settings:**
`browser.notifyOnServer`, `browser.liveReload.onEdit`, `browser.externalLinks`,
`browser.embedSites`, `browser.trustedInput`.
**Tests:** `page.test.ts`, `address.test.ts`, `devices.test.ts`, `links.test.ts`,
`opening.test.ts`, `tests/scripts/browser.jsonc`, `tests/scripts/browser-m7-6.jsonc` (two local
servers: links, redirect, form, new tabs, popup), `tests/scripts/browser-m7-12.jsonc` (forms into
new tabs, named tabs, opener.location, popup.document, streamed HTML),
`tests/scripts/browser-downloads-m7-12.jsonc` (Windows), `downloadsModel.test.ts`,
`embedGeometry.test.ts`, `tests/scripts/workbench-m6.jsonc`,
`tests/scripts/browser-agent-m7-58.jsonc` (the agent's input, find, text, eval, batch, dark mode, tabs).

**Multi-root workspaces** (D251, `address.ts`): a file address shows with its folder's name first
("api/index.html", read back the same way); each folder's files are previewed by that folder's own
static proxy (`rootFor`, `proxies.folder`); live reload covers every folder; `browser.goLive
{folder}` previews a folder's index.html (default: the active file's folder's, else asks among
the folders that have one).
