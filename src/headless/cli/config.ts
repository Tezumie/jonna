// From the arguments to what a run is told: the permission policy, the settings that hold for
// the run only, its limits, and which model and agent. Precedence: a flag wins over the app's
// settings (the user's, then the folder's), and what no flag names is left to them: nothing here
// invents a default the settings would otherwise give. Pure.
import type { RunLimits, UnattendedPolicy } from "../run";
import { type CliArgs, closest, UsageError } from "./args";

/**
 * The run's permission policy. `ask`: somebody can answer (a terminal, an attached client), so
 * what neither the mode nor a list decides waits for them; else it is refused.
 */
export function policyOf(args: CliArgs, ask: boolean): UnattendedPolicy {
  return {
    ...(args.permissionMode && { mode: args.permissionMode }),
    ...(args.allow.length && { allow: [...args.allow] }),
    ...(args.deny.length && { deny: [...args.deny] }),
    otherwise: ask ? "wait" : "deny",
  };
}

/**
 * Whether edits stay under review (written to the files as in the app, and kept or put back
 * when the person accepts or rejects them). `--review`: yes. Else the access mode's own answer
 * when one was given (ask: reviewed; the others: accepted at once). Else, in a one-shot run,
 * accepted at once (nobody is there to review); in a session, undefined: the app's own choice
 * for this folder.
 */
export function reviewOf(args: CliArgs, oneShot: boolean): boolean | undefined {
  if (args.review) return true;
  if (args.permissionMode) return args.permissionMode === "ask";
  return oneShot ? false : undefined;
}

export function limitsOf(args: CliArgs): RunLimits {
  return {
    ...(args.maxSteps !== undefined && { maxSteps: args.maxSteps }),
    ...(args.maxCost !== undefined && { maxCost: args.maxCost }),
    ...(args.timeout !== undefined && { timeoutMs: Math.round(args.timeout * 1000) }),
  };
}

export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

/** What is known once the brain has started: the names a flag may mean. */
export interface KnownAgents {
  /** External agents (ACP), by their names in the settings. */
  external: readonly string[];
  /** The user's own agents and chat modes: their ids (`custom:<name>`) and names. */
  custom: readonly { id: string; name: string }[];
}

export interface ModelChoice {
  /** For `open`: "<provider>/<model>", a model's name, or "acp/<agent>". */
  model?: string;
  /** With an external agent: its own model and its reasoning level. */
  agentModel?: string;
  agentLevel?: string;
  /** `custom:<name>`: one of the user's agents. */
  agentMode?: string;
  /** agent, plan or ask. */
  workMode?: string;
  /** Settings for the run only (the built-in agent's effort). */
  settings: Record<string, unknown>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Which model, agent, effort and mode the flags ask for. `--model` is a provider's model
 * ("provider/model" or a model's name), or an external agent with an optional model of its own
 * ("Claude Code", "Claude Code:opus", "acp/Claude Code"). `--agent` is one of the user's agents or
 * an external agent, by name. `--effort` goes to whichever answers.
 */
export function modelChoice(args: CliArgs, known: KnownAgents): ModelChoice {
  const choice: ModelChoice = { settings: {} };
  const external = (name: string) => known.external.find((n) => same(n, name));

  if (args.model !== undefined) {
    const text = args.model.trim().replace(/^acp\//i, (m) => m.toLowerCase());
    const asAgent = text.startsWith("acp/") ? text.slice(4) : text;
    const whole = external(asAgent);
    const colon = asAgent.indexOf(":");
    const head = colon > 0 ? external(asAgent.slice(0, colon)) : undefined;
    if (whole) choice.model = `acp/${whole}`;
    else if (head) {
      choice.model = `acp/${head}`;
      choice.agentModel = asAgent.slice(colon + 1);
    } else if (text.startsWith("acp/"))
      throw new UsageError(
        `No external agent named ${asAgent}.${known.external.length ? ` There are: ${known.external.join(", ")}.` : ""}`,
      );
    else choice.model = text;
  }

  if (args.agent !== undefined) {
    const name = args.agent.trim();
    const ext = external(name);
    const custom = known.custom.find(
      (c) => same(c.name, name) || same(c.id, name) || same(c.id, `custom:${name}`),
    );
    if (custom) choice.agentMode = custom.id;
    else if (ext) {
      if (choice.model && !choice.model.startsWith("acp/")) {
        // "--agent <external> --model x": the model is that agent's own.
        choice.agentModel = choice.model;
      } else if (choice.model && choice.model !== `acp/${ext}`)
        throw new UsageError("--model names another external agent than --agent.");
      choice.model = `acp/${ext}`;
    } else {
      const names = [...known.custom.map((c) => c.name), ...known.external];
      const hit = closest(name, names);
      throw new UsageError(
        `No agent named ${name}.${hit ? ` Did you mean ${hit}?` : ""}${names.length ? ` There are: ${names.join(", ")}.` : ""}`,
      );
    }
  }

  if (args.effort !== undefined) {
    const level = args.effort.trim().toLowerCase();
    if (choice.model?.startsWith("acp/")) choice.agentLevel = level;
    else {
      if (!(EFFORTS as readonly string[]).includes(level))
        throw new UsageError(`--effort is one of ${EFFORTS.join(", ")}; got "${args.effort}".`);
      choice.settings["agent.effort"] = level;
    }
  }
  if (args.mode !== undefined) choice.workMode = args.mode;
  return choice;
}

/**
 * The prompt of a one-shot run: the argument, the file's text or standard input; piped input
 * given together with a prompt is added after it as context.
 */
export function composePrompt(prompt: string | undefined, piped: string | undefined): string {
  const typed = (prompt ?? "").trim();
  const input = (piped ?? "").replace(/^﻿/, "").replace(/\s+$/, "");
  if (typed && input.trim()) return `${typed}\n\n<stdin>\n${input}\n</stdin>`;
  return typed || input.trim();
}
