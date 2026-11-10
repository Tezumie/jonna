# extensions/dev

Dev builds only (`__DEV__`). `dev.dumpState` (budgeted state tree → console + read-only tab),
`dev.perfReport` (startup timings), `dev.liveDisposables`, `dev.reload`, `dev.inspectDom`
(computed style and HTML of matching elements), `dev.click` (press an element, or with `hover` only point at it,
at fraction `x` of its width: UI tests of engine widgets), `dev.setWindowSize` (small-window tests), `dev.type` (type into an input, press or release keys with `code` and modifiers, so
keybindings resolve: UI tests of pickers), `dev.setValue` (set a field's value and fire input and
change), `dev.scroll` (set an element's scrollTop); state `ide://dev/keyboard`
(last key presses, how they resolved, all context keys).

Checks: `dev.openIframeTest` (`iframeTest.ts`: a tab hosting an iframe through the iframe layer;
`ide://dev/iframes` counts how often each loaded) and `dev.checkLayoutOverflow` (`layoutCheck.ts`:
many tabs in one group at 640×480; the document must stay inside the window).
