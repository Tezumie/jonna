// Attaching files to agent messages (D131): the + button's "Upload from computer…" (system
// picker, any folder), files dropped onto the chat from the OS, pasted images and files, and
// big pastes. Files inside the open folder stay project files (paths, read when sending); the
// rest is read now and carried as text or as an image.
import {
  decodeText,
  imageMime,
  imageUpload,
  isImageName,
  MAX_UPLOADS,
  textUpload,
  type Upload,
  uploadBytes,
  uploadFileName,
} from "../../core/agent/attachments";
import { isZipName, looksLikeZip, zipAsText } from "../../core/agent/zip";
import { attachIpc, type OutsideFile } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

/**
 * An image as base64 PNG, at most 1568 px on its longer side (what vision models use anyway; a
 * bigger image costs more tokens for nothing). Null if it can't be read.
 */
export async function pngBase64(file: Blob): Promise<string | null> {
  try {
    const image = await decodeImage(file);
    if (!image) return null;
    const scale = Math.min(1, 1568 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")?.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    image.close();
    const url = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1) || null;
  } catch {
    return null;
  }
}

/**
 * Decodes an image blob. WebView2 refuses some blobs in createImageBitmap that an <img> shows
 * (seen with a small PNG read from disk), so that's the fallback.
 */
async function decodeImage(file: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
} | null> {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) return null;
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * One file's bytes → an upload (image or text), or a reason it can't be attached. A zip becomes
 * its file list and text files, with `path` (when it has one) so the agent can extract it.
 */
async function toUpload(
  name: string,
  bytes: Uint8Array,
  mime = "",
  path?: string,
): Promise<Upload | string> {
  if (isZipName(name) && looksLikeZip(bytes)) {
    try {
      return textUpload(name, (await zipAsText(name, bytes, path)).text);
    } catch {
      return `"${name}" couldn't be read as a zip archive.`;
    }
  }
  if (mime.startsWith("image/") || isImageName(name)) {
    const png = await pngBase64(
      new Blob([bytes as BlobPart], { type: mime || imageMime(name) || "image/png" }),
    );
    return png ? imageUpload(name, png) : `"${name}" couldn't be read as an image.`;
  }
  const text = decodeText(bytes);
  return text === null
    ? `"${name}" isn't a text file: only images, zips and text or code files can be attached.`
    : textUpload(name, text);
}

/**
 * A sent attachment as a file (D211): its name (the extension matching the bytes: a saved preview
 * is WebP or JPEG, not the PNG the name says) and bytes.
 */
export function attachmentFile(a: { name: string; kind: "image" | "text"; data: string }): {
  name: string;
  bytes: Uint8Array;
} {
  const name = uploadFileName({ kind: a.kind, name: a.name, data: a.data });
  if (a.kind === "image") {
    const mime = /^data:image\/([a-z0-9+.-]+)[;,]/i.exec(a.data)?.[1]?.toLowerCase();
    const ext = mime === "jpeg" ? "jpg" : mime === "svg+xml" ? "svg" : mime;
    const fixed =
      ext && !new RegExp(`\\.${ext}$`, "i").test(name)
        ? name.replace(/(\.[^.]+)?$/, `.${ext}`)
        : name;
    return { name: fixed, bytes: uploadBytes({ kind: "image", data: a.data }) };
  }
  return { name, bytes: uploadBytes({ kind: "text", data: a.data }) };
}

/** Adds uploads to a session, at most MAX_UPLOADS in all; returns what was refused. */
export function addUploads(session: AgentSession, added: Upload[]): string[] {
  const room = MAX_UPLOADS - session.uploads.peek().length;
  session.uploads.value = [...session.uploads.peek(), ...added.slice(0, Math.max(0, room))];
  return added.length > room ? [`At most ${MAX_UPLOADS} attachments per message.`] : [];
}

/** Files from the browser (pasted or dragged in by the webview itself). */
export async function uploadsFromFiles(files: readonly File[]): Promise<{
  uploads: Upload[];
  problems: string[];
}> {
  const uploads: Upload[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) {
      problems.push(`"${f.name}" is too large to attach (20 MB max).`);
      continue;
    }
    const u = await toUpload(f.name || "image.png", new Uint8Array(await f.arrayBuffer()), f.type);
    if (typeof u === "string") problems.push(u);
    else uploads.push(u);
  }
  return { uploads, problems };
}

export function registerUploadCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, notifications, workspace } = services;
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  const attachmentInput = s.object({
    name: s.string(),
    kind: s.enum(["image", "text"] as const),
    data: s.string().describe("Base64 PNG, an image data: URL, or the text"),
  });
  const target = (id: string | undefined) =>
    id ? sessions.get(id) : (sessions.find(undefined) ?? sessions.get());

  /** Project files become paths; the rest is read through Rust (dropped / picked list). */
  const attach = async (session: AgentSession, files: OutsideFile[]) => {
    const root = workspace.root.peek();
    const inside: string[] = [];
    const uploads: Upload[] = [];
    const problems: string[] = [];
    for (const [index, f] of files.entries()) {
      if (f.isDir) {
        problems.push(`"${f.name}" is a folder: attach the files in it.`);
        continue;
      }
      // Project files stay paths (read when sending); images and zips are always read.
      // D251: a file of any folder of the workspace is a project file.
      if (root && workspace.contains(f.path) && !isImageName(f.name) && !isZipName(f.name)) {
        inside.push(f.path);
        continue;
      }
      try {
        const u = await toUpload(f.name, await attachIpc.read(index), "", f.path);
        if (typeof u === "string") problems.push(u);
        else uploads.push(u);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (inside.length)
      await dispatcher.execute("agent.addContext", { paths: inside, session: session.id });
    problems.push(...addUploads(session, uploads));
    if (problems.length) notifications.show("warning", problems.slice(0, 3).join(" "));
    return { session: session.id, files: inside.length + uploads.length };
  };

  sub.add(
    dispatcher.register({
      id: "agent.attachFiles",
      title: "Attach files to chat…",
      category: "Agent",
      description:
        "Picks files anywhere on the computer with the system dialog and attaches them to the next agent message (text and code files as text, images as images). Files in the open folder are attached as project files.",
      input: s.object({
        session: sessionInput,
        paths: s
          .array(s.string())
          .describe("Debug builds only: the files (relative to the folder)")
          .optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ session, paths }) => {
        const t = target(session);
        const files = await attachIpc.pick(paths?.map((p) => workspace.resolve(p)));
        if (!files) return { session: t.id, files: 0 };
        return attach(t, files);
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.addAttachmentToProject",
      title: "Add attachment to project…",
      category: "Agent",
      description:
        "Saves an attachment of the chat's next message (an image, a file from outside the folder, a big paste) as a file in the open folder, at `path` (relative to the folder; asked when omitted, default its own name), and opens it. `id`: the attachment's id (ide://agent/session uploads). Refuses to overwrite a file.",
      input: s.object({
        id: s.string().describe("A message-box attachment's id").optional(),
        attachment: attachmentInput
          .describe(
            "Or a sent one (D211): its name, kind and data (base64 PNG, a data: URL or the text)",
          )
          .optional(),
        path: s.string().describe("Where, relative to the open folder").optional(),
        session: sessionInput,
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ id, attachment, path, session }, ctx) => {
        const t = target(session);
        const root = workspace.root.peek();
        if (!root) throw new Error("Open a folder first: attachments are saved into it.");
        const pending = id ? t.uploads.peek().find((u) => u.id === id) : undefined;
        if (id && !pending) throw new Error(`No attachment ${id} in this chat's message box.`);
        if (!pending && !attachment) throw new Error("Give an attachment's id or the attachment.");
        const file = pending
          ? { name: uploadFileName(pending), bytes: uploadBytes(pending) }
          : attachmentFile(attachment as { name: string; kind: "image" | "text"; data: string });
        const upload = { kind: pending?.kind ?? attachment?.kind ?? "text" };
        // Relative to the folder; in a multi-root workspace a folder's name in front picks it.
        const exists = (rel: string) =>
          fsIpc.stat(workspace.resolve(rel)).then(
            () => true,
            () => false,
          );
        let rel = path?.trim();
        if (!rel) {
          let suggested = file.name;
          // A free name: "shot (2).png" when "shot.png" is taken.
          for (let n = 2; (await exists(suggested)) && n < 100; n++)
            suggested = file.name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
          const typed = await services.quickInput.prompt({
            prompt: "Save the attachment in the project as (relative to the folder)",
            value: suggested,
            selection: [
              0,
              suggested.lastIndexOf(".") > 0 ? suggested.lastIndexOf(".") : suggested.length,
            ],
          });
          if (!typed?.trim()) return null;
          rel = typed.trim();
        }
        const full = workspace.resolve(rel);
        if (!workspace.contains(full))
          throw new Error(
            workspace.folders.peek().length > 1
              ? "The file must be inside one of the workspace's folders."
              : "The file must be inside the open folder.",
          );
        if (await exists(rel)) throw new Error(`${rel} already exists.`);
        await fsIpc.write(full, file.bytes, "agent");
        if (upload.kind === "image")
          await ctx.execute("explorer.reveal", { path: full }).catch(() => {});
        else await ctx.execute("editor.openFile", { path: full }).catch(() => {});
        notifications.show("info", `Added ${rel} to the project.`);
        return { path: full };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.saveAttachmentAs",
      title: "Download attachment…",
      category: "Agent",
      description:
        "Saves an attachment (an image or a text the user attached or pasted, D211) anywhere on the computer, through the system's save dialog.",
      input: s.object({
        attachment: attachmentInput,
        path: s.string().describe("Debug builds only: where, without the dialog").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ attachment, path }) => {
        const file = attachmentFile(
          attachment as { name: string; kind: "image" | "text"; data: string },
        );
        const saved = await attachIpc.saveAs(file.name, file.bytes, path);
        if (!saved) return null;
        notifications.show("info", `Saved ${file.name}.`, {
          actions: [{ label: "Show in folder", run: () => void openerIpc.revealInOs(saved) }],
        });
        return { path: saved };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.attachDropped",
      title: "Attach dropped files",
      category: "Agent",
      description: "Attaches the files just dropped onto the chat from the system's file manager.",
      input: s.object({ session: sessionInput }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ session }) => attach(target(session), await attachIpc.dropped()),
    }),
  );
}
