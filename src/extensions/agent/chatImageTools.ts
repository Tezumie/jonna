// Images the agent makes and keeps (D381). `save_image` puts a chat image (one a model drew, an MCP
// tool's, generate_image's, or one the user attached) into the project as a file, converting it
// when the file's extension asks for another format. `generate_image` makes one with an image
// model: agent.imageGeneration.model, else the chat's own model when it draws, else a listed model
// that draws, else OpenAI's gpt-image-1 when an OpenAI provider is set up. OpenAI's image models
// go through the images API; the others (OpenRouter's Gemini, GPT-5 image…) answer a chat request
// that asks for images.

import { listChatAttachments } from "../../core/agent/chatAttachments";
import {
  type ChatImage,
  findChatImage,
  imageExt,
  imageFileName,
  mimeForPath,
} from "../../core/agent/chatImages";
import type { Item } from "../../core/agent/conversation";
import type { ToolOutcome } from "../../core/agent/loop";
import { fromBase64, toBase64 } from "../../core/extensions/rpcAuthFs";
import { agentStoreIpc, aiIpc, type ProviderRef } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import type { WorkbenchServices } from "../../workbench/services";
import type { ProviderRegistry } from "./providers";
import { type AgentTool, toolWriteTarget } from "./tools";

/** An image's bytes: base64 `data` of type `mime`. */
export interface ImageBytes {
  mime: string;
  data: string;
  /** Only a reduced copy is left (a user's attachment after a restart). */
  reduced?: boolean;
}

/** A data: URL's type and base64 bytes, or null. */
function parseDataUrl(url: string): ImageBytes | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1] ?? "image/png", data: m[2] ?? "" } : null;
}

/** A chat image's whole bytes: in memory, else from the chat's media folder, else its preview. */
export async function chatImageBytes(chat: string, img: ChatImage): Promise<ImageBytes | null> {
  if (img.data) return { mime: img.mime, data: img.data };
  if (img.stored) {
    const kept = await agentStoreIpc.mediaGet(chat, img.id).catch(() => null);
    if (kept) return { mime: img.mime, data: kept };
  }
  const preview = img.preview ? parseDataUrl(img.preview) : null;
  return preview ? { ...preview, reduced: true } : null;
}

/**
 * The image `id` names in the chat: a chat image ("img3") or a user's attachment ("m2-1", as
 * chat_attachments lists them). Null when there's none (or it wasn't kept).
 */
export async function imageById(
  chat: string,
  items: readonly Item[],
  id: string,
): Promise<(ImageBytes & { name: string }) | null> {
  const img = findChatImage(items, id);
  if (img) {
    const bytes = await chatImageBytes(chat, img);
    return bytes && { ...bytes, name: imageFileName(img) };
  }
  const a = listChatAttachments(items).find((x) => x.id === id.trim() && x.kind === "image");
  if (!a?.data) return null;
  if (a.content === "image") return { mime: "image/png", data: a.data, name: a.name };
  const preview = parseDataUrl(a.data);
  return preview && { ...preview, reduced: true, name: a.name };
}

/**
 * The image redrawn as `to` (PNG, JPEG, WebP), through a canvas. An SVG is drawn at its own size
 * (or 1024 px when it has none). JPEG gets a white background (it has no transparency).
 */
export async function convertImage(img: ImageBytes, to: string): Promise<string> {
  if (to === "image/svg+xml") throw new Error("a picture can't be turned into an SVG drawing");
  const url = URL.createObjectURL(new Blob([fromBase64(img.data) as BlobPart], { type: img.mime }));
  try {
    const el = new Image();
    el.src = url;
    await el.decode();
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth || 1024;
    canvas.height = el.naturalHeight || 1024;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas to draw it on");
    if (to === "image/jpeg") {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, to, 0.92));
    // A browser that can't write the type gives a PNG instead: refuse rather than misname it.
    if (!blob || blob.type !== to) throw new Error(`${imageExt(to)} can't be written here`);
    return toBase64(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const exists = (path: string) =>
  fsIpc.stat(path).then(
    () => true,
    () => false,
  );

/** "24 KB" */
function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Writes `img` at `path` (in the project), converted when the extension asks for another format.
 * Refuses an existing file unless `overwrite`. The outcome's text says what happened.
 */
async function writeImage(
  host: Parameters<AgentTool["run"]>[1],
  img: ImageBytes,
  path: unknown,
  overwrite: boolean,
): Promise<ToolOutcome> {
  const target = toolWriteTarget(host, path);
  if ("refusal" in target) return { result: target.refusal, isError: true, summary: "refused" };
  const want = mimeForPath(target.abs);
  if (!want)
    return {
      result: `${target.name} has no image extension: end the path with .png, .jpg, .webp, .gif or .svg (.${imageExt(img.mime)} keeps it as it is).`,
      isError: true,
      summary: "no image extension",
    };
  if (!overwrite && (await exists(target.abs)))
    return {
      result: `${target.name} already exists. Pick another path, or pass overwrite: true to replace it.`,
      isError: true,
      summary: "exists",
    };
  let data = img.data;
  const same = want === img.mime || (want === "image/jpeg" && img.mime === "image/jpg");
  if (!same) {
    try {
      data = await convertImage(img, want);
    } catch (err) {
      return {
        result: `It's ${imageExt(img.mime)}, and ${err instanceof Error ? err.message : String(err)}: save it as .${imageExt(img.mime)}.`,
        isError: true,
        summary: "can't convert",
      };
    }
  }
  const bytes = fromBase64(data);
  await fsIpc.write(target.abs, bytes, "agent");
  const converted = same ? "" : ` (converted from ${imageExt(img.mime)})`;
  const reduced = img.reduced ? " Only a reduced copy was left, so that's what was saved." : "";
  return {
    result: `Saved ${target.name}, ${size(bytes.length)}${converted}.${reduced}`,
    summary: `${target.name} · ${size(bytes.length)}`,
  };
}

export function saveImageTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "save_image",
      description:
        'Save an image from this chat into the project as a file: one you or a tool made (ids like "img3", given where it was shown) or one the user attached ("m2-1", see chat_attachments). The extension picks the format (.png, .jpg, .webp; an SVG stays .svg); a different one is converted. Won\'t replace an existing file unless overwrite is true.',
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: 'The image\'s id ("img3" or "m2-1")' },
          path: {
            type: "string",
            description: "Where, relative to the project (assets/logo.png)",
          },
          overwrite: { type: "boolean", description: "Replace a file that's there" },
        },
        required: ["image", "path"],
      },
    },
    readOnly: false,
    verb: "Saved image",
    target: (a) => String(a.path ?? ""),
    async run(args, host) {
      const id = typeof args.image === "string" ? args.image.trim() : "";
      if (!id) return { result: '"image" is required (an id like "img3").', isError: true };
      const img = await imageById(host.session, items(), id);
      if (!img)
        return {
          result: `No image ${id} in this chat (or it wasn't kept). Images get ids like img3 where they're shown; the user's attachments are listed by chat_attachments.`,
          isError: true,
          summary: "not found",
        };
      return writeImage(host, img, args.path, args.overwrite === true);
    },
  };
}

/** OpenAI's image models: the images API, not a chat request. */
export function usesImagesApi(model: string): boolean {
  return /(^|\/)(gpt-image|dall-e|chatgpt-image)/i.test(model);
}

interface ImageModel {
  provider: ProviderRef & { name?: string };
  model: string;
}

/**
 * The model generate_image uses: the setting ("provider/model"), else the chat's own model when it
 * draws, else a listed model that draws (the chat's provider first), else gpt-image-1 on an
 * OpenAI provider. Null when nothing can draw.
 */
export function imageModel(
  services: WorkbenchServices,
  providers: ProviderRegistry,
  chatModel: string | null,
): ImageModel | null {
  const setting = services.settings.peek<string>("agent.imageGeneration.model")?.trim() ?? "";
  const all = providers.providers();
  if (setting) {
    const listed = providers.find(setting);
    if (listed) return { provider: listed.provider, model: listed.model };
    // Not in the list (an images-only model some providers don't list): "<provider>/<model>".
    const slash = setting.indexOf("/");
    const provider = all.find((p) => p.id === setting.slice(0, slash));
    if (provider && slash > 0) return { provider, model: setting.slice(slash + 1) };
  }
  const chat = chatModel ? providers.find(chatModel) : undefined;
  if (chat?.info.outputImages) return { provider: chat.provider, model: chat.model };
  const drawing = providers.models.peek().filter((m) => m.info.outputImages);
  const pick = drawing.find((m) => m.provider.id === chat?.provider.id) ?? drawing[0];
  if (pick) return { provider: pick.provider, model: pick.model };
  const openai = all.find((p) => /api\.openai\.com/.test(p.baseUrl));
  return openai ? { provider: openai, model: "gpt-image-1" } : null;
}

const NO_IMAGE_MODEL =
  'No model that makes images is set up. Tell the user how: add OpenRouter as a provider (its image models, such as google/gemini-2.5-flash-image, then work) or OpenAI (gpt-image-1), with "Agent: Set API key", and optionally pick one in the setting agent.imageGeneration.model. Meanwhile you can still draw an SVG and write it with write_file.';

/** Runs `work` with `requestId` cancelled when the turn is stopped. */
async function cancellable<T>(
  requestId: string,
  stopped: () => boolean,
  work: Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    if (stopped()) void aiIpc.cancel(requestId).catch(() => {});
  }, 400);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/** Images from a chat model that draws: the prompt (and reference images) as one message. */
async function drawWithChat(
  requestId: string,
  target: ImageModel,
  prompt: string,
  references: string[],
): Promise<{ images: ImageBytes[]; text: string }> {
  const images: ImageBytes[] = [];
  let text = "";
  await aiIpc.chat(
    requestId,
    {
      provider: target.provider,
      model: target.model,
      messages: [
        { role: "user", content: prompt, ...(references.length && { images: references }) },
      ],
      modalities: ["image", "text"],
      noCache: true,
    },
    (e) => {
      if (e.kind === "image" && e.data) images.push({ mime: e.mime, data: e.data });
      // A link instead of the bytes isn't fetched (no network loading): the model gets it.
      else if (e.kind === "image" && e.url) text += `\n${e.url}`;
      else if (e.kind === "text") text += e.text;
    },
  );
  return { images, text: text.trim() };
}

let nextRequest = 0;

export function generateImageTool(
  services: WorkbenchServices,
  providers: ProviderRegistry,
  chat: (session: string) => { model: string | null; items: readonly Item[] } | null,
): AgentTool {
  return {
    spec: {
      name: "generate_image",
      description:
        "Make an image (a picture, illustration, icon, photo-like scene, texture) with an image model, from a detailed description. It's shown in the chat with an id (img3); with `path` it's also saved into the project (or save it later with save_image). `reference_images`: ids of chat images or attachments to work from (edit this, in this style), where the model takes images. For diagrams, logos and icons that should stay sharp at any size, prefer writing an SVG with write_file.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to draw: subject, style, colors, composition, any text in it",
          },
          size: {
            type: "string",
            description:
              'Size or shape, e.g. "1024x1024", "1536x1024" (landscape), "1024x1536" (portrait)',
          },
          path: {
            type: "string",
            description: "Also save it here, relative to the project (assets/hero.png)",
          },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description: 'Images to start from: "img3", "m2-1"',
          },
        },
        required: ["prompt"],
      },
    },
    readOnly: false,
    verb: "Generated image",
    target: (a) => String(a.prompt ?? "").slice(0, 80),
    async run(args, host, itemId) {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return { result: '"prompt" is required (a description).', isError: true };
      const session = chat(host.session);
      await providers.refreshIfStale(60_000, 3000);
      const target = imageModel(services, providers, session?.model ?? null);
      if (!target) return { result: NO_IMAGE_MODEL, isError: true, summary: "no image model" };
      const size = typeof args.size === "string" ? args.size.trim() : "";
      const refIds = Array.isArray(args.reference_images)
        ? args.reference_images.filter((x): x is string => typeof x === "string")
        : [];
      const references: string[] = [];
      for (const id of refIds) {
        const ref = await imageById(host.session, session?.items ?? host.items?.() ?? [], id);
        if (!ref)
          return { result: `No image ${id} in this chat.`, isError: true, summary: "not found" };
        // Models take PNG (what the chat's images are sent as).
        references.push(ref.mime === "image/png" ? ref.data : await convertImage(ref, "image/png"));
      }
      host.output(itemId, `${target.provider.name ?? target.provider.id} · ${target.model}\n`);
      const requestId = `img-${Date.now()}-${nextRequest++}`;
      let images: ImageBytes[];
      let note = "";
      let said = "";
      try {
        if (usesImagesApi(target.model)) {
          if (references.length)
            note = " (the images API was given the description only, not the reference images)";
          images = await cancellable(
            requestId,
            () => host.cancelled(),
            aiIpc.generateImage(requestId, {
              provider: target.provider,
              model: target.model,
              prompt,
              ...(size && { size }),
            }),
          );
        } else {
          const drawn = await cancellable(
            requestId,
            () => host.cancelled(),
            drawWithChat(
              requestId,
              target,
              size ? `${prompt}\n\n(Size or aspect: ${size}.)` : prompt,
              references,
            ),
          );
          images = drawn.images;
          if (drawn.text) said = `\n\nThe image model said: ${drawn.text.slice(0, 1000)}`;
        }
      } catch (err) {
        if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
        return {
          result: `${target.model} couldn't make the image: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          summary: "failed",
        };
      }
      if (!images.length)
        return {
          result: `${target.model} answered without an image.${said}`,
          isError: true,
          summary: "no image",
        };
      const media = images.map((img) => ({
        ...img,
        source: target.model,
        ...(typeof args.path === "string" && args.path.trim() && { name: baseName(args.path) }),
      }));
      let saved = "";
      if (typeof args.path === "string" && args.path.trim()) {
        const first = images[0] as ImageBytes;
        const out = await writeImage(host, first, args.path, false);
        saved = out.isError ? ` It wasn't saved: ${out.result}` : ` ${out.result}`;
      }
      return {
        result: `Made ${images.length === 1 ? "an image" : `${images.length} images`} with ${target.model}${note}.${saved}${said}`,
        summary: `${target.model}${images.length > 1 ? ` · ${images.length} images` : ""}`,
        media,
      };
    },
  };
}

function baseName(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? path;
}
