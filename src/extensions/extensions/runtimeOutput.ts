// An extension's own Output channels (`ide.ui.createOutputChannel`, VS Code's
// `window.createOutputChannel`): each is a channel of the Output tab named as the extension named
// it, with the id `ext.<extension id>~<name>` (its file in the logs folder too). Its console stays
// in Extension host. At most 10 channels per extension; their lines stay for the session after
// it stops (like a language server's). The worker side is core/extensions/rpcOutput.ts.

import { type OutputService, output as windowOutput } from "../../core/diagnostics/output";
import type { Caller } from "../../core/dispatcher/types";
import { type LogLevelsMessage, logLevelNumber } from "../../core/extensions/logLevels";
import {
  extensionChannelId,
  MAX_OUTPUT_BATCH,
  type OutputLineLevel,
} from "../../core/extensions/rpcOutput";
import type { Disposable } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";

const MAX_CHANNELS = 10;
const LEVELS: readonly OutputLineLevel[] = ["trace", "debug", "info", "warn", "error"];

export interface OutputHostDeps {
  extensionId: string;
  services: Pick<WorkbenchServices, "dispatcher"> &
    Partial<Pick<WorkbenchServices, "extensionFeatures">>;
  caller: Caller;
  /** The window's channels (tests pass their own). */
  output?: OutputService;
}

export class ExtensionOutputHost {
  /** Channel name → id, as created by the extension. */
  private readonly channels = new Map<string, string>();
  private readonly output: OutputService;

  constructor(private readonly deps: OutputHostDeps) {
    this.output = deps.output ?? windowOutput;
  }

  private nameOf(p: Record<string, unknown>): string {
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 80) : "";
    if (!name) throw new Error("An output channel needs a name.");
    return name;
  }

  /** The channel's id, making it when it's new (refused past MAX_CHANNELS). */
  private channel(name: string): string {
    const known = this.channels.get(name);
    if (known) return known;
    if (this.channels.size >= MAX_CHANNELS)
      throw new Error(`An extension can have at most ${MAX_CHANNELS} output channels.`);
    const id = extensionChannelId(this.deps.extensionId, name);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
    this.output.register(id, name.replace(/[\u0000-\u001f]/g, " "));
    this.channels.set(name, id);
    return id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "output.create": {
        const name = this.nameOf(p);
        const id = this.channel(name);
        // A log channel (VS Code's `{ log: true }`): "Set log level…" lists it.
        const list = this.deps.services.extensionFeatures?.logChannels;
        if (p.log === true && list && !this.logChannels.has(id))
          this.logChannels.set(id, list.add({ owner: this.deps.extensionId, id, name }));
        return Promise.resolve({ id });
      }
      case "logLevels.get":
        return Promise.resolve(this.levels());
      case "output.append": {
        const id = this.channel(this.nameOf(p));
        const lines = Array.isArray(p.lines) ? p.lines.slice(0, MAX_OUTPUT_BATCH) : [];
        for (const raw of lines) {
          const line = raw as { level?: unknown; text?: unknown } | null;
          const level = LEVELS.includes(line?.level as OutputLineLevel)
            ? (line?.level as OutputLineLevel)
            : "info";
          this.output.append(id, level, String(line?.text ?? ""), undefined, this.deps.extensionId);
        }
        return Promise.resolve(undefined);
      }
      case "output.clear":
        this.output.clear(this.channel(this.nameOf(p)));
        return Promise.resolve(undefined);
      case "output.show": {
        const id = this.channel(this.nameOf(p));
        return this.deps.services.dispatcher
          .execute("output.show", { channel: id }, this.deps.caller)
          .then(() => undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  /** The ids of the channels it made. */
  ids(): string[] {
    return [...this.channels.values()];
  }

  /** Its log channels in the list "Set log level…" shows, until it stops. */
  private readonly logChannels = new Map<string, Disposable>();

  /** The levels its worker hears: the default and its own channels' (VS Code's numbers). */
  levels(): LogLevelsMessage {
    const levels = this.deps.services.extensionFeatures?.logLevels;
    return levels
      ? // Its channels' ids are `ext.<id>~<name>` (rpcOutput.ts).
        levels.messageFor(`ext.${this.deps.extensionId}~`)
      : { default: logLevelNumber("info"), channels: {} };
  }

  /** Its code stopped: its log channels leave the list (their lines stay). */
  workerGone(): void {
    for (const off of this.logChannels.values()) off.dispose();
    this.logChannels.clear();
  }
}
