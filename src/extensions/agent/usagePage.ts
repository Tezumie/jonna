// The Usage page (D201, dock view `agent.usage`): what the agent and the AI features used on this
// computer — today, 7 and 30 days, a bar per day, models, features, providers with the limits they
// report, the chats that cost the most, this chat with its budget — from the local usage log
// (`usageLog.ts`). Everything it changes goes through commands (`settings.set`,
// `agent.openSession`, `agent.clearUsageHistory`, `agent.refreshUsageLimits`), and
// `ide://agent/usage/history` / `ide://agent/usage/limits` show the same data.

import { formatCost } from "../../core/agent/prices";
import { relativeAge } from "../../core/agent/rooms";
import {
  bucketLabel,
  formatIn,
  formatTokens,
  niceMax,
  providerAgent,
  resetAt,
  SOURCE_LABELS,
  sessionSums,
  summarize,
  type UsageRecord,
  type UsageSummary,
  type UsageSums,
} from "../../core/agent/usageLog";
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { agentStoreIpc, type ProviderLimits } from "../../core/ipc/agent";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";
import {
  clearUsage,
  isOpenRouter,
  loadUsage,
  onUsageAppended,
  providerLimits,
  refreshLimits,
  usageLogVersion,
} from "./usageLog";

const DAY = 86_400_000;
const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** "$1.20", or "—" when nothing had a price. */
const money = (x: UsageSums): string =>
  x.requests === 0 ? "$0" : x.cost > 0 || x.unpriced === 0 ? formatCost(x.cost) || "$0" : "—";

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const tokens = (x: UsageSums) => formatTokens(x.input + x.output);

/** "12 requests · 34k tokens" (+ "· 3 without a price"). */
function detail(x: UsageSums): string {
  // An external agent that reports no tokens (D208): its turns are counted, nothing else.
  if (x.unreported && x.unreported === x.requests)
    return `${plural(x.requests, "turn")} · tokens not reported`;
  const parts = [plural(x.requests, "request"), `${tokens(x)} tokens`];
  if (x.unreported) parts.push(`${x.unreported} without token counts`);
  const unknown = x.unpriced - x.unreported;
  if (unknown > 0 && x.unpriced < x.requests) parts.push(`${unknown} without a price`);
  return parts.join(" · ");
}

/** Titles of saved and open chats, by id. */
async function chatTitles(sessions: SessionManager): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await agentStoreIpc.list().catch(() => [])) {
    const title = (r.meta as { title?: unknown } | null)?.title;
    if (typeof title === "string") out.set(r.id, title);
  }
  for (const live of sessions.all()) out.set(live.id, live.title.peek());
  return out;
}

class UsageView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  private records: UsageRecord[] = [];
  private titles = new Map<string, string>();
  private loaded = false;
  private loading = 0;
  private period: Period = 30;
  private metric: "cost" | "tokens" | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private drawTimer: ReturnType<typeof setTimeout> | undefined;
  /** A draw was put off while a field had focus. */
  private stale = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly providers: ProviderRegistry,
    private readonly sessions: SessionManager,
    state: Json | null,
  ) {
    const saved = (state ?? {}) as { period?: unknown; metric?: unknown };
    if (PERIODS.includes(saved.period as Period)) this.period = saved.period as Period;
    if (saved.metric === "cost" || saved.metric === "tokens") this.metric = saved.metric;
    this.body = h("div", { class: "ai-setup usage-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add({ dispose: () => clearTimeout(this.reloadTimer) });
    // The whole log is read when the page opens and after it's cleared; new records are added
    // as they're written (a long agent run doesn't read 20 MB again after every step).
    this.store.add(
      effect(() => {
        usageLogVersion.value;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(), this.loaded ? 300 : 0);
        return undefined;
      }),
    );
    this.store.add(
      onUsageAppended((batch) => {
        if (!this.loaded) return;
        this.records = this.records.concat(batch);
        clearTimeout(this.drawTimer);
        this.drawTimer = setTimeout(() => this.draw(), 300);
      }),
    );
    this.store.add({ dispose: () => clearTimeout(this.drawTimer) });
    // Typing in the budget field isn't interrupted: a draw waits until it loses focus.
    this.store.add(
      on(this.body, "focusout", () => {
        if (!this.stale) return;
        setTimeout(() => {
          if (this.stale && !this.editing()) this.draw();
        }, 0);
      }),
    );
    // The chat in use, its live numbers, the budget and the limits: draw again.
    this.store.add(
      effect(() => {
        services.settings.version.value;
        providerLimits.value;
        providers.statuses.value;
        const chat = sessions.find(sessions.active.value ?? undefined);
        chat?.totals.value;
        chat?.cost.value;
        chat?.title.value;
        this.draw();
        return undefined;
      }),
    );
    void this.run("agent.refreshUsageLimits");
  }

  serialize(): Json {
    return { period: this.period, ...(this.metric && { metric: this.metric }) };
  }

  private async reload(): Promise<void> {
    const token = ++this.loading;
    const [records, titles] = await Promise.all([
      loadUsage(Date.now() - 90 * DAY).catch(() => [] as UsageRecord[]),
      chatTitles(this.sessions),
    ]);
    if (token !== this.loading || this.store.isDisposed) return;
    this.records = records;
    this.titles = titles;
    this.loaded = true;
    this.draw();
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return this.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
      return null;
    });
  }

  /** A field of the page has focus (the budget being typed). */
  private editing(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement && this.body.contains(el);
  }

  private draw(): void {
    if (this.editing()) {
      this.stale = true;
      return;
    }
    this.stale = false;
    for (const live of this.sessions.all()) this.titles.set(live.id, live.title.peek());
    this.render.clear();
    if (!this.loaded) {
      this.body.replaceChildren(this.header());
      return;
    }
    const now = Date.now();
    const sum = summarize(this.records, now, { days: this.period });
    this.body.replaceChildren(
      this.header(),
      this.tiles(sum),
      this.chatSection(),
      this.chartSection(sum),
      this.listSection(
        "Models",
        sum.byModel.map((m) => ({
          name: m.model.slice(m.model.indexOf("/") + 1),
          // An external agent's model: its own account may bill it (a subscription), D208.
          sub: providerAgent(m.provider)
            ? `${providerAgent(m.provider)} · ${m.unreported === m.requests ? "subscription or not reported" : "as the agent reports it"}`
            : this.providerName(m.provider),
          sums: m,
        })),
        sum.month.requests === 0 ? null : `The last ${this.period} days.`,
      ),
      this.listSection(
        "Features",
        sum.bySource.map((x) => ({ name: SOURCE_LABELS[x.source], sums: x })),
        "What asked: the chat, its subagents and summaries, or the AI features in the editor.",
      ),
      this.providersSection(sum),
      this.chatsSection(sum, now),
      this.footer(sum),
    );
  }

  private header(): HTMLElement {
    const seg = h("div", { class: "usage-seg", role: "group", "aria-label": "Period" });
    for (const p of PERIODS) {
      const b = h(
        "button",
        {
          class: { "usage-seg-item": true, "is-on": p === this.period },
          type: "button",
          "aria-pressed": String(p === this.period),
          "data-period": String(p),
        },
        `${p} days`,
      );
      this.render.add(
        on(b, "click", () => {
          this.period = p;
          this.draw();
        }),
      );
      seg.append(b);
    }
    return h(
      "div",
      { class: "ai-header" },
      h(
        "div",
        null,
        h("h1", { class: "ai-title" }, "Usage"),
        h(
          "p",
          { class: "ai-lead" },
          "What the agent and the AI features used, from a log kept on this computer for 90 days. It never leaves it. Costs are estimates from token counts and prices, and limits are what providers last reported: check your provider's own dashboard for exact figures.",
        ),
      ),
      h("div", { class: "ai-header-actions" }, seg),
    );
  }

  private tiles(sum: UsageSummary): HTMLElement {
    const tile = (label: string, x: UsageSums, key: string) =>
      h(
        "div",
        { class: "usage-tile", "data-tile": key },
        h("div", { class: "usage-tile-label" }, label),
        h("div", { class: "usage-tile-value" }, money(x)),
        h("div", { class: "usage-tile-detail" }, detail(x)),
      );
    return h(
      "div",
      { class: "usage-tiles" },
      tile("Today", sum.today, "today"),
      tile("Last 7 days", sum.week, "week"),
      tile("Last 30 days", sum.month, "month"),
    );
  }

  private section(title: string, lead: string | null, ...children: (HTMLElement | null)[]) {
    return h(
      "section",
      { class: "ai-section usage-section" },
      h("h2", { class: "ai-section-title" }, title),
      lead ? h("p", { class: "ai-section-lead" }, lead) : null,
      ...children,
    );
  }

  /** The chat in use: its numbers as the meter counts them, the history's, and the budget. */
  private chatSection(): HTMLElement {
    const chat = this.sessions.find(undefined);
    const budget = this.services.settings.peek<number>("agent.budget.perChat") ?? 0;
    const input = h("input", {
      class: "input usage-budget-input",
      type: "number",
      min: "0",
      step: "0.5",
      "aria-label": "Budget per chat in dollars",
      placeholder: "None",
    }) as HTMLInputElement;
    input.value = budget > 0 ? String(budget) : "";
    input.setAttribute("value", input.value);
    this.render.add(
      on(input, "change", () => {
        const v = Number(input.value);
        void this.run("settings.set", {
          key: "agent.budget.perChat",
          value: Number.isFinite(v) && v > 0 ? v : 0,
        });
      }),
    );
    const budgetRow = h(
      "label",
      { class: "usage-budget" },
      h(
        "span",
        { class: "ai-row-main" },
        h("span", { class: "ai-row-name" }, "Budget per chat"),
        h(
          "span",
          { class: "ai-row-detail" },
          "Warns at 80 % and asks before a chat goes past it (agent.budget.perChat). Empty: none.",
        ),
      ),
      h("span", { class: "usage-budget-field" }, h("span", null, "$"), input),
    );
    if (!chat || chat.totals.peek().requests === 0) {
      return this.section(
        "This chat",
        null,
        h(
          "div",
          { class: "ai-list" },
          h(
            "div",
            { class: "ai-row usage-empty" },
            chat ? "This chat hasn't sent a request yet." : "No chat is open.",
          ),
          budgetRow,
        ),
      );
    }
    const t = chat.totals.peek();
    const cost = chat.cost.peek();
    const all = sessionSums(this.records, chat.id);
    const cells: [string, string][] = [
      ["Cost", cost === null ? "—" : formatCost(cost) || "$0"],
      ["Requests", t.requests.toLocaleString()],
      [
        "Input",
        `${formatTokens(t.input)}${t.cacheRead ? ` (${formatTokens(t.cacheRead)} cached)` : ""}`,
      ],
      ["Output", formatTokens(t.output)],
    ];
    const extra =
      all.requests > t.requests
        ? h(
            "div",
            { class: "usage-note" },
            `With its subagents and summaries: ${money(all)} over ${plural(all.requests, "request")}.`,
          )
        : null;
    const meter =
      budget > 0 && cost !== null
        ? this.bar(cost / budget, `${formatCost(cost) || "$0"} of ${formatCost(budget)}`)
        : null;
    const open = h(
      "button",
      { class: "usage-chat-title", type: "button", "data-session": chat.id },
      chat.title.peek(),
    );
    this.render.add(
      on(open, "click", () => void this.run("agent.openSession", { session: chat.id })),
    );
    return this.section(
      "This chat",
      null,
      h(
        "div",
        { class: "ai-list" },
        h(
          "div",
          { class: "ai-row usage-chat" },
          h(
            "div",
            { class: "ai-row-main" },
            open,
            h(
              "div",
              { class: "usage-cells" },
              ...cells.map(([k, v]) =>
                h(
                  "div",
                  { class: "usage-cell" },
                  h("span", { class: "usage-cell-label" }, k),
                  h("span", { class: "usage-cell-value" }, v),
                ),
              ),
            ),
            meter,
            extra,
          ),
        ),
        budgetRow,
      ),
    );
  }

  /** A thin meter (0…1+); past 1 it's full and marked over. */
  private bar(fraction: number, label: string): HTMLElement {
    const f = Math.max(0, Math.min(1, fraction));
    const fill = h("span", { class: "usage-meter-fill" });
    fill.style.width = `${Math.round(f * 1000) / 10}%`;
    return h(
      "div",
      {
        class: {
          "usage-meter-row": true,
          "is-warn": fraction >= 0.8 && fraction < 1,
          "is-over": fraction >= 1,
        },
      },
      h(
        "span",
        {
          class: "usage-meter",
          role: "meter",
          "aria-valuenow": String(Math.round(fraction * 100)),
          "aria-valuemin": "0",
          "aria-valuemax": "100",
          "aria-label": label,
        },
        fill,
      ),
      h("span", { class: "usage-meter-label" }, label),
    );
  }

  /** One bar per day: cost (or tokens when nothing had a price), plain DOM. */
  private chartSection(sum: UsageSummary): HTMLElement {
    const anyCost = sum.days.some((d) => d.cost > 0);
    const metric = this.metric ?? (anyCost ? "cost" : "tokens");
    const value = (d: UsageSums) => (metric === "cost" ? d.cost : d.input + d.output);
    const max = niceMax(Math.max(0, ...sum.days.map(value)));
    const fmt = (v: number) => (metric === "cost" ? formatCost(v) || "$0" : formatTokens(v));
    const bars = h("div", { class: "usage-bars", role: "img", "aria-label": `${metric} per day` });
    const short = (t: number) =>
      new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    for (const d of sum.days) {
      const v = value(d);
      const col = h("div", { class: "usage-bar", "data-day": d.day });
      const fill = h("span", { class: "usage-bar-fill" });
      fill.style.height = `${v > 0 ? Math.max(2, (v / max) * 100) : 0}%`;
      col.append(fill);
      setTooltip(
        col,
        `${short(d.start)}: ${d.requests ? `${money(d)} · ${detail(d)}` : "nothing"}`,
      );
      bars.append(col);
    }
    const toggle = h("div", { class: "usage-seg", role: "group", "aria-label": "Measure" });
    for (const m of ["cost", "tokens"] as const) {
      const b = h(
        "button",
        {
          class: { "usage-seg-item": true, "is-on": m === metric },
          type: "button",
          "aria-pressed": String(m === metric),
          "data-metric": m,
        },
        m === "cost" ? "Cost" : "Tokens",
      );
      this.render.add(
        on(b, "click", () => {
          this.metric = m;
          this.draw();
        }),
      );
      toggle.append(b);
    }
    const first = sum.days[0];
    const last = sum.days[sum.days.length - 1];
    return h(
      "section",
      { class: "ai-section usage-section" },
      h(
        "div",
        { class: "usage-section-head" },
        h("h2", { class: "ai-section-title" }, "By day"),
        toggle,
      ),
      h(
        "div",
        { class: "usage-chart" },
        h(
          "div",
          { class: "usage-axis" },
          h("span", null, fmt(max)),
          h("span", null, metric === "cost" ? "$0" : "0"),
        ),
        bars,
      ),
      h(
        "div",
        { class: "usage-axis-x" },
        h("span", null, first ? short(first.start) : ""),
        h("span", null, last ? "Today" : ""),
      ),
    );
  }

  /** Rows with a share bar: models, features. */
  private listSection(
    title: string,
    rows: { name: string; sub?: string; sums: UsageSums }[],
    lead: string | null,
  ): HTMLElement {
    if (!rows.length)
      return this.section(
        title,
        null,
        h(
          "div",
          { class: "ai-list" },
          h("div", { class: "ai-row usage-empty" }, `Nothing in the last ${this.period} days.`),
        ),
      );
    const byCost = rows.some((r) => r.sums.cost > 0);
    const total = rows.reduce(
      (n, r) => n + (byCost ? r.sums.cost : r.sums.input + r.sums.output),
      0,
    );
    return this.section(
      title,
      lead,
      h(
        "div",
        { class: "ai-list" },
        ...rows.map((r) => {
          const share =
            total > 0 ? (byCost ? r.sums.cost : r.sums.input + r.sums.output) / total : 0;
          const fill = h("span", { class: "usage-share-fill" });
          fill.style.width = `${Math.round(share * 1000) / 10}%`;
          return h(
            "div",
            { class: "ai-row usage-row" },
            h(
              "div",
              { class: "ai-row-main" },
              h(
                "span",
                { class: "ai-row-name usage-name" },
                r.name,
                r.sub ? h("span", { class: "usage-sub" }, r.sub) : null,
              ),
              h("span", { class: "ai-row-detail" }, detail(r.sums)),
              h("span", { class: "usage-share" }, fill),
            ),
            h("span", { class: "usage-amount" }, money(r.sums)),
          );
        }),
      ),
    );
  }

  private providerName(id: string): string {
    const agent = providerAgent(id);
    if (agent) return `${agent} (external agent)`;
    return this.providers.providers().find((p) => p.id === id)?.name ?? id;
  }

  /** Each provider: its use in the period and the limits it reports ("not reported" otherwise). */
  private providersSection(sum: UsageSummary): HTMLElement {
    const refs = this.providers.providers();
    const ids = [...new Set([...refs.map((r) => r.id), ...sum.byProvider.map((p) => p.provider)])];
    const limits = providerLimits.peek();
    const refresh = h(
      "button",
      { class: "icon-button usage-refresh", type: "button", "aria-label": "Refresh limits" },
      icon("refresh-cw"),
    );
    setTooltip(refresh, "Read the limits again (OpenRouter: asks for the key's credits)");
    this.render.add(on(refresh, "click", () => void this.run("agent.refreshUsageLimits")));
    const rows = ids.map((id) => {
      const ref = refs.find((r) => r.id === id);
      const used = sum.byProvider.find((p) => p.provider === id);
      return h(
        "div",
        { class: "ai-row usage-provider", "data-provider": id },
        h(
          "div",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name" }, ref?.name ?? this.providerName(id)),
          h(
            "span",
            { class: "ai-row-detail" },
            used ? detail(used) : `Nothing in the last ${this.period} days`,
          ),
          this.limitsFor(
            providerAgent(id) ? "acp" : (ref?.kind ?? null),
            ref?.baseUrl ?? "",
            limits[id],
          ),
        ),
        h("span", { class: "usage-amount" }, used ? money(used) : ""),
      );
    });
    return h(
      "section",
      { class: "ai-section usage-section" },
      h(
        "div",
        { class: "usage-section-head" },
        h("h2", { class: "ai-section-title" }, "Providers and limits"),
        refresh,
      ),
      h(
        "p",
        { class: "ai-section-lead" },
        "Rate limits as the provider's last response reported them (Anthropic, OpenAI and compatible servers send them as headers); for OpenRouter, the API key's own spending limit from its key endpoint (your account balance is on openrouter.ai).",
      ),
      rows.length
        ? h("div", { class: "ai-list" }, ...rows)
        : h(
            "div",
            { class: "ai-list" },
            h("div", { class: "ai-row usage-empty" }, "No providers yet."),
          ),
    );
  }

  private limitsFor(
    kind: string | null,
    baseUrl: string,
    l: ProviderLimits | undefined,
  ): HTMLElement {
    const lines: HTMLElement[] = [];
    if (kind === "acp")
      lines.push(
        h(
          "div",
          { class: "usage-note" },
          "An external agent: tokens and cost as it reports them (Claude Code, Codex and Gemini CLI send tokens; Claude Code also a cost at API prices). It may bill your subscription (ChatGPT, Claude) rather than API credits, which the IDE can't tell: a cost it doesn't report shows as —, not $0. Its own limits are in the agent (/status, /usage).",
        ),
      );
    const now = Date.now();
    for (const b of l?.rate?.buckets ?? []) {
      const at = resetAt(b.reset, l?.rate?.observedAt ?? now);
      const resets = at === null ? "" : ` · resets ${formatIn(at - now)}`;
      const text =
        b.limit !== null && b.remaining !== null
          ? `${b.remaining.toLocaleString()} of ${b.limit.toLocaleString()} left${resets}`
          : b.remaining !== null
            ? `${b.remaining.toLocaleString()} left${resets}`
            : `${(b.limit ?? 0).toLocaleString()} per window${resets}`;
      lines.push(
        b.limit && b.remaining !== null
          ? h(
              "div",
              { class: "usage-limit", "data-bucket": b.name },
              h("span", { class: "usage-limit-name" }, bucketLabel(b.name)),
              this.bar(1 - b.remaining / b.limit, text),
            )
          : h(
              "div",
              { class: "usage-limit", "data-bucket": b.name },
              h("span", { class: "usage-limit-name" }, bucketLabel(b.name)),
              h("span", { class: "usage-meter-label" }, text),
            ),
      );
    }
    if (l?.rate && l.rate.status === 429)
      lines.push(h("div", { class: "usage-note" }, "The last request hit the limit (429)."));
    const c = l?.credits;
    if (c) {
      const used = [
        c.usageDaily !== null ? `today ${formatCost(c.usageDaily) || "$0"}` : "",
        c.usageWeekly !== null ? `this week ${formatCost(c.usageWeekly) || "$0"}` : "",
        c.usageMonthly !== null ? `this month ${formatCost(c.usageMonthly) || "$0"}` : "",
      ].filter(Boolean);
      lines.push(
        c.limit !== null && c.remaining !== null
          ? h(
              "div",
              { class: "usage-limit", "data-bucket": "credits" },
              h("span", { class: "usage-limit-name" }, "Key limit"),
              this.bar(
                c.limit > 0 ? 1 - c.remaining / c.limit : 1,
                `${formatCost(c.remaining) || "$0"} of ${formatCost(c.limit)} left${c.limitReset ? ` · resets ${c.limitReset}` : ""}`,
              ),
            )
          : h(
              "div",
              { class: "usage-limit", "data-bucket": "credits" },
              h("span", { class: "usage-limit-name" }, "Key limit"),
              h(
                "span",
                { class: "usage-meter-label" },
                `No limit on this key${c.usage !== null ? ` · ${formatCost(c.usage) || "$0"} used` : ""}`,
              ),
            ),
      );
      // OpenRouter tells an API key its own spending limit, not the account's balance (that
      // needs a management key): said plainly, so $50 of $50 isn't read as money left.
      lines.push(
        h(
          "div",
          { class: "usage-note" },
          "The spending limit set on this API key, not your account balance: see your credits on openrouter.ai.",
        ),
      );
      if (used.length)
        lines.push(
          h(
            "div",
            { class: "usage-note" },
            `Billed by OpenRouter: ${used.join(" · ")}${c.freeTier ? " · free tier" : ""}`,
          ),
        );
    } else if (l?.creditsError)
      lines.push(h("div", { class: "usage-note" }, `Credits not read: ${l.creditsError}`));
    if (!lines.length) {
      const why =
        kind === "ollama"
          ? "Limits: not reported (runs locally)"
          : kind === "anthropic" || kind === "openai"
            ? isOpenRouter(baseUrl)
              ? "Limits: not reported yet"
              : "Limits: not reported yet — they show after its next request, if it sends them"
            : "Limits: not reported";
      lines.push(h("div", { class: "usage-note usage-not-reported" }, why));
    }
    return h("div", { class: "usage-limits" }, ...lines);
  }

  private chatsSection(sum: UsageSummary, now: number): HTMLElement {
    const rows = sum.topChats.map((c) => {
      const title = this.titles.get(c.session) ?? "Deleted chat";
      const known = this.titles.has(c.session);
      const row = h(
        "button",
        {
          class: "ai-row usage-row usage-top-chat",
          type: "button",
          "data-session": c.session,
          disabled: !known,
        },
        h(
          "span",
          { class: "ai-row-main" },
          h("span", { class: "ai-row-name usage-name" }, title),
          h("span", { class: "ai-row-detail" }, `${detail(c)} · ${relativeAge(c.last, now)}`),
        ),
        h("span", { class: "usage-amount" }, money(c)),
      );
      if (known) {
        setTooltip(row, "Open this chat");
        this.render.add(
          on(row, "click", () => void this.run("agent.openSession", { session: c.session })),
        );
      }
      return row;
    });
    return this.section(
      "Top chats",
      rows.length ? `The chats that cost the most in the last ${this.period} days.` : null,
      h(
        "div",
        { class: "ai-list" },
        ...(rows.length
          ? rows
          : [h("div", { class: "ai-row usage-empty" }, "No chats in this period.")]),
      ),
    );
  }

  private footer(sum: UsageSummary): HTMLElement {
    const clear = h(
      "button",
      { class: "button button-secondary usage-clear", type: "button", disabled: sum.records === 0 },
      icon("trash-2"),
      h("span", null, "Clear usage history"),
    );
    this.render.add(on(clear, "click", () => void this.run("agent.clearUsageHistory")));
    const off = this.services.settings.peek<boolean>("agent.usage.keepHistory") === false;
    return h(
      "div",
      { class: "usage-footer" },
      h(
        "p",
        { class: "ai-section-lead" },
        off
          ? "The history is off (agent.usage.keepHistory): new requests aren't logged."
          : sum.since
            ? `Kept since ${new Date(sum.since).toLocaleDateString()} (${plural(sum.records, "request")}). Costs come from the provider when it reports them (OpenRouter), else from prices (agent.prices, the provider's list, built-in list prices); local models cost nothing.`
            : "Nothing logged yet. Each request the agent or an AI feature makes is added here.",
      ),
      clear,
    );
  }

  focus(): void {
    this.element.focus();
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerUsagePage(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  sessions: SessionManager,
): void {
  const { dispatcher, dock } = services;
  const descriptor: DockViewDescriptor = {
    type: "agent.usage",
    title: () => "Usage",
    icon: () => "chart-column",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) => new UsageView(services, providers, sessions, state),
  };
  sub.add(dock.views.register(descriptor));
  sub.add(
    dispatcher.register({
      id: "agent.showUsage",
      title: "Show usage",
      category: "Agent",
      description:
        "Opens the Usage page: requests, tokens and cost of the agent and the AI features today, in 7 and 30 days, per day, by model, feature and provider, the chats that cost the most, this chat with its budget, and the limits providers report. The same data is at ide://agent/usage/history and ide://agent/usage/limits.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => ({ tabId: dock.openView("agent.usage", null, "main", true) }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.clearUsageHistory",
      title: "Clear usage history…",
      category: "Agent",
      description:
        "Deletes the local usage log (every request's tokens and cost kept for the Usage page). Open chats keep their own totals. Asks first when run by the user.",
      input: s.empty(),
      effects: ["destructive"],
      agent: "hidden",
      run: async (_input, ctx) => {
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            "Clear usage history?",
            "Deletes the log of requests, tokens and costs kept on this computer. Open chats keep their own totals. This can't be undone.",
            "Clear",
            true,
          ))
        )
          return { cleared: false };
        const files = await clearUsage();
        return { cleared: true, files };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.refreshUsageLimits",
      title: "Refresh provider limits",
      category: "Agent",
      description:
        "Reads what each model provider reports about its limits: the rate-limit headers of its last response this run (requests and tokens left, when they reset; Anthropic, OpenAI and compatible servers) and, for OpenRouter, the API key's credits (limit, remaining, used today / this week / this month), fetched with the key kept in Rust. Providers that report nothing have no entry beyond null.",
      input: s.empty(),
      effects: ["network"],
      run: async () => {
        const refs = providers.providers();
        const all = await refreshLimits(refs);
        return Object.fromEntries(
          refs.map((r) => [
            r.id,
            { name: r.name, ...(all[r.id] ?? { rate: null, credits: null }) },
          ]),
        );
      },
    }),
  );
}
