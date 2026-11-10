import assert from "node:assert/strict";
import { test } from "node:test";
import { listChatAttachments, missingImagesNote } from "./chatAttachments";
import type { Item } from "./conversation";

const user = (extra: Record<string, unknown>): Item =>
  ({ type: "user", id: "u", text: "hi", ...extra }) as unknown as Item;

test("lists attachments per user message, with what's still available", () => {
  const items = [
    user({
      attachments: [
        { kind: "image", name: "shot.png" },
        { kind: "text", name: "notes.md", text: "# Notes" },
      ],
      previews: ["data:image/webp;base64,AAAA"],
    }),
    user({ auto: "verify", attachments: [{ kind: "text", name: "x", text: "y" }] }),
    user({ attachments: [{ kind: "image", name: "live.png" }], images: ["iVBOR"] }),
  ];
  const list = listChatAttachments(items);
  assert.deepEqual(
    list.map((a) => [a.id, a.name, a.content]),
    [
      ["m1-1", "shot.png", "preview"],
      ["m1-2", "notes.md", "text"],
      ["m2-1", "live.png", "image"],
    ],
  );
  assert.equal(list[2]?.data, "iVBOR");
});

test("pasted images without cards still get entries", () => {
  const list = listChatAttachments([user({ previews: ["data:a", "data:b"] })]);
  assert.deepEqual(
    list.map((a) => a.id),
    ["m1-img1", "m1-img2"],
  );
});

test("the history note appears only when the images are gone", () => {
  assert.match(
    missingImagesNote(user({ attachments: [{ kind: "image", name: "a.png" }], previews: ["p"] })) ??
      "",
    /attached 1 image here: a\.png.*chat_attachments/,
  );
  assert.equal(
    missingImagesNote(user({ attachments: [{ kind: "image", name: "a.png" }], images: ["x"] })),
    null,
  );
  assert.equal(missingImagesNote(user({})), null);
});
