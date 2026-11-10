// Notifications to the user's phone (D360, Claude Code's push to the phone with Remote Control):
// the agent's notify message also goes to a webhook the user set (`agent.notify.webhook`): an
// ntfy topic, a Discord or Slack incoming webhook, or any URL that takes JSON. Off until set.
// Sent only when the window isn't focused (the notify tool checks), one line of at most 200
// characters with no code and nothing secret-looking (core/agent/webhook.ts). A URL anyone could
// post to (a topic, a Discord or Slack webhook, one with a token in it) is kept in the secret
// store, never in settings. Rust posts it (ipc/notify.rs): https only, http to localhost.
// Commands: agent.setNotifyWebhook, agent.clearNotifyWebhook, agent.testNotifyWebhook; state
// ide://agent/notifyWebhook.

import {
  guessWebhookKind,
  parseWebhookSetting,
  WEBHOOK_KINDS,
  type WebhookKind,
  webhookHost,
  webhookRequest,
  webhookUrlIsSecret,
  webhookUrlProblem,
} from "../../core/agent/webhook";
import { notifyIpc } from "../../core/ipc/agentIntegrations";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { product } from "../../core/product";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

const SETTING = "agent.notify.webhook";

/**
 * Sends `message` to the user's webhook, when there is one. "none": no webhook set; otherwise
 * "sent" or why it failed (the notify tool says so; the desktop notice went anyway).
 */
export async function sendToPhone(
  services: WorkbenchServices,
  message: string,
  from: { chat?: string; title?: string } = {},
): Promise<"none" | "sent" | { error: string }> {
  const setting = parseWebhookSetting(services.settings.peek(SETTING));
  if (!setting) return "none";
  const root = services.workspace.root.peek();
  const title = from.title ? `${from.title} · ${product.nameShort}` : product.nameShort;
  const req = webhookRequest(setting.kind, message, title, {
    ...(from.chat && { chat: from.chat }),
    ...(root && { folder: basename(root) }),
  });
  try {
    await notifyIpc.post(
      setting.secret ? null : (setting.url ?? null),
      req.body,
      req.contentType,
      req.headers,
    );
    return "sent";
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPhoneNotify(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput, notifications, settings } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  sub.add(
    services.state.register("ide://agent/notifyWebhook", {
      description:
        "The webhook the agent's notify messages also go to (D360): its kind (ntfy, discord, slack, json), where it goes, and whether its URL is kept as a secret. Null when none is set.",
      get: () => {
        const w = parseWebhookSetting(settings.peek(SETTING));
        return w
          ? {
              kind: w.kind,
              host: w.secret ? (w.host ?? "") : webhookHost(w.url ?? ""),
              secret: !!w.secret,
            }
          : null;
      },
    }),
  );

  register({
    id: "agent.setNotifyWebhook",
    title: "Send agent notifications to my phone…",
    description:
      "Sets the webhook the agent's notify messages also go to when the window isn't focused (D360): an ntfy topic URL (https://ntfy.sh/<topic>), a Discord or Slack incoming webhook URL, or any https URL that takes JSON (`kind` json; http only to localhost). A URL anyone could post to is kept in the secret store, not in settings. A person running it without `url` is asked for it.",
    input: s.object({
      url: s.string().describe("The webhook URL").optional(),
      kind: s
        .enum(WEBHOOK_KINDS)
        .describe("ntfy, discord, slack or json (guessed from the URL)")
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ url, kind }, ctx) => {
      const asked =
        url ??
        (ctx.caller.kind === "user"
          ? await quickInput.prompt({
              prompt: "Webhook URL: an ntfy topic, a Discord or Slack webhook, or a JSON endpoint",
              placeholder: "https://ntfy.sh/my-private-topic",
              validate: (v) => (v.trim() ? (webhookUrlProblem(v) ?? undefined) : undefined),
            })
          : undefined);
      if (!asked?.trim()) return { set: false };
      const clean = asked.trim();
      const problem = webhookUrlProblem(clean);
      if (problem) throw new Error(problem);
      let chosen: WebhookKind = kind ?? guessWebhookKind(clean);
      if (!kind && ctx.caller.kind === "user") {
        const picked = await quickInput.pick(
          WEBHOOK_KINDS.map((k) => ({
            id: k,
            label: {
              ntfy: "ntfy",
              discord: "Discord",
              slack: "Slack",
              json: "JSON (any endpoint)",
            }[k],
            ...(k === chosen && { description: "detected" }),
          })),
          { placeholder: "What kind of webhook is it?" },
        );
        if (!picked) return { set: false };
        chosen = picked.id as WebhookKind;
      }
      if (webhookUrlIsSecret(chosen, clean)) {
        await notifyIpc.store(clean);
        await settings.update(
          SETTING,
          { kind: chosen, secret: true, host: webhookHost(clean) },
          "user",
        );
      } else {
        await notifyIpc.store(null).catch(() => {});
        await settings.update(SETTING, { kind: chosen, url: clean }, "user");
      }
      if (ctx.caller.kind === "user")
        notifications.show(
          "info",
          `Agent notifications also go to ${webhookHost(clean)} when you're away.`,
          {
            actions: [
              {
                label: "Send a test",
                run: () => void dispatcher.execute("agent.testNotifyWebhook", {}).catch(() => {}),
              },
            ],
          },
        );
      return {
        set: true,
        kind: chosen,
        host: webhookHost(clean),
        secret: webhookUrlIsSecret(chosen, clean),
      };
    },
  });

  register({
    id: "agent.clearNotifyWebhook",
    title: "Stop sending agent notifications to my phone",
    description: "Removes the notify webhook (D360) and its stored URL.",
    input: s.empty(),
    effects: ["write"],
    agent: "hidden",
    run: async () => {
      await notifyIpc.store(null).catch(() => {});
      await settings.update(SETTING, undefined, "user");
      return { cleared: true };
    },
  });

  register({
    id: "agent.testNotifyWebhook",
    title: "Send a test notification to my phone",
    description:
      "Sends a test message to the notify webhook (D360), whether or not the window is focused; says whether it arrived (the endpoint's answer).",
    input: s.empty(),
    effects: ["network"],
    agent: "hidden",
    run: async (_input, ctx) => {
      const r = await sendToPhone(
        services,
        "A test from the agent: notifications reach you here.",
        {
          title: "Test",
        },
      );
      if (r === "none") {
        if (ctx.caller.kind === "user") {
          await dispatcher.execute("agent.setNotifyWebhook", {});
          return { sent: false, reason: "no webhook set" };
        }
        throw new Error("No webhook is set: run agent.setNotifyWebhook first.");
      }
      if (r !== "sent") throw new Error(`The test didn't arrive: ${r.error}`);
      if (ctx.caller.kind === "user") notifications.show("success", "Test notification sent.");
      return { sent: true };
    },
  });
}
