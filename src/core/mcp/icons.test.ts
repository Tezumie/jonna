// MCP icons (serverInfo.icons, server.json icons): only data: pictures and https addresses, SVG
// checked like the ACP registry's, and the one to show for the theme and size.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIcon, parseIcons, pickIcon } from "./icons";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(body)}`;

test("icons kept: data: pictures and https addresses", () => {
  assert.deepEqual(parseIcon({ src: PNG, sizes: ["16x16", "huge", 3] }), {
    src: PNG,
    mimeType: "image/png",
    sizes: ["16x16"],
  });
  assert.deepEqual(
    parseIcon({ src: "https://a.dev/i.webp", mimeType: "IMAGE/WEBP", theme: "dark" }),
    {
      src: "https://a.dev/i.webp",
      mimeType: "image/webp",
      theme: "dark",
    },
  );
  const mono = parseIcon({
    src: svg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0h1v1z"/></svg>',
    ),
  });
  assert.equal(mono?.mimeType, "image/svg+xml");
  assert.equal(mono?.mono, true);
  const b64 = parseIcon({
    src: `data:image/svg+xml;base64,${btoa('<svg><rect fill="#f00" width="1" height="1"/></svg>')}`,
  });
  assert.equal(b64?.mono, undefined);
  assert.ok(b64?.src.startsWith("data:image/svg+xml"));
});

test("icons left out: other schemes, scripts in SVG, credentials, non-images, too big", () => {
  for (const src of [
    "http://a.dev/i.png",
    "file:///C:/x.png",
    "javascript:alert(1)",
    "https://user:pw@a.dev/i.png",
    "data:text/html;base64,PGI+",
    svg("<svg><script>alert(1)</script></svg>"),
    svg('<svg onload="alert(1)"></svg>'),
    svg('<svg><image href="https://track.dev/x"/></svg>'),
    `data:image/png;base64,${"A".repeat(300 * 1024)}`,
  ])
    assert.equal(parseIcon({ src }), null, src);
  assert.equal(parseIcon({ src: "https://a.dev/x", mimeType: "text/html" }), null);
  assert.equal(parseIcon("https://a.dev/i.png"), null);
  assert.deepEqual(parseIcons("nope"), []);
  assert.equal(parseIcons(Array.from({ length: 20 }, () => ({ src: PNG }))).length, 8);
});

test("the icon picked: the theme's, then scalable, then the smallest big enough", () => {
  const small = { src: "https://a.dev/16.png", sizes: ["16x16"] };
  const mid = { src: "https://a.dev/64.png", sizes: ["64x64"] };
  const big = { src: "https://a.dev/512.png", sizes: ["512x512"] };
  const light = { src: "https://a.dev/l.svg", mimeType: "image/svg+xml", theme: "light" as const };
  assert.equal(pickIcon([small, big, mid], "dark")?.src, mid.src);
  assert.equal(pickIcon([small], "dark")?.src, small.src);
  assert.equal(pickIcon([mid, light], "light")?.src, light.src);
  assert.equal(pickIcon([mid, light], "dark")?.src, mid.src);
  // Only icons for the other theme: one of them rather than none.
  assert.equal(pickIcon([light], "dark")?.src, light.src);
  // As good: the data: one (nothing to fetch).
  assert.equal(pickIcon([{ src: "https://a.dev/x.png" }, { src: PNG }], "dark")?.src, PNG);
  assert.equal(pickIcon([], "dark"), null);
});
