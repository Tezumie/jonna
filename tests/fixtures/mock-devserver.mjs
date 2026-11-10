// A tiny stand-in for a dev server (Vite-like) for tests/scripts/browser.jsonc (and a git remote
// that asks for a sign-in, under /git/): an app page with a
// counter and a form, a 404 request, and a WebSocket at /hmr (answers "ping" with "pong") so the
// preview proxy's upgrade path is exercised. Usage: node mock-devserver.mjs [port] (default 11998).
// One port below it runs a second app, an "accounts server" (tests/scripts/browser-m7-6.jsonc,
// D209): links, redirects, a form and a sign-in popup that cross between the two ports.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 11998);
const accountsPort = port - 1;
const ACCOUNTS = `http://127.0.0.1:${accountsPort}`;

const CROSS = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cross</title></head>
<body>
<h1>Cross-port app</h1>
<p><a href="${ACCOUNTS}/account">Account</a></p>
<p><a href="/about" target="_blank">About in a new tab</a></p>
<p><a href="${ACCOUNTS}/account" target="_blank">Account in a new tab</a></p>
<p><a href="/to-accounts">Sign in by redirect</a></p>
<form method="post" action="${ACCOUNTS}/login">
  <label for="user">User</label><input id="user" name="user">
  <button>Sign in by form</button>
</form>
<button onclick="openPopup()">Sign in with a popup</button>
<p id="token">Token: none</p>
<p id="popup">Popup: none</p>
<script>
  let popup = null;
  function openPopup() {
    popup = window.open("${ACCOUNTS}/popup.html", "signin", "width=500,height=600");
    document.getElementById("popup").textContent = "Popup: " + (popup && !popup.closed ? "open" : "blocked");
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer);
        document.getElementById("popup").textContent = "Popup: closed";
      }
    }, 100);
  }
  window.addEventListener("message", (e) => {
    if (e.origin === "${ACCOUNTS}" && e.source === popup)
      document.getElementById("token").textContent = "Token: " + e.data.token;
  });
</script>
</body></html>`;

/**
 * Popups and forms between tabs (tests/scripts/browser-m7-12.jsonc): forms posted into a new tab,
 * a named tab reused, a popup that moves its opener, a popup's document read (a SecurityError), a
 * download, and a page streamed in two parts.
 */
const LAB = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lab</title></head>
<body>
<h1>Popup lab</h1>
<form method="post" action="${ACCOUNTS}/login" target="_blank">
  <label for="u2">Name for a new tab</label><input id="u2" name="user">
  <button>Post to a new tab</button>
</form>
<form method="post" action="/echo" target="_blank">
  <label for="msg">Message</label><input id="msg" name="message">
  <button>Post here in a new tab</button>
</form>
<p><a href="/about?first" target="helper">About in the helper tab</a></p>
<button onclick="window.open('/about?again', 'helper')">Open the helper tab</button>
<button onclick="window.open('/move-opener.html', 'mover')">Popup that moves me</button>
<button onclick="peek()">Read popup document</button>
<p id="peek">Peek: none</p>
<p><a href="/ide-ui-test-download.txt" download>Download a file</a></p>
<script>
  function peek() {
    const w = window.open("/about", "_blank");
    let seen = "no popup";
    if (w) {
      try {
        seen = w.document ? "allowed" : "empty";
      } catch (e) {
        seen = e.name;
      }
      w.close();
    }
    document.getElementById("peek").textContent = "Peek: " + seen;
  }
</script>
</body></html>`;

/** The second app: sets a cookie, reads it back, takes a form post and runs a sign-in popup. */
const accounts = createServer((req, res) => {
  const html = (body, headers = {}) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  if (req.url === "/account") {
    html(
      `<!doctype html><title>Account</title><h1>Account page</h1><a href="http://localhost:${port}/cross.html">Back to the app</a>`,
      { "set-cookie": "acct=yes; Path=/; HttpOnly" },
    );
  } else if (req.url === "/whoami") {
    html(`<!doctype html><title>Who</title><p>Cookie: ${req.headers.cookie ?? "none"}</p>`);
  } else if (req.url === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const user = new URLSearchParams(body).get("user") ?? "";
      html(
        `<!doctype html><title>Signed in</title><p>Signed in as ${user.replace(/[<&]/g, "")}</p>`,
      );
    });
  } else if (req.url === "/popup.html") {
    html(`<!doctype html><title>Sign in</title><p>Signing in</p><script>
      window.opener.postMessage({ token: "t0k" }, "http://localhost:${port}");
      setTimeout(() => window.close(), 300);
    </script>`);
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
// A connection reset mustn't end the mock (and every browser test after it).
accounts.on("clientError", (_err, s) => s.destroy());
accounts.listen(accountsPort, "127.0.0.1");

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dev app</title></head>
<body>
<h1>Counter</h1>
<p>Count: <span id="count">0</span></p>
<button id="inc" onclick="count.textContent = String(Number(count.textContent) + 1)">Increment</button>
<form id="f" onsubmit="event.preventDefault(); greeting.textContent = 'Welcome, ' + nameInput.value">
  <label for="nameInput">Your name</label>
  <input id="nameInput" name="name">
  <select id="color"><option value="r">Red</option><option value="g">Green</option></select>
</form>
<p id="greeting"></p>
<p id="ws">ws: waiting</p>
<a href="/about">About</a>
<script>
  console.warn("dev warning");
  fetch("/missing");
  const socket = new WebSocket("ws://" + location.host + "/hmr");
  socket.onopen = () => socket.send("ping");
  socket.onmessage = (e) => { document.getElementById("ws").textContent = "ws: " + e.data; };
</script>
</body></html>`;

/**
 * The agent's browser tools (tests/scripts/browser-agent-m7-58.jsonc, D316–D318): controls at
 * fixed places for input by coordinate (a button that counts clicks, double clicks and its context
 * menu, a field that logs keys, a drag source and a drop zone, a scroll box), a main element for
 * the page's text, and a dark scheme by media query. Everything sits in the top-left 330×210 px.
 */
/**
 * Files into a page (tests/scripts/browser-upload-m7-82.jsonc, D339): a single-file input and a
 * drop zone that say what they got (name, size, type); a click counter and a box that changes
 * color for the recording test (browser-gif-m7-83, D340).
 */
const UPLOAD_LAB = `<!doctype html>
<html><head><meta charset="utf-8"><title>Upload lab</title>
<style>
  body { margin: 16px; font: 14px sans-serif; }
  #zone { width: 260px; height: 80px; border: 2px dashed gray; margin: 12px 0; }
  #box { width: 60px; height: 30px; background: silver; }
</style></head>
<body>
  <label>Photo <input type="file" id="photo"></label>
  <p id="out">nothing yet</p>
  <div id="zone">Drop files here</div>
  <p id="dropped">nothing dropped</p>
  <button id="count" type="button">Count 0</button>
  <div id="box"></div>
<script>
  const list = (files) => [...files].map((f) => f.name + " " + f.size + " " + f.type).join(", ");
  const photo = document.getElementById("photo");
  photo.addEventListener("change", () => {
    document.getElementById("out").textContent = list(photo.files);
  });
  const zone = document.getElementById("zone");
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    document.getElementById("dropped").textContent = list(e.dataTransfer.files);
  });
  let n = 0;
  document.getElementById("count").addEventListener("click", (e) => {
    n++;
    e.target.textContent = "Count " + n;
    document.getElementById("box").style.background = n % 2 ? "teal" : "orange";
  });
</script>
</body></html>`;

/**
 * Trusted input (tests/scripts/browser-trusted-m7-90.jsonc, D346): the page records whether each
 * click, key and input event was a person's (event.isTrusted) and shows it, as pages that ignore
 * script-made events do.
 */
const TRUSTED_LAB = `<!doctype html>
<html><head><meta charset="utf-8"><title>Trusted lab</title>
<style>
  body { margin: 16px; font: 14px sans-serif; }
  button, input { display: block; margin: 12px 0; font: inherit; }
</style></head>
<body>
  <button id="hit" type="button">Press me</button>
  <input id="field" aria-label="Field">
  <p id="clicks">clicks: none</p>
  <p id="keys">keys: none</p>
  <p id="inputs">inputs: none</p>
<script>
  const seen = { clicks: [], keys: [], inputs: [] };
  const show = (kind) => {
    document.getElementById(kind).textContent = kind + ": " + seen[kind].join(" ");
  };
  document.getElementById("hit").addEventListener("click", (e) => {
    seen.clicks.push(String(e.isTrusted));
    show("clicks");
  });
  document.getElementById("field").addEventListener("keydown", (e) => {
    seen.keys.push(e.key + "=" + e.isTrusted);
    show("keys");
  });
  document.getElementById("field").addEventListener("input", (e) => {
    seen.inputs.push(String(e.isTrusted));
    show("inputs");
  });
  window.trustedLab = seen;
</script>
</body></html>`;

const AGENT_LAB = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent lab</title>
<style>
  body { margin: 0; background: rgb(255, 255, 255); color: rgb(0, 0, 0); font: 14px sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: rgb(20, 20, 20); color: rgb(240, 240, 240); } }
  .at { position: absolute; box-sizing: border-box; margin: 0; }
  #btn { left: 10px; top: 10px; width: 140px; height: 36px; }
  #field { left: 160px; top: 10px; width: 160px; height: 30px; }
  #item { left: 10px; top: 60px; width: 80px; height: 30px; background: rgb(200, 200, 200); }
  #drop { left: 160px; top: 60px; width: 160px; height: 60px; border: 1px dashed rgb(120, 120, 120); }
  #box { left: 10px; top: 130px; width: 150px; height: 80px; overflow: auto; border: 1px solid rgb(120, 120, 120); }
  main { position: absolute; left: 10px; top: 230px; width: 400px; }
</style></head>
<body>
<button id="btn" class="at">Count clicks</button>
<input id="field" class="at" aria-label="Lab field">
<div id="item" class="at" draggable="true">Drag me</div>
<div id="drop" class="at">Drop here</div>
<div id="box" class="at"><div style="height: 1000px">Scroll inside</div></div>
<main>
<h1>Agent lab</h1>
<p>The lab page is where the agent's input tools are tried out: clicks by coordinate, keys with
modifiers, typing at the focus, dragging, scrolling a box, the page's text, scripts and the
dark color scheme. This paragraph is long enough to be the page's main content.</p>
<p id="log">clicks=0</p>
</main>
<script>
  const lab = { clicks: 0, double: "no", menu: "no", key: "none", dropped: "no" };
  const show = () => {
    document.getElementById("log").textContent =
      "clicks=" + lab.clicks + " double=" + lab.double + " menu=" + lab.menu +
      " key=" + lab.key + " dropped=" + lab.dropped;
  };
  const btn = document.getElementById("btn");
  btn.addEventListener("click", () => { lab.clicks++; show(); });
  btn.addEventListener("dblclick", () => { lab.double = "yes"; show(); });
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); lab.menu = "yes"; show(); });
  document.getElementById("field").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { lab.key = (e.shiftKey ? "shift+" : "") + "Enter"; show(); }
  });
  document.getElementById("item").addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", "item"));
  const drop = document.getElementById("drop");
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => { e.preventDefault(); lab.dropped = "yes"; show(); });
</script>
</body></html>`;

// A git remote over HTTP that wants a sign-in (tests/scripts/git-m6-38.jsonc, askpass): the right
// credentials get "not found" (no repository here), anything else 401.
const GIT_AUTH = `Basic ${Buffer.from("tester:s3cret").toString("base64")}`;

/** The last notification posted to /pkgs-hook (D360). */
let lastHook = null;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/git/")) {
    if (req.headers.authorization === GIT_AUTH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such repository");
    } else {
      res.writeHead(401, {
        "www-authenticate": 'Basic realm="test"',
        "content-type": "text/plain",
      });
      res.end("sign in");
    }
  } else if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
    res.end(PAGE);
  } else if (req.url === "/debug.html") {
    // D196: a page to debug in a browser; debug.js is the site/debug.js the test writes.
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>Debug me</title><script src="/debug.js?v=1"></script>');
  } else if (req.url?.startsWith("/debug.js")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(
      'function plus(a, b) {\n  const sum = a + b;\n  return sum;\n}\nconsole.log("sum", plus(1, 2));\n',
    );
  } else if (req.url === "/mapped.html") {
    // A "built" script with a source map served beside it (read through debug_local_get); its
    // source is the site/mapped-src.js the test writes, line for line.
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>Mapped</title><script src="/mapped.js"></script>');
  } else if (req.url === "/mapped.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(
      'function mul(a, b) {\n  const product = a * b;\n  return product;\n}\nconsole.log("product", mul(2, 3));\n//# sourceMappingURL=/mapped.js.map\n',
    );
  } else if (req.url === "/mapped.js.map") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        version: 3,
        sources: ["mapped-src.js"],
        names: [],
        mappings: "AAAA;AACA;AACA;AACA;AACA",
      }),
    );
  } else if (req.url === "/trusted.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TRUSTED_LAB);
  } else if (req.url === "/upload.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(UPLOAD_LAB);
  } else if (req.url === "/agent-lab.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(AGENT_LAB);
  } else if (req.url === "/cross.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CROSS);
  } else if (req.url === "/lab.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LAB);
  } else if (req.url === "/pkgs-hook" && req.method === "POST") {
    // D360 (agent-phone-notify-m7-102): a webhook endpoint; GET /pkgs-hook/last shows what came.
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      lastHook = {
        contentType: req.headers["content-type"] ?? "",
        title: req.headers.title ?? "",
        body,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  } else if (req.url === "/pkgs-hook/last") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(lastHook ? `Last webhook: ${JSON.stringify(lastHook)}` : "Last webhook: none");
  } else if (req.url === "/echo" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const message = (new URLSearchParams(body).get("message") ?? "").replace(/[<&]/g, "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Echo</title><p>Posted: ${message}</p>`);
    });
  } else if (req.url === "/move-opener.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Mover</title><p>Moving the opener</p><script>
      window.opener.location.href = "http://localhost:${port}/about?moved";
      setTimeout(() => window.close(), 300);
    </script>`);
  } else if (req.url === "/ide-ui-test-download.txt") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="ide-ui-test-download.txt"',
    });
    res.end("A file the browser UI test downloads.");
  } else if (req.url === "/stream.html") {
    // The proxy passes HTML on as it comes: the first part runs before the second
    // arrives, 2.5 s later.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write(
      "<!doctype html><html><head><title>Stream</title></head><body><p>First part</p><script>window.t1 = performance.now();</script>",
    );
    setTimeout(() => {
      res.end(
        '<p id="s">Second part</p><script>document.getElementById("s").textContent = "Streamed: " + (performance.now() - window.t1 > 1500 ? "yes" : "no");</script></body></html>',
      );
    }, 2500);
  } else if (req.url === "/to-accounts") {
    res.writeHead(302, { location: `${ACCOUNTS}/account` });
    res.end();
  } else if (req.url === "/about" || req.url?.startsWith("/about?")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>About</title><h1>About this app</h1><a href='/'>Home</a>");
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

/** One unfragmented text frame (server → client: unmasked). */
const frame = (text) => {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

/**
 * pkgG (agent-bgtasks-m7-71, D328): a WebSocket a monitor watches. Two text frames (the second
 * spans two lines) and a 5-byte binary frame together, then a close (1000, "pkgg done") a while
 * later, so the frames' message is answered before the close's.
 */
function pkggEvents(req, socket) {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const timers = [
    setTimeout(() => {
      socket.write(frame("pkgg-frame one"));
      socket.write(frame("pkgg-frame two\nsecond line"));
      socket.write(Buffer.from([0x82, 5, 1, 2, 3, 4, 5]));
    }, 1000),
    setTimeout(() => {
      const reason = Buffer.from("pkgg done");
      socket.write(Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x03, 0xe8]), reason]));
      socket.end();
    }, 4500),
  ];
  socket.on("close", () => {
    for (const t of timers) clearTimeout(t);
  });
}

server.on("upgrade", (req, socket) => {
  // A page closed mid-connection resets the socket: without a handler that ended the whole mock
  // (and every browser test after it, D228).
  socket.on("error", () => socket.destroy());
  if (req.url === "/pkgg-events") return pkggEvents(req, socket);
  if (req.url !== "/hmr") return socket.destroy();
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", (buf) => {
    // Client frames are masked: [0x81, 0x80|len, mask×4, payload].
    if ((buf[0] & 0x0f) !== 1) return;
    const len = buf[1] & 0x7f;
    const mask = buf.subarray(2, 6);
    const data = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
    if (data === "ping") socket.write(frame("pong"));
  });
});

server.on("clientError", (_err, s) => s.destroy());
server.listen(port, "127.0.0.1", () => process.stderr.write(`mock-devserver on ${port}\n`));
