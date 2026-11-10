# Browser preview

The IDE has a browser tab for previewing your work: a dev server your project runs, an HTML file
from the folder with live reload, or any other site. It has Chrome-like developer tools
(Elements, Console, Network, Sources, Performance, Application), device sizes, screenshots and a
downloads list, and links, redirects and sign-in popups stay in the IDE. This page covers all of
it.

## Open the browser

- **View → Browser** opens a browser tab. [Open browser](command:browser.open) An empty tab
  lists the servers your terminals started; click one to open it.
- Type an address in the address bar (Ctrl+L focuses it) and press Enter. It takes:
  - a local dev server: `localhost:5173`, `http://127.0.0.1:3000/x`
  - a file or folder of the workspace: `index.html`, `site/`, or an absolute path inside the
    folder
  - any other site: `https://example.com`, or just `example.com`
- When a terminal prints a local server's address, the IDE offers to open it (once per server).
  The status bar lists the running servers; click it, or **View → Open running server…**, to open
  one (or show the tab that already has it). Ctrl+click a local address in a terminal opens it in
  the browser beside the terminal.

The browser is a tab in the dock like any other: drag it beside your editor, into its own group,
or anywhere else.

### The toolbar

| Control | What it does |
|---|---|
| Back, Forward | Go back and forward in the tab's history |
| Reload | Reloads the page (F5 or Ctrl+R); Shift+click reloads without the cache |
| Address | The page's address (Ctrl+L) |
| Console counts | The page's errors and warnings; click to open the Console |
| Select an element | Click an element in the page to inspect it (Ctrl+Shift+C) |
| DevTools | Shows or hides the developer tools (F12 or Ctrl+Shift+I) |
| Open in system browser | Opens the address in your default browser |
| Open in its own window | Moves the page into a window of its own |
| More (…) | The menu below |

The **More** menu has **Reload without cache**, **Copy address**, **Device size (responsive
mode)**, the window options, **DevTools**, **Network**, **Clear site data** and **Live reload
while typing**.

## Preview a local dev server

Local servers (`localhost`, `127.0.0.1`, any port) show inside the tab. The IDE passes them
through a small preview proxy, which lets the page show in the tab, keeps hot module reload
working (WebSockets pass through), and logs every request for the Network panel. Cookies a local
app sets are kept, so you stay signed in.

To start a server, run your project's `dev` script in a [terminal](10-terminal.md) or as a
[task](12-tasks.md); the IDE notices its address.

## Preview an HTML file (Go live)

For a static site you don't need a server:

- Click **Go Live** in the status bar (or run **Go Live**). It previews the HTML file in the active
  editor, else the folder's `index.html`, beside the editor. [Go live](command:browser.goLive)
- Or open an HTML file and press Ctrl+Shift+V to show its preview in a browser tab.

The preview updates while you type, before you save, and CSS changes apply without a reload
(`browser.liveReload.onEdit`, or **Live reload while typing** in the More menu). While it runs,
the status bar item reads **Port:** and the port; click it to stop the preview (**Stop live
preview**).

In a workspace with several folders, each folder's files are served by their own preview, and
**Go Live** asks which folder's `index.html` when it can't tell.

The preview's address works in any browser too (**Open in system browser**, in the address bar).
A page opened there reloads by itself when you save a file of the folder (or, with live reload
while typing, as you type), as Live Server's pages do.

**Go Live** leaves the status bar while an extension with its own Go Live is installed and enabled
(Live Server, Live Preview, Five Server), so there's only one. `browser.goLive.statusBar` hides it
always; the command stays in the command palette.

## Links, popups and sign-ins

The browser tab behaves like a real browser, and keeps your local work in the IDE:

- A link, form or redirect to another local server (another port, `127.0.0.1` or `localhost`)
  opens in the same tab, and Back returns to the page before.
- `target="_blank"` links, Ctrl+click or middle-click, and `window.open` open a new browser tab
  beside it. A form posted into a new tab is posted there, with what you typed.
- A link or `window.open` with a name (`target="results"`) reuses the tab of that name.
- A popup can talk to the page that opened it (`postMessage`, `close`) and send it somewhere else
  (`window.opener.location = …`), so sign-in popups work; like a page of another site, it can't
  read the other page's `document`. A sign-in popup closes its tab when it's done.
- Other sites open in the tab's own window, which the tab controls; an OAuth sign-in comes back
  into the tab when the provider sends you to your local callback. Set `browser.externalLinks` to
  `system` to send links to other sites to your system browser instead.

### Other sites inside the tab

On Windows and macOS, turn on `browser.embedSites` to show other sites in the tab itself, as VS
Code does, instead of in a separate window. While one of the IDE's menus or dialogs is open the
page hides behind it, and you see a still picture of it. **Open site in its own window** in the
More menu switches one tab back to a window (**Show site in this tab** returns it). Where
embedding isn't available or fails, sites open in their own window.

### Pages in their own window

**Open in its own window** in the toolbar, or **Open in a new window (with DevTools)** in the
More menu, moves the page into a separate window. **Open only the page in a window** keeps the
toolbar and DevTools in the tab and shows just the page in the window. A page you popped out
comes back popped out after a restart; **Move back into the main window** (or **Show page in this
tab**) returns it.

## Developer tools

Press F12 (or Ctrl+Shift+I) in the browser tab to open DevTools under the page. **Dock to the
side / bottom** moves them beside the page. Drag the dividers between their panes to resize them.
In a narrow DevTools the tab names turn into icons and the panes stack.

### Elements

- The page's DOM as a tree: hover a node to highlight it in the page, expand it to load its
  children. Press Ctrl+Shift+C (or the select button) and click an element in the page to select
  it.
- Edit attributes and text, edit a node as HTML, or delete it.
- Ctrl+F in the tree finds by CSS selector or text; Enter and Shift+Enter move between matches.
- **Styles:** click a name or value to edit it (Up and Down change numbers), use the checkbox to
  switch a declaration off, click a swatch to pick a color, or click a rule's `}` to add a
  declaration. Overridden declarations are struck through. **.cls** switches the element's
  classes. The sidebar also shows computed values and the box model.

Edits change the page only, not your files.

### Console

The page's console messages, with levels, groups, repeat counts, expandable objects, elements
that reveal in Elements, stacks, and failed requests. Filter by text or by level (Errors,
Warnings, Info, Verbose), **Preserve log** across navigations, and **Clear console**. Type
JavaScript in the input line to run it in the page: Enter runs it, Shift+Enter adds a line, Up
and Down go through what you ran.

### Network

Every request the page makes. Filter by text or by type (Fetch/XHR, Doc, CSS, JS, Img, Font,
Media, WS, Other), **Preserve log**, **Disable cache**. Click a request for its headers, payload,
preview, response and timing. Right-click it to copy its URL, copy it as cURL, copy the response,
or open it in a tab or in the editor.

### Sources

The page's documents, scripts and stylesheets as a tree by origin and folder, with syntax colors
and line numbers. Find in the file shown. A resource that is a file in your workspace opens in
the editor.

### Performance

The page's load times, rated like Core Web Vitals (time to first byte, first and largest
contentful paint, layout shift, DOMContentLoaded, load, blocking time), what it downloaded by
type, its slowest requests, DOM size and memory.

Click **Record** while you use the page, or **Reload and record** to capture its load, then
**Stop**. The timeline shows frames, frame rate, the main thread's long tasks, requests,
interactions, timings, layout shifts and memory:

- Hover to read the values.
- Drag the overview to zoom; Ctrl+wheel also zooms and Shift+wheel pans.
- Drag across the tracks to select a range for the summary below.

On macOS and Linux some metrics (largest contentful paint, layout shift, long tasks,
interactions, memory) aren't available and say so.

### Application

Local storage, session storage and cookies (view, double-click a value to edit it, add, delete,
clear), IndexedDB databases with their stores and first entries, Cache storage, and service
workers (unregister). **Clear site data** in the More menu clears the page's cookies, local
storage and session storage at once.

> **Tip:** To set breakpoints in a page's scripts, debug it in Chrome or Edge from the IDE. See
> [Debugging](13-debugging.md).

## Device sizes

Choose **Device size (responsive mode)** in the More menu (or the device button in DevTools) to
show the page at a phone's or tablet's size. The device bar above the page has:

- a device: Responsive, iPhone SE, iPhone 15, iPhone 15 Pro Max, Pixel 8, Galaxy S23, iPad mini,
  iPad Air, Laptop, Desktop or Full HD
- the width and height (200 to 4000 pixels; typing one switches to Responsive)
- **Rotate**, and the scale the page is shown at
- **Leave device mode**

## Screenshots

**Take screenshot of page** saves a PNG of the page as it's shown (at its device size, without the
toolbar or DevTools) in a `screenshots` folder inside the IDE's own folder in the project.

## Downloads

Files a page downloads show in the status bar while they run. Click the item, or run **Show
downloads**, for the downloads list: open a file, show it in its folder, or cancel a download
(cancelling is available on Windows). **Clear finished downloads** empties the list.

## The agent and the browser

The agent can look at the page, read its console and network requests, and click through it, and
it asks first. See [The agent](05-agent.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `browser.notifyOnServer` | `true` | When a terminal prints a local server's address, offer to open it |
| `browser.liveReload.onEdit` | `true` | Previews of workspace files update while you type; CSS applies without a reload |
| `browser.externalLinks` | `ide` | Where links and popups to other sites open: `ide` or `system` |
| `browser.embedSites` | `false` | Show other sites inside the tab (Windows and macOS) instead of their own window |

## Commands

| Command | Keys | What it does |
|---|---|---|
| Open browser | | Opens a browser tab |
| Go Live | | Previews the HTML file with live reload |
| Stop live preview | | Closes the live previews |
| Focus address bar | Ctrl+L | Puts the cursor in the address bar |
| Reload page | F5, Ctrl+R | Reloads the page |
| Back, Forward | | Moves through the tab's history |
| Toggle browser DevTools | F12, Ctrl+Shift+I | Shows or hides DevTools |
| Select an element in the page | Ctrl+Shift+C | Picks an element to inspect |
| Show page console | | Opens the Console |
| Device size | | Shows the page at a device's size |
| Take screenshot of page | | Saves a PNG of the page |
| Show downloads | | Opens the downloads list |
| Running servers | | Lists the servers terminals started and opens one |

## Next steps

- [Terminal](10-terminal.md): start the dev server, and open its address with Ctrl+click.
- [Tasks](12-tasks.md): run the dev server as a background task.
- [Debugging](13-debugging.md): set breakpoints in the page's scripts in Chrome or Edge.
- [Remote development](19-remote.md): forward a port from a remote machine and preview it here.

## Common questions

### A site opens in a separate window. Can it stay in the tab?

On Windows and macOS, turn on `browser.embedSites`. Local servers and workspace files always show
in the tab.

### My dev server's page doesn't reload when I save.

Hot reload is the dev server's own (Vite, webpack…); the IDE passes its WebSocket through. Check
the Console for errors. For plain HTML files, use **Go Live**, which reloads as you type.

### Links to another site open in the IDE. I want my usual browser.

Set `browser.externalLinks` to `system`, or click **Open in system browser** in the toolbar.
