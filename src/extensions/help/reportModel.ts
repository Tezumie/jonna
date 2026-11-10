// Help → Report a problem (D204): what goes into the report, gathered when it opens. Every part is
// redacted (secrets, keys, tokens, home folders, file contents) before the user sees it, and the
// user sees exactly what's included and can leave parts out. Nothing is sent from here.
import { redactText, redactValue } from "../../core/diagnostics/redact";
import { type ReportSection, reportBody } from "../../core/diagnostics/report";
import { logIpc, type SessionInfo } from "../../core/ipc/diagnostics";
import type { AppInfo } from "../../core/ipc/system";
import { product } from "../../core/product";
import { type Signal, signal } from "../../core/reactive/index";
import type { Shot } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import type { ErrorCapture } from "./errorCapture";

/** The state included by default: how the IDE is set up, not what's in the files. */
export const REPORT_STATE_PATHS = [
  "ide://workspace",
  "ide://layout",
  "ide://editors",
  "ide://extensions",
  "ide://lsp",
  "ide://update",
  "ide://perf",
  "ide://safeMode",
] as const;
const STATE_BUDGET = 3_000;
const LOG_LINES = 80;

export class ReportDraft {
  readonly title: Signal<string> = signal("");
  readonly description: Signal<string> = signal("");
  readonly sections: Signal<readonly ReportSection[]> = signal([]);
  readonly screenshot: Signal<Shot | null> = signal(null);
  readonly includeScreenshot: Signal<boolean> = signal(false);
  /** True once gathered (a tab shows it). */
  readonly ready: Signal<boolean> = signal(false);

  setIncluded(id: string, included: boolean): boolean {
    if (id === "screenshot") {
      if (!this.screenshot.peek()) return false;
      this.includeScreenshot.value = included;
      return true;
    }
    const list = this.sections.peek();
    if (!list.some((s) => s.id === id)) return false;
    this.sections.value = list.map((s) => (s.id === id ? { ...s, included } : s));
    return true;
  }

  /** The issue body, exactly as it will be sent to the browser or saved. */
  body(): string {
    const shot = this.includeScreenshot.peek() && this.screenshot.peek();
    const text = reportBody(this.description.peek(), this.sections.peek());
    return shot
      ? `${text}\n_A screenshot of the window is attached (screenshot.png, ${shot.width}×${shot.height})._\n`
      : text;
  }

  issueTitle(): string {
    return this.title.peek().trim() || "Problem report";
  }
}

function webview(): string {
  const ua = navigator.userAgent;
  const edge = /Edg\/([\d.]+)/.exec(ua)?.[1];
  if (edge) return `WebView2 ${edge}`;
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1];
  if (chrome) return `Chromium ${chrome}`;
  return `WebKit ${/AppleWebKit\/([\d.]+)/.exec(ua)?.[1] ?? ""}`.trim();
}

function clock(time: number): string {
  return new Date(time).toISOString().slice(11, 19);
}

export interface GatherDeps {
  services: WorkbenchServices;
  capture: ErrorCapture;
  app: AppInfo | null;
  session: SessionInfo | null;
}

/** Collects the report's sections (all redacted), replacing the draft's. */
export async function gatherReport(draft: ReportDraft, deps: GatherDeps): Promise<void> {
  const { services, capture, app, session } = deps;
  const home = app?.homeDir ?? null;
  const channel = services.settings.peek<string>("update.channel") === "beta" ? "beta" : "stable";
  const system = [
    `Version: ${product.version}${app?.debugBuild ? " (debug build)" : ""}`,
    `Update channel: ${channel}`,
    `OS: ${app ? `${app.os} ${app.arch}${app.osBuild ? ` (build ${app.osBuild})` : ""}` : "unknown"}`,
    `Webview: ${webview()}`,
    `Language: ${navigator.language}`,
    `Window: ${window.innerWidth}×${window.innerHeight} at ${window.devicePixelRatio}x`,
    `Extensions: ${session?.extensionsOff ? "off for this session" : "on"}`,
    ...(session?.previousVersion && session.previousVersion !== product.version
      ? [`Updated from: ${session.previousVersion}`]
      : []),
  ].join("\n");

  // Errors: the IDE's own (uncaught, console.error, failed calls and commands) and the error
  // notifications the user saw.
  const errors = [
    ...capture.buffer
      .recent()
      .slice(-30)
      .map((r) => `${clock(r.time)} [${r.level}] [${r.source}] ${r.message}`),
    ...services.notifications.history
      .peek()
      .filter((n) => n.kind === "error")
      .slice(0, 10)
      .reverse()
      .map((n) => `${clock(n.time)} [notification] ${n.title ? `${n.title}: ` : ""}${n.message}`),
  ]
    .map((line) => redactText(line, home))
    .join("\n");

  await capture.flush();
  const log = (await logIpc.recent(LOG_LINES).catch(() => [] as string[]))
    .map((line) => redactText(line, home))
    .join("\n");

  const sections: ReportSection[] = [
    { id: "system", title: "System", text: system, included: true },
    { id: "errors", title: "Recent errors", text: errors, included: errors !== "" },
    { id: "log", title: "Session log (last lines)", text: log, included: log !== "" },
  ];
  for (const path of REPORT_STATE_PATHS) {
    if (!services.state.has(path)) continue;
    const snap = await services.state.get(path, { budget: STATE_BUDGET }).catch(() => null);
    if (!snap) continue;
    const text = JSON.stringify(redactValue(snap.value, { home }), null, 1) ?? "null";
    sections.push({ id: path, title: `State: ${path}`, text, included: true });
  }
  draft.sections.value = sections;
  draft.ready.value = true;
}
