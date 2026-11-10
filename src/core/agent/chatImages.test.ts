import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatImages,
  findChatImage,
  imageExt,
  imageFileName,
  imageNote,
  mimeForPath,
  nextImageId,
} from "./chatImages";
import { type Item, toMessages } from "./conversation";

const items: Item[] = [
  { type: "user", id: "u1", text: "draw a cat" },
  {
    type: "assistant",
    id: "a1",
    text: "Here it is.",
    thinking: "",
    streaming: false,
    media: [{ id: "img1", mime: "image/png", data: "AAAA" }],
  },
  {
    type: "tool",
    id: "t1",
    callId: "c1",
    name: "generate_image",
    args: { prompt: "a dog" },
    status: "done",
    result: "Made an image.",
    media: [{ id: "img4", mime: "image/webp", data: "BBBB", name: "dog.webp" }],
  },
];

test("chat images: listed oldest first, ids never reused", () => {
  assert.deepEqual(
    chatImages(items).map((i) => i.id),
    ["img1", "img4"],
  );
  // After img4, even with img2 and img3 gone.
  assert.equal(nextImageId(items), "img5");
  assert.equal(nextImageId([]), "img1");
});

test("chat images: found by id or number", () => {
  assert.equal(findChatImage(items, "img4")?.mime, "image/webp");
  assert.equal(findChatImage(items, "1")?.id, "img1");
  assert.equal(findChatImage(items, " IMG1 ")?.id, "img1");
  assert.equal(findChatImage(items, "img9"), undefined);
});

test("chat images: extensions and file names", () => {
  assert.equal(imageExt("image/jpeg"), "jpg");
  assert.equal(imageExt("image/svg+xml"), "svg");
  assert.equal(imageExt("application/octet-stream"), "png");
  assert.equal(mimeForPath("assets/logo.JPEG"), "image/jpeg");
  assert.equal(mimeForPath("a/b.webp"), "image/webp");
  assert.equal(mimeForPath("notes.txt"), null);
  assert.equal(mimeForPath("Makefile"), null);
  assert.equal(imageFileName({ id: "img1", mime: "image/png" }), "img1.png");
  assert.equal(imageFileName({ id: "img4", mime: "image/webp", name: "dog.webp" }), "dog.webp");
});

test("chat images: the model is told their ids, in the reply and the tool's result", () => {
  assert.equal(imageNote([]), "");
  const messages = toMessages(items, { textProtocol: false, budgetChars: 1e6 });
  const reply = messages.find((m) => m.role === "assistant");
  assert.match(reply?.content ?? "", /Here it is\.[\s\S]*img1 \(png\)[\s\S]*save_image/);
  const tool = messages.find((m) => m.role === "tool");
  assert.match(tool?.content ?? "", /Made an image\.[\s\S]*img4 \(webp\)/);
});
