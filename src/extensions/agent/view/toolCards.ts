// The chat's cards for ask_user (D312), report_findings (D313) and suggest_extension (D314).
// Plain DOM with tokens; what a card does goes through the host to commands (agent.answer,
// agent.fixFindings, agent.installSuggestedExtension, editor links). The cards are rebuilt when
// their item changes (answered, installed), so their own state is only what's picked meanwhile.

import {
  type AskAnswers,
  type AskCard,
  type AskQuestion,
  picksOf,
  previewText,
  questionKey,
  SKIPPED,
  skipAll,
} from "../../../core/agent/askUser";
import type { ExtensionSuggestion } from "../../../core/agent/extensionSuggest";
import { type FindingsCard, findingTarget } from "../../../core/agent/findings";
import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { verifiedMark } from "../../extensions/parts";
import { storeAvatar } from "../../extensions/storeMedia";

export interface ToolCardHost {
  openLink(href: string): void;
  /** Runs a command as the user's click. */
  run?(command: string, input?: unknown): void;
  /** Sends a typed answer (one question); undefined when the card can't be answered now. */
  choose?(text: string): void;
  /** Sends every question's answer (several questions). */
  answer?(answers: AskAnswers): void;
  /** The answer typed or picked, as one line (one question, or a reply typed in the chat). */
  chosen?: string;
  /** Each question's answer, once answered (several questions). */
  answers?: AskAnswers;
  /** The session and tool call the card is for. */
  session?: string;
  item?: string;
  /** Extension ids being installed from this card now. */
  installing?: ReadonlySet<string>;
}

// ---- ask_user --------------------------------------------------------------------------------

/** The radio (one pick) or checkbox (several) at the start of an option's row (D335). */
function choiceMark(multi: boolean, on: boolean): HTMLElement {
  return h(
    "span",
    {
      class: { "rb-choice-mark": true, "is-check": multi, "is-radio": !multi, "is-on": on },
      "aria-hidden": "true",
    },
    multi && on ? icon("check") : null,
  );
}

/**
 * ask_user's card, as Claude Code's AskUserQuestion card (D335): the question in a header area,
 * the options as rows with a radio (a checkbox for several picks) and the description under the
 * label, the picked row highlighted, a last "Other" row to type in, and a footer with Skip and
 * Submit (Ctrl+Enter). One question works as before: a click answers (with several picks,
 * Submit). Several show their header chips as tabs, a pick moves on to the next unanswered one,
 * Skip skips the question on screen, and Submit sends them all. An option's preview shows beside
 * the options (below them in a narrow chat) while it's focused or hovered.
 * Keys: 1–9 pick, ↑↓ move between options, ←→ between questions, Ctrl+Enter submits.
 */
export function askCard(card: AskCard, host: ToolCardHost): HTMLElement {
  const answering = !!(host.choose || host.answer);
  const several = card.questions.length > 1;
  if (!answering && (host.answers || host.chosen !== undefined)) return answeredCard(card, host);
  // What's picked so far, per question: the options, the user's own words, or skipped.
  const picks = card.questions.map(() => new Set<string>());
  const others = card.questions.map(() => "");
  const skipped = card.questions.map(() => false);
  let current = 0;

  const answerOf = (i: number): string => {
    if (skipped[i]) return SKIPPED;
    const q = card.questions[i] as AskQuestion;
    const chosen = q.options.map((o) => o.label).filter((l) => picks[i]?.has(l));
    const other = others[i]?.trim() ?? "";
    return [...chosen, ...(other ? [other] : [])].join(", ");
  };
  const allAnswered = () => card.questions.every((_, i) => answerOf(i) !== "");

  const root = h("div", {
    class: { rb: true, "rb-choices": true, "rb-ask": true, "is-several": several },
    tabindex: "-1",
  });
  const tabs = several ? h("div", { class: "rb-ask-tabs", role: "tablist" }) : null;
  const panel = h("div", { class: "rb-ask-panel" });
  // One question: Submit sends the picks or the typed answer (a single pick sends on its own).
  const submit = h(
    "button",
    {
      class: {
        button: true,
        "button-primary": true,
        "rb-ask-submit": true,
        "rb-choices-send": !several,
      },
      type: "button",
      disabled: "",
    },
    "Submit",
  ) as HTMLButtonElement;
  const skip = h(
    "button",
    { class: "button button-ghost rb-ask-skip", type: "button" },
    "Skip",
  ) as HTMLButtonElement;
  setTooltip(skip, several ? "Skip this question" : "Skip the question: the agent decides");
  const hint = h("div", { class: "rb-choices-hint" });

  const send = () => {
    if (several) {
      if (!allAnswered() || !host.answer) return;
      host.answer(
        Object.fromEntries(card.questions.map((q, i) => [questionKey(q, i), answerOf(i)])),
      );
    } else {
      const a = answerOf(0);
      if (a && host.choose) host.choose(a);
    }
  };
  on(submit, "click", send);
  on(skip, "click", () => {
    if (!several) {
      host.answer?.(skipAll(card));
      return;
    }
    skipped[current] = true;
    picks[current]?.clear();
    others[current] = "";
    const next = nextOpen(current);
    show(next >= 0 ? next : current, true);
    if (next < 0) submit.focus();
  });

  /** Submit's state and the hint, after any change. */
  const refresh = () => {
    submit.disabled = several ? !allAnswered() : answerOf(0) === "";
    hint.replaceChildren(
      several
        ? allAnswered()
          ? "All answered."
          : "Answer each question."
        : card.questions[0]?.multiSelect
          ? "Pick one or more, or type your own."
          : "Pick one, or type your own.",
      " ",
      h("kbd", { class: "rb-ask-kbd" }, "Ctrl+Enter"),
      " submits",
    );
  };

  const drawTabs = () => {
    refresh();
    if (!tabs) return;
    tabs.replaceChildren(
      ...card.questions.map((q, i) => {
        const done = answerOf(i) !== "";
        const tab = h(
          "button",
          {
            class: {
              "rb-ask-tab": true,
              "is-current": i === current,
              "is-done": done,
              "is-skipped": !!skipped[i],
            },
            type: "button",
            role: "tab",
            "aria-selected": String(i === current),
          },
          skipped[i]
            ? icon("minus")
            : done
              ? icon("check")
              : h("span", { class: "rb-ask-tab-number" }, String(i + 1)),
          h("span", { class: "rb-ask-tab-label" }, q.header || `Question ${i + 1}`),
        );
        setTooltip(tab, skipped[i] ? `${q.question} (skipped)` : q.question);
        on(tab, "click", () => show(i));
        return tab;
      }),
    );
  };

  /** The next question without an answer after `i` (wrapping), or -1. */
  const nextOpen = (i: number) => {
    for (let k = 1; k <= card.questions.length; k++) {
      const j = (i + k) % card.questions.length;
      if (answerOf(j) === "") return j;
    }
    return -1;
  };

  const show = (i: number, focus = false) => {
    current = i;
    const q = card.questions[i] as AskQuestion;
    panel.replaceChildren(questionPanel(q, i, focus));
    drawTabs();
  };

  const questionPanel = (q: AskQuestion, i: number, focus: boolean): HTMLElement => {
    const set = picks[i] as Set<string>;
    const multi = !!q.multiSelect;
    const hasPreview = q.options.some((o) => o.preview);
    const preview = hasPreview ? h("pre", { class: "rb-ask-preview" }) : null;
    const showPreview = (label: string | undefined) => {
      if (!preview) return;
      const option =
        q.options.find((o) => o.label === label && o.preview) ??
        q.options.find((o) => set.has(o.label) && o.preview) ??
        q.options.find((o) => o.preview);
      preview.textContent = option?.preview ? previewText(option.preview) : "";
      preview.dataset.option = option?.label ?? "";
    };
    /** A row's look follows whether it's picked. */
    const mark = (button: HTMLElement, isOn: boolean) => {
      button.classList.toggle("is-selected", isOn);
      if (multi) button.setAttribute("aria-pressed", String(isOn));
      button.firstElementChild?.replaceWith(choiceMark(multi, isOn));
    };
    const buttons = q.options.map((o, n) => {
      const picked = set.has(o.label);
      const button = h(
        "button",
        {
          class: { "rb-choice": true, "is-selected": picked },
          type: "button",
          "data-index": String(n + 1),
          ...(multi && { "aria-pressed": String(picked) }),
        },
        choiceMark(multi, picked),
        h(
          "span",
          { class: "rb-choice-text" },
          h("span", { class: "rb-choice-label" }, o.label),
          o.description ? h("span", { class: "rb-choice-note" }, o.description) : null,
        ),
        h("span", { class: "rb-choice-key", "aria-hidden": "true" }, String(n + 1)),
      );
      if (!answering) button.setAttribute("disabled", "");
      on(button, "pointerover", () => showPreview(o.label));
      on(button, "focus", () => showPreview(o.label));
      on(button, "click", () => {
        if (!answering) return;
        skipped[i] = false;
        if (multi) {
          // A pick toggles; Submit sends them together.
          if (set.has(o.label)) set.delete(o.label);
          else set.add(o.label);
          mark(button, set.has(o.label));
          drawTabs();
          return;
        }
        set.clear();
        set.add(o.label);
        others[i] = "";
        if (!several) return send();
        // On to the next question still open (or stay, all answered, for Submit).
        const next = nextOpen(i);
        show(next >= 0 ? next : i, true);
        if (next < 0) submit.focus();
      });
      return button;
    });
    // The last row: the user's own answer, typed in place.
    const other = h("input", {
      class: "rb-ask-other",
      type: "text",
      placeholder: multi ? "Other: add your own" : "Other: type your own answer",
      "aria-label": `Your own answer to: ${q.question || q.header || "the question"}`,
      value: others[i] ?? "",
    }) as HTMLInputElement;
    const otherRow = h(
      "label",
      { class: { "rb-ask-other-row": true, "is-selected": !!others[i]?.trim() } },
      choiceMark(multi, !!others[i]?.trim()),
      other,
    );
    if (!answering) other.disabled = true;
    on(other, "input", () => {
      others[i] = other.value;
      skipped[i] = false;
      const typed = !!other.value.trim();
      otherRow.classList.toggle("is-selected", typed);
      otherRow.firstElementChild?.replaceWith(choiceMark(multi, typed));
      // Typed words replace a single pick.
      if (!multi && typed && set.size) {
        set.clear();
        for (const b of buttons) mark(b, false);
      }
      drawTabs();
    });
    on(other, "keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!other.value.trim()) return;
      if (!several) return send();
      const next = nextOpen(i);
      if (next >= 0) show(next, true);
      else send();
    });
    showPreview(undefined);
    const list = h(
      "div",
      { class: "rb-choices-list", ...(multi && { role: "group" }) },
      ...buttons,
    );
    const body = h(
      "div",
      { class: { "rb-ask-body": true, "has-preview": hasPreview } },
      h("div", { class: "rb-ask-options" }, list, otherRow),
      preview,
    );
    const out = h(
      "div",
      { class: "rb-ask-question" },
      q.question
        ? h(
            "div",
            { class: "rb-ask-header" },
            h("div", { class: "rb-choices-prompt" }, q.question),
            skipped[i] ? h("span", { class: "rb-ask-chip" }, "Skipped") : null,
          )
        : null,
      body,
    );
    if (focus) queueMicrotask(() => buttons[0]?.focus({ preventScroll: true }));
    return out;
  };

  on(root, "keydown", (e) => {
    if (!answering) return;
    // Ctrl+Enter submits from anywhere in the card, the typed answer too.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      if (!submit.disabled) send();
      return;
    }
    if ((e.target as HTMLElement).closest("input")) return;
    const q = card.questions[current];
    if (!q) return;
    const options = [...root.querySelectorAll<HTMLButtonElement>(".rb-ask-panel .rb-choice")];
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    if (/^[1-9]$/.test(e.key)) {
      const pick = options[Number(e.key) - 1];
      if (!pick) return;
      e.preventDefault();
      pick.focus();
      pick.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // Down from the last option goes to the Other field.
      if (e.key === "ArrowDown" && at === options.length - 1) {
        root.querySelector<HTMLInputElement>(".rb-ask-panel .rb-ask-other")?.focus();
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      options[(at + step + options.length) % options.length]?.focus();
    } else if (several && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      show((current + step + card.questions.length) % card.questions.length, true);
    }
  });

  show(0);
  root.append(
    ...(tabs ? [tabs] : []),
    panel,
    ...(answering
      ? [
          h(
            "div",
            { class: "rb-ask-footer" },
            hint,
            h("span", { class: "rb-ask-buttons" }, skip, submit),
          ),
        ]
      : []),
  );
  return root;
}

/** An answered card: each question with what was picked (or typed), or that it was skipped. */
function answeredCard(card: AskCard, host: ToolCardHost): HTMLElement {
  const several = card.questions.length > 1;
  // A reply typed in the chat instead of the card's answers.
  const typed = !host.answers ? (host.chosen ?? "") : "";
  return h(
    "div",
    { class: { rb: true, "rb-choices": true, "rb-ask": true, "is-answered": true } },
    ...card.questions.map((q, i) => {
      const answer = host.answers?.[questionKey(q, i)] ?? (several ? undefined : typed);
      const wasSkipped = answer === SKIPPED;
      const { picks, other } = picksOf(q, answer);
      return h(
        "div",
        { class: { "rb-ask-question": true, "is-skipped": wasSkipped } },
        several && q.header ? h("span", { class: "rb-ask-chip" }, q.header) : null,
        q.question
          ? h(
              "div",
              { class: "rb-ask-header" },
              h("div", { class: "rb-choices-prompt" }, q.question),
              wasSkipped ? h("span", { class: "rb-ask-chip rb-ask-skipped" }, "Skipped") : null,
            )
          : null,
        h(
          "div",
          { class: "rb-choices-list" },
          ...q.options.map((o) =>
            h(
              "button",
              {
                class: { "rb-choice": true, "is-chosen": picks.includes(o.label) },
                type: "button",
                disabled: "",
              },
              choiceMark(!!q.multiSelect, picks.includes(o.label)),
              h(
                "span",
                { class: "rb-choice-text" },
                h("span", { class: "rb-choice-label" }, o.label),
                o.description ? h("span", { class: "rb-choice-note" }, o.description) : null,
              ),
            ),
          ),
          other
            ? h(
                "button",
                { class: "rb-choice is-chosen", type: "button", disabled: "" },
                choiceMark(!!q.multiSelect, true),
                h("span", { class: "rb-choice-text" }, other),
              )
            : null,
        ),
      );
    }),
    several && typed ? h("div", { class: "rb-choices-hint" }, `Replied: ${typed}`) : null,
  );
}

// ---- report_findings -------------------------------------------------------------------------

const OUTCOME_LABEL: Record<string, string> = {
  fixed: "Fixed",
  skipped: "Skipped",
  no_change_needed: "No change needed",
};

/**
 * report_findings' card: a row per finding (its short summary, file:line, category), opening the
 * file at the line; the sentence and failure scenario under it; Fix per finding and Fix all ask
 * the agent to fix them. A re-report shows each one's outcome.
 */
export function findingsCard(card: FindingsCard, host: ToolCardHost): HTMLElement {
  const open = card.findings.filter((f) => !f.outcome);
  const fix = (index?: number) =>
    host.run?.("agent.fixFindings", {
      ...(host.session && { session: host.session }),
      ...(host.item && { item: host.item }),
      ...(index !== undefined && { index }),
    });
  const fixAll =
    host.run && open.length > 1
      ? h(
          "button",
          { class: "button button-secondary button-sm rb-findings-fix-all", type: "button" },
          "Fix all",
        )
      : null;
  if (fixAll) on(fixAll, "click", () => fix());
  const count = card.findings.length;
  return h(
    "div",
    { class: "rb rb-findings" },
    h(
      "div",
      { class: "rb-findings-head" },
      icon("list-checks"),
      h(
        "span",
        { class: "rb-findings-title" },
        count ? `${count} review finding${count === 1 ? "" : "s"}` : "No findings",
      ),
      fixAll,
    ),
    count
      ? h(
          "ol",
          { class: "rb-findings-list" },
          ...card.findings.map((f, i) => {
            const target = findingTarget(f);
            const openButton = h(
              "button",
              { class: "rb-finding-open", type: "button" },
              h("span", { class: "rb-finding-title" }, f.shortSummary),
              h(
                "span",
                { class: "rb-finding-meta" },
                h("span", { class: "rb-finding-file" }, target),
                f.category ? h("span", { class: "rb-finding-category" }, f.category) : null,
                f.verdict === "PLAUSIBLE"
                  ? h("span", { class: "rb-finding-category" }, "plausible")
                  : null,
              ),
            );
            setTooltip(openButton, `Open ${target}`);
            on(openButton, "click", () => host.openLink(target));
            const fixButton =
              host.run && !f.outcome
                ? h(
                    "button",
                    { class: "button button-secondary button-sm rb-finding-fix", type: "button" },
                    "Fix",
                  )
                : null;
            if (fixButton) on(fixButton, "click", () => fix(i + 1));
            return h(
              "li",
              { class: { "rb-finding": true, [`is-${f.outcome ?? "open"}`]: true } },
              h(
                "div",
                { class: "rb-finding-row" },
                openButton,
                f.outcome
                  ? h(
                      "span",
                      { class: { "rb-finding-outcome": true, [`is-${f.outcome}`]: true } },
                      f.outcome === "fixed" ? icon("check") : null,
                      OUTCOME_LABEL[f.outcome] ?? f.outcome,
                    )
                  : null,
                fixButton,
              ),
              h("div", { class: "rb-finding-summary" }, f.summary),
              f.failureScenario
                ? h("div", { class: "rb-finding-scenario" }, f.failureScenario)
                : null,
            );
          }),
        )
      : h("div", { class: "rb-choices-hint" }, "The review found nothing to fix."),
  );
}

// ---- suggest_extension -----------------------------------------------------------------------

/**
 * suggest_extension's card: each extension with its icon, name (opens its store page), publisher
 * and verified mark, what it does, and Install (Installed once it is).
 */
export function extensionsCard(s: ExtensionSuggestion, host: ToolCardHost): HTMLElement {
  return h(
    "div",
    { class: "rb rb-extensions" },
    s.reason ? h("div", { class: "rb-extensions-reason" }, s.reason) : null,
    ...s.items.map((x) => {
      const installing = host.installing?.has(x.id.toLowerCase()) ?? false;
      const button = h(
        "button",
        {
          class: {
            button: true,
            "button-sm": true,
            "button-primary": !x.installed,
            "button-secondary": !!x.installed,
            "rb-extension-install": true,
          },
          type: "button",
          ...((x.installed || installing || !host.run) && { disabled: "" }),
        },
        x.installed ? "Installed" : installing ? "Installing…" : "Install",
      );
      if (!x.installed && host.run)
        on(button, "click", () =>
          host.run?.("agent.installSuggestedExtension", {
            ...(host.session && { session: host.session }),
            item: host.item ?? "",
            id: x.id,
          }),
        );
      const name = h("button", { class: "rb-extension-name", type: "button" }, x.displayName);
      setTooltip(name, `Show ${x.id} in the store`);
      on(name, "click", () => host.run?.("extensions.showStoreDetails", { id: x.id }));
      return h(
        "div",
        { class: "rb-extension" },
        storeAvatar({
          id: x.id,
          displayName: x.displayName,
          ...(x.iconUrl && { iconUrl: x.iconUrl }),
        }),
        h(
          "div",
          { class: "rb-extension-text" },
          h(
            "div",
            { class: "rb-extension-title" },
            name,
            h("span", { class: "rb-extension-publisher" }, x.publisher),
            x.verified ? verifiedMark() : null,
          ),
          x.description ? h("div", { class: "rb-extension-description" }, x.description) : null,
        ),
        button,
      );
    }),
  );
}
