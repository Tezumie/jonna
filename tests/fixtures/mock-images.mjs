// Image models for the mock (D381, agent-images-m7-110): an OpenAI-compatible provider under
// /img/v1 whose model draws (its model list says output_modalities image; a chat request with
// modalities answers with an image in `delta.images`, as OpenRouter's do) and an images API
// (/img/v1/images/generations, as OpenAI's gpt-image). And pkgimg, the chat's scripted turns that
// call generate_image and save_image.
import { deflateSync } from "node:zlib";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A `size`×`size` PNG: a diagonal of `a` and `b` (so a screenshot shows it's an image). */
export function mockPng(size, a, b) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) row.set(x + y < size ? a : b, 1 + x * 3);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const DRAWN = mockPng(384, [220, 60, 50], [240, 200, 60]);
const API_DRAWN = mockPng(384, [40, 110, 220], [250, 250, 250]);

/** Answers the image provider's routes; false for any other. */
export async function handleImages(req, res, body) {
  const url = req.url ?? "";
  if (!url.startsWith("/img/v1/")) return false;
  if (url === "/img/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "mock-drawer",
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["image", "text"],
            },
          },
          { id: "gpt-image-mock", architecture: { output_modalities: ["image"] } },
        ],
      }),
    );
    return true;
  }
  if (url === "/img/v1/images/generations") {
    const request = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        created: 1,
        data: [{ b64_json: API_DRAWN, revised_prompt: String(request.prompt ?? "") }],
      }),
    );
    return true;
  }
  if (url === "/img/v1/chat/completions") {
    const request = JSON.parse(body || "{}");
    const draws = Array.isArray(request.modalities) && request.modalities.includes("image");
    // Drawing takes a moment, so the test sees the placeholder.
    if (draws) await new Promise((done) => setTimeout(done, 2500));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    send({ role: "assistant", content: draws ? "Here is the picture." : "I can only draw." });
    if (draws)
      send({
        images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${DRAWN}` } }],
      });
    send({}, "stop");
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 30 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
    return true;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
  return true;
}

/**
 * pkgimg: "pkgimg generate" calls generate_image (saved to assets/red.png), "pkgimg save" saves img1 as
 * a JPEG with save_image; each then answers with the tool's result, so the test can read it.
 */
export function imagesScripted(messages, user) {
  if (!user.startsWith("pkgimg ")) return null;
  const turn = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  const result = turn.filter((m) => m.role === "tool").pop();
  if (result) return { text: `PkgImg: ${String(result.content).split("\n")[0]}` };
  if (user.includes("pkgimg generate"))
    return {
      tool: {
        name: "generate_image",
        arguments: { prompt: "A red and yellow square", path: "assets/red.png" },
      },
    };
  if (user.includes("pkgimg save"))
    return { tool: { name: "save_image", arguments: { image: "img1", path: "assets/red.jpg" } } };
  return null;
}
