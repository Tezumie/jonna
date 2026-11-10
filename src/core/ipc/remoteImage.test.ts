import assert from "node:assert/strict";
import { test } from "node:test";
import { sniffImage } from "./remoteImage";

const bytes = (...v: number[]) => new Uint8Array(v);
const text = (s: string) => new TextEncoder().encode(s);

test("sniffImage knows the usual pictures", () => {
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)), "image/png");
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffImage(text("GIF89a")), "image/gif");
  assert.equal(sniffImage(text("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(text("\0\0\0\x1cftypavif")), "image/avif");
  assert.equal(sniffImage(text('<?xml version="1.0"?>\n<svg xmlns="x">')), "image/svg+xml");
});

test("sniffImage refuses anything else", () => {
  assert.equal(sniffImage(text("<!doctype html><html>")), null);
  assert.equal(sniffImage(text('{"error":1}')), null);
  assert.equal(sniffImage(text("\0\0\0\x1cftypmp42")), null);
});
