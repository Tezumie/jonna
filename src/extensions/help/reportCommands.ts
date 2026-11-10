// Help → Report a problem and the logs (D204): the commands behind the report tab, Help → Open
// logs folder, and `ide://report` / `ide://logs`.
import { redactText } from "../../core/diagnostics/redact";
import { issueLink } from "../../core/diagnostics/report";
import { logIpc, reportIpc, sessionIpc } from "../../core/ipc/diagnostics";
import { type AppInfo, appIpc, clipboardIpc, dialogIpc, openerIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isAbsolute, joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { s } from "../../core/schema/index";
import { base64, captureWindow, nextPaint, saveShot } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import type { ErrorCapture } from "./errorCapture";
import { gatherReport, ReportDraft } from "./reportModel";
import { reportViewDescriptor } from "./reportView";

export function registerReportCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  capture: ErrorCapture,
): void {
  const { dispatcher, dock, notifications, state } = services;
  const draft = new ReportDraft();
  sub.add(dock.views.register(reportViewDescriptor(services, draft)));
  let app: AppInfo | null = null;
  const appInfo = async () => {
    app ??= await appIpc.info().catch(() => null);
    return app;
  };
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "Help", ...command }));
  const needDraft = () => {
    if (!draft.ready.peek()) throw new Error("Open Help → Report a problem first.");
  };

  register({
    id: "help.reportProblem",
    title: "Report a problem…",
    description:
      "Opens the problem report: the version, OS, recent errors, the session log's last lines, a redacted dump of the IDE's state (no keys, tokens, home folder or file contents) and an optional screenshot, each of which the user can leave out. From there the user opens a prefilled new issue in the browser or saves a zip. Nothing is uploaded.",
    input: s.object({
      title: s.string().describe("The issue's title").optional(),
      description: s.string().describe("What happened").optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ title, description }) => {
      // The window as it was (menus closed, before the report tab covers it).
      await nextPaint();
      draft.screenshot.value = await captureWindow().catch(() => null);
      draft.includeScreenshot.value = false;
      if (title !== undefined) draft.title.value = title;
      if (description !== undefined) draft.description.value = description;
      await gatherReport(draft, {
        services,
        capture,
        app: await appInfo(),
        session: await sessionIpc.info().catch(() => null),
      });
      const tabId = dock.openView("report", null, "main", true);
      return {
        tabId,
        sections: draft.sections.peek().map((x) => ({ id: x.id, included: x.included })),
      };
    },
  });

  register({
    id: "help.reportInclude",
    title: "Include part of the problem report",
    description:
      "Includes or leaves out one part of the open problem report (system, errors, log, a state path like ide://layout, or screenshot).",
    input: s.object({
      section: s.string().describe("The part's id (see ide://report)"),
      included: s.boolean(),
    }),
    effects: [],
    palette: false,
    run: ({ section, included }) => {
      needDraft();
      if (!draft.setIncluded(section, included)) throw new Error(`No part "${section}".`);
      return { section, included };
    },
  });

  register({
    id: "help.reportCopy",
    title: "Copy the problem report",
    description: "Copies the open problem report's text (as shown in its tab) to the clipboard.",
    input: s.empty(),
    effects: [],
    palette: false,
    run: async () => {
      needDraft();
      const body = draft.body();
      await clipboardIpc.writeText(body);
      notifications.show("info", "The report is on the clipboard.");
      return { characters: body.length };
    },
  });

  register({
    id: "help.reportOpenIssue",
    title: "Open the problem report as a new issue",
    description:
      "Opens a new issue in the browser with the report filled in (the repository from product.json issuesUrl). A report too long for a link is cut, and the full text goes to the clipboard to paste. `dryRun` only returns the link.",
    input: s.object({
      dryRun: s.boolean().describe("Return the link without opening it").optional(),
    }),
    effects: [],
    palette: false,
    run: async ({ dryRun }) => {
      needDraft();
      if (!product.issuesUrl)
        throw new Error(
          "This build has no issue tracker (product.json issuesUrl). Copy the report or save it as a zip instead.",
        );
      const body = draft.body();
      const link = issueLink(product.issuesUrl, draft.issueTitle(), body);
      if (dryRun) return { url: link.url, truncated: link.truncated };
      if (link.truncated) await clipboardIpc.writeText(body);
      let screenshot: string | null = null;
      const shot = draft.includeScreenshot.peek() ? draft.screenshot.peek() : null;
      const root = services.workspace.root.peek();
      // A link can't carry the picture: save it where the user can drag it into the issue.
      if (shot && root) {
        screenshot = await saveShot(root, "problem-report", shot);
        void openerIpc.revealInOs(screenshot).catch(() => {});
      }
      await openerIpc.openUrl(link.url);
      notifications.show(
        "info",
        [
          link.truncated
            ? "The report was too long for the link: the full text is on the clipboard, paste it into the issue."
            : "",
          shot
            ? screenshot
              ? "Drag the screenshot (shown in your file manager) into the issue."
              : "Save the report as a zip to attach the screenshot."
            : "",
        ]
          .filter(Boolean)
          .join(" ") || "The issue opens in your browser; review it there before submitting.",
      );
      return { url: link.url, truncated: link.truncated, screenshot };
    },
  });

  register({
    id: "help.reportSaveZip",
    title: "Save the problem report as a zip",
    description:
      "Saves the open problem report as a zip (report.md, the included parts and, when included, screenshot.png) at `path`, or where the user picks.",
    input: s.object({
      path: s.string().describe("Where to save (.zip; relative: in the open folder)").optional(),
    }),
    effects: ["write"],
    palette: false,
    run: async ({ path }) => {
      needDraft();
      const day = new Date().toISOString().slice(0, 10);
      const root = services.workspace.root.peek();
      // A relative path is in the open folder (agents and tests).
      const given = path && root && !isAbsolute(path) ? joinPath(root, path) : path;
      const target =
        given ?? (await dialogIpc.pickSavePath("Save problem report", `problem-report-${day}.zip`));
      if (!target) return { saved: false };
      const file = /\.zip$/i.test(target) ? target : `${target}.zip`;
      const included = draft.sections.peek().filter((x) => x.included);
      const files: { name: string; text?: string; base64?: string }[] = [
        { name: "report.md", text: `# ${draft.issueTitle()}\n\n${draft.body()}` },
      ];
      const part = (id: string) => included.find((x) => x.id === id)?.text;
      const system = part("system");
      if (system) files.push({ name: "system.txt", text: `${system}\n` });
      const errors = part("errors");
      if (errors) files.push({ name: "errors.txt", text: `${errors}\n` });
      const log = part("log");
      if (log) files.push({ name: "session.log", text: `${log}\n` });
      const states = included.filter((x) => x.id.startsWith("ide://"));
      if (states.length)
        files.push({
          name: "state.json",
          text: `{\n${states.map((x) => `${JSON.stringify(x.id)}: ${x.text}`).join(",\n")}\n}\n`,
        });
      const shot = draft.includeScreenshot.peek() ? draft.screenshot.peek() : null;
      if (shot) files.push({ name: "screenshot.png", base64: base64(shot.png) });
      await reportIpc.saveZip(file, files);
      notifications.show("info", `Saved the report: ${file}`, {
        actions: [{ label: "Show in folder", run: () => void openerIpc.revealInOs(file) }],
      });
      return { saved: true, path: file, files: files.map((f) => f.name) };
    },
  });

  sub.add(
    state.register("ide://report", {
      description:
        "The problem report being written (Help → Report a problem): its parts with whether each is included and its size, whether a screenshot was taken and is included, the titles of the included parts, whether this build has an issue tracker, and the report's length and first 4000 characters.",
      get: () => ({
        ready: draft.ready.peek(),
        issueTracker: product.issuesUrl !== "",
        title: draft.issueTitle(),
        sections: draft.sections.peek().map((x) => ({
          id: x.id,
          title: x.title,
          included: x.included,
          characters: x.text.length,
        })),
        screenshot: { taken: !!draft.screenshot.peek(), included: draft.includeScreenshot.peek() },
        included: draft.sections
          .peek()
          .filter((x) => x.included)
          .map((x) => x.title),
        bodyCharacters: draft.ready.peek() ? draft.body().length : 0,
        body: draft.ready.peek() ? draft.body().slice(0, 4000) : "",
      }),
    }),
  );

  // ---- Logs --------------------------------------------------------------------------------
  register({
    id: "help.openLogsFolder",
    title: "Open logs folder",
    description:
      "Shows the folder of session logs (one per run, the last ten kept) in the system's file manager, with this session's log selected.",
    input: s.empty(),
    effects: [],
    run: async () => {
      const info = await sessionIpc.info();
      if (!info) throw new Error("Logs are only in the desktop app.");
      await capture.flush();
      await openerIpc.revealInOs(info.logFile);
      return { logsDir: info.logsDir, logFile: info.logFile };
    },
  });
  register({
    id: "help.showLog",
    title: "Show session log",
    description:
      "Opens this session's log (errors, failed calls, panics; redacted) in a read-only tab.",
    input: s.empty(),
    effects: ["read"],
    run: async () => {
      await capture.flush();
      const lines = await logIpc.recent(2000);
      await dispatcher.execute("editor.openReadOnly", {
        title: "Session log.log",
        content: `${lines.join("\n")}\n`,
      });
      return { lines: lines.length };
    },
  });
  sub.add(
    state.register("ide://logs", {
      description:
        "This session's log (redacted: no keys, tokens or home folder): its file, the folder of session logs, and the last lines (?lines=<n>, default 50). Errors from the window, failed IPC calls and commands, and Rust panics are logged.",
      get: async ({ params }) => {
        await capture.flush();
        const info = await sessionIpc.info();
        const home = (await appInfo())?.homeDir ?? null;
        const n = Math.min(500, Math.max(1, Number(params.lines) || 50));
        const lines = await logIpc.recent(n);
        return {
          logFile: info ? redactText(info.logFile, home) : null,
          logsDir: info ? redactText(info.logsDir, home) : null,
          recentErrors: capture.buffer.recent().length,
          lines,
        };
      },
    }),
  );
}
