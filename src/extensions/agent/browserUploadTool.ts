// browser_act upload (D339), Claude in Chrome's file_upload and upload_image: workspace files, or
// a page screenshot the agent took (its id from the screenshot tool), set on a file input or
// dropped on a drop zone, through browser.upload (which asks like the other page actions). Paths
// are the workspace's only, and files the agent is kept from (.aiignore…) stay out, as for
// read_file. The screenshots this chat took are kept (the last few) so they can be dropped.
import { uploadSources } from "../../core/agent/browserUpload";
import type { ToolOutcome } from "../../core/agent/loop";
import { sandboxPath } from "../../core/agent/workspaceFolders";
import { asAgent, text, UNTRUSTED } from "./browserScriptTools";
import { agentFolders, agentIgnored } from "./ignore";
import { cleanPathArg } from "./pathArg";
import type { ToolHost } from "./tools";

const KEEP_SHOTS = 8;
/** Screenshots each chat took, by session: id → base64 PNG (the newest few). */
const shots = new Map<string, Map<string, string>>();
let nextShot = 1;

/** Keeps a screenshot the agent took; returns its id (shot3). */
export function rememberShot(session: string, png: string): string {
  const id = `shot${nextShot++}`;
  let mine = shots.get(session);
  if (!mine) {
    mine = new Map();
    shots.set(session, mine);
  }
  mine.set(id, png);
  for (const old of [...mine.keys()].slice(0, -KEEP_SHOTS)) mine.delete(old);
  return id;
}

export async function runUpload(
  args: Record<string, unknown>,
  host: ToolHost,
): Promise<ToolOutcome> {
  const sources = uploadSources(args);
  const folders = agentFolders(host.services);
  const files: string[] = [];
  const data: { name: string; type: string; base64: string }[] = [];
  for (const source of sources) {
    if (source.kind === "screenshot") {
      const png = shots.get(host.session)?.get(source.id);
      if (!png)
        throw new Error(
          `No screenshot ${source.id} in this chat (the last ${KEEP_SHOTS} are kept): take one with the screenshot tool.`,
        );
      data.push({ name: `${source.id}.png`, type: "image/png", base64: png });
      continue;
    }
    const abs = sandboxPath(folders, cleanPathArg(source.path));
    if (!abs)
      throw new Error(`${source.path} is outside the workspace: only its files can be uploaded.`);
    if (agentIgnored(host.services, abs))
      throw new Error(`${source.path} is excluded from the agent (.aiignore or a rule like it).`);
    files.push(abs);
  }
  const loc = Object.fromEntries(
    ["ref", "selector", "name"].filter((k) => typeof args[k] === "string").map((k) => [k, args[k]]),
  );
  const point = Array.isArray(args.coordinate) ? (args.coordinate as unknown[]) : null;
  const where =
    point && typeof point[0] === "number" && typeof point[1] === "number"
      ? { x: point[0], y: point[1] }
      : loc;
  if (!Object.keys(where).length)
    throw new Error("upload: give the file input or drop zone (a ref, or a coordinate [x, y]).");
  const result = (await asAgent(host, "browser.upload", {
    ...where,
    ...(files.length && { files }),
    ...(data.length && { data }),
  })) as { sent?: string; mode?: string; dropped?: unknown[] };
  const dropped = Array.isArray(result?.dropped) && result.dropped.length === 0;
  return {
    result: `${UNTRUSTED}${text(result)}`,
    summary: dropped
      ? "not accepted"
      : `${result?.mode === "drop" ? "dropped" : "set"} ${result?.sent ?? ""}`.trim(),
    ...(dropped && { isError: true }),
  };
}
