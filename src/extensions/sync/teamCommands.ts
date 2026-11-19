// The Team page's own command: publishing to the team's library by picking, step by step (the
// kind, which of the user's own, and, for the team's owner, who it is on for). It drives the picker and then runs
// the team extension's `team.publish` for each thing chosen, through the dispatcher: nothing is
// imported from that extension, and what may be published is decided there, not here.
import { QUIET_USER } from "../../core/dispatcher/index";
import { parseExtensionsJson } from "../../core/extensions/recommendations";
import { accountsIpc } from "../../core/ipc/accounts";
import { fsIpc } from "../../core/ipc/fs";
import { syncIpc } from "../../core/ipc/sync";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { parseMcpConfig } from "../../core/settings/vscodeImport";
import { TEAM_KINDS, type TeamKind } from "../../core/team/items";
import { extensionsForTeam } from "../../core/team/publish";
import { teamMaySet } from "../../core/team/settings";
import type { WorkbenchServices } from "../../workbench/services";
import type { SyncCommandParts } from "./commands";
import { countOf } from "./model";
import {
  kindHeading,
  modeChoices,
  modeInput,
  type OwnItem,
  ownItems,
  type PublishOutcome,
  publishFailure,
  publishOutcome,
  publishReport,
  TEAM_GROUPS,
  type TeamLibrary,
  teamLibraryOf,
} from "./teamPage.model";

/** A thing to choose in a step: what `team.publish` is given for it, and how it reads. */
interface Choice extends OwnItem {
  description?: string;
  /** Checked from the start (what the team already recommends). */
  checked?: boolean;
}

/** How a setting's value reads beside its key: short, on one line. */
function valueWords(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * A pick where several rows are checked (a click or Space checks one, Enter accepts): the
 * chosen ones, or null when it was dismissed.
 */
function pickMany(
  services: WorkbenchServices,
  choices: readonly Choice[],
  placeholder: string,
): Promise<Choice[] | null> {
  let checked = choices.flatMap((choice, index) => (choice.checked ? [index] : []));
  return new Promise((resolve) => {
    let done = false;
    const session = services.quickInput.openSession(
      "pick",
      {
        items: choices.map((choice) => ({
          label: choice.label,
          ...(choice.description && { description: choice.description }),
        })),
        canSelectMany: true,
        selectedIndexes: checked,
        matchOnDescription: true,
        placeholder,
      },
      {
        value: () => {},
        active: () => {},
        selection: (indexes) => {
          checked = indexes;
        },
        accept: () => {
          if (done) return;
          done = true;
          resolve(
            [...checked]
              .sort((a, b) => a - b)
              .flatMap((index) => {
                const choice = choices[index];
                return choice ? [choice] : [];
              }),
          );
          session.hide();
        },
        button: () => {},
        itemButton: () => {},
        hide: () => {
          if (done) return;
          done = true;
          resolve(null);
        },
      },
    );
  });
}

export function registerTeamPageCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  { controller, session }: SyncCommandParts,
): void {
  const { dispatcher, notifications, quickInput, settings, state } = services;

  /** The team's library as the team extension has it now (ide://team). */
  const library = async (): Promise<TeamLibrary> =>
    teamLibraryOf((await state.get("ide://team", { budget: 1_000_000 })).value);

  /** Whether the team may have a setting as a default: known here, and not a folder's own. */
  const known = (key: string): boolean => {
    const schema = settings.registry.get(key);
    return !!schema && schema.scope !== "workspace";
  };

  /** The settings this person changed that a team may set, with their values. */
  const ownSettings = (): Choice[] =>
    settings.registry
      .all()
      .map((info) => ({ key: info.key, value: settings.model.inspect(info.key, "user") }))
      .filter(({ key, value }) => value !== undefined && teamMaySet(key, known, value))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, value }) => ({ path: key, label: key, description: valueWords(value) }));

  /** The servers of the user's own mcp.json, by name (none when there is no such file). */
  const ownServers = async (): Promise<Choice[]> => {
    const settingsFile = settings.filePath("user");
    if (!settingsFile) return [];
    const text = await fsIpc
      .read(joinPath(dirname(settingsFile), "mcp.json"))
      .then((bytes) => new TextDecoder().decode(bytes))
      .catch(() => null);
    const parsed = text === null ? null : parseJsonc(text);
    if (!parsed?.ok) return [];
    return Object.keys(parseMcpConfig(parsed.value).servers)
      .sort()
      .map((name) => ({ path: name, label: name }));
  };

  /**
   * The extensions that can be recommended: the installed ones, and the ones the team
   * recommends now (checked: publishing replaces the team's list, so they stay unless unchecked).
   */
  const ownExtensions = async (team: TeamLibrary): Promise<Choice[]> => {
    const snap = await state
      .get("ide://extensions?brief=1", { budget: 1_000_000 })
      .catch(() => null);
    const value = snap?.value;
    const listed =
      value && typeof value === "object" && "extensions" in value && Array.isArray(value.extensions)
        ? (value.extensions as unknown[])
        : [];
    const names = new Map<string, string>();
    for (const entry of listed) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id === "string") names.set(id, typeof name === "string" ? name : id);
    }
    const current = team.items.find((entry) => entry.kind === "extensions");
    const recommended = current
      ? await dispatcher
          .execute("team.readItem", { id: current.id })
          .then((result) =>
            result && typeof result === "object" && "text" in result
              ? parseExtensionsJson(String(result.text)).recommendations
              : [],
          )
          .catch(() => [])
      : [];
    // Only ids the library takes (publisher.name).
    const ids = extensionsForTeam([...recommended, ...names.keys()]).recommendations;
    return ids.map((id) => {
      const name = names.get(id);
      return {
        path: id,
        label: name && name !== id ? name : id,
        description: [name && name !== id ? id : null, names.has(id) ? null : "not installed here"]
          .filter(Boolean)
          .join(" · "),
        checked: recommended.includes(id),
      };
    });
  };

  sub.add(
    dispatcher.register({
      id: "sync.team.publish",
      title: "Publish to the team's library…",
      category: "Sync",
      description:
        "Asks, step by step, what of the user's own to publish to their team's library (publishers only): the kind (rules, skills, commands, agents, output styles, snippets, MCP servers, default settings, recommended extensions; `kind` skips that step), which of their own items of that kind, and, for the team's owner, who it is on for: optional (members add it), on by default (members can switch it off) or required (always on); a member who can publish isn't asked, theirs is optional. Then runs team.publish for each one chosen and says what was published and what wasn't, with why (a server with a secret written out, a setting a team can't set, a newer version someone else published meanwhile, an item only the owner may change). Needs the person at the picker; team.publish is the command without questions.",
      input: s.object({
        kind: s
          .enum(TEAM_KINDS)
          .describe("What to publish, skipping the first question")
          .optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ kind: given }) => {
        if (!controller) throw new Error("Sync runs only in the IDE's window.");
        const base = controller.base();
        if (!base)
          throw new Error("Sync needs an account, and this build has no accounts service.");
        const profile = await accountsIpc.profile(base).catch(() => null);
        if (JSON.stringify(profile) !== JSON.stringify(session.profile.peek()))
          session.profile.value = profile;
        if (!profile) throw new Error("Sign in to your account to use sync.");
        if (!dispatcher.has("team.publish") || !state.has("ide://team"))
          throw new Error("This build has no teams.");
        const team = await library();
        if (!team.team) throw new Error("This account isn't in a team: there is no library.");
        if (!team.team.publisher)
          throw new Error(
            `Only the publishers of ${team.team.name} can change its library: ask the team's owner to make you one.`,
          );
        if (team.state === "lapsed")
          throw new Error(
            "The team's subscription ended: its library can be read, not changed, until the owner renews it.",
          );
        const cancelled = { published: [], notPublished: [], cancelled: true };

        // What this person has of each kind, so a kind without anything isn't offered.
        const files = (await syncIpc.userFiles()).files.map((file) => file.path);
        const own: Record<TeamKind, Choice[]> = {
          rules: ownItems("rules", files),
          skills: ownItems("skills", files),
          commands: ownItems("commands", files),
          agents: ownItems("agents", files),
          outputStyles: ownItems("outputStyles", files),
          snippets: ownItems("snippets", files),
          mcp: await ownServers(),
          settings: ownSettings(),
          extensions: await ownExtensions(team),
        };
        const counts: Record<TeamKind, (n: number) => string> = {
          rules: () => "Your AGENTS.md",
          skills: (n) => `${countOf(n, "skill")} of your own`,
          commands: (n) => `${countOf(n, "command")} of your own`,
          agents: (n) => `${countOf(n, "agent")} of your own`,
          outputStyles: (n) => `${countOf(n, "output style")} of your own`,
          snippets: (n) => `${countOf(n, "snippet file")} of your own`,
          mcp: (n) => `${countOf(n, "server")} in your mcp.json`,
          settings: (n) => `${countOf(n, "setting")} you changed that a team can set`,
          extensions: (n) => `${countOf(n, "extension")} to choose from`,
        };

        let kind = given;
        if (kind === undefined) {
          const picked = await quickInput.pick(
            TEAM_GROUPS.map((group) => {
              const n = own[group.kind].length;
              return {
                id: group.kind,
                label: group.heading,
                description: n === 0 ? "None of your own" : counts[group.kind](n),
                disabled: n === 0,
              };
            }),
            { placeholder: "What do you want to publish to your team's library?" },
          );
          if (!picked) return cancelled;
          kind = picked.id;
        }
        const offered = own[kind];
        if (offered.length === 0)
          throw new Error(`You have nothing of your own to publish as ${kindHeading(kind)}.`);

        // Which ones. The rules are one file: nothing to choose.
        let chosen: Choice[];
        if (kind === "rules") chosen = offered;
        else {
          const placeholder =
            kind === "mcp"
              ? "Which servers? They replace the team's list. A server with a key written out is refused"
              : kind === "extensions"
                ? "Which extensions does the team recommend? This replaces the team's list"
                : kind === "settings"
                  ? "Which of your settings become the team's defaults? Your current values are published"
                  : `Which of your ${kindHeading(kind).toLowerCase()}? Check them, then press Enter`;
          const picked = await pickMany(services, offered, placeholder);
          if (!picked) return cancelled;
          // Nothing checked: nothing to publish (an empty list of extensions is not a wish).
          if (picked.length === 0) return cancelled;
          chosen = picked;
        }

        // Who is it on for? The owner's to say; what is in the library already may stay as it
        // is. A member who can publish isn't asked: theirs is optional.
        const there = team.items.some(
          (entry) =>
            entry.kind === kind &&
            (kind === "mcp" || kind === "settings" || kind === "extensions"
              ? true
              : chosen.some(
                  (choice) =>
                    entry.path === choice.path || entry.path.startsWith(`${choice.path}/`),
                )),
        );
        const offer = modeChoices(team.team.role === "owner", there);
        const answer = offer
          ? await quickInput.pick(offer, { placeholder: "Who is it on for?" })
          : null;
        if (offer && !answer) return cancelled;
        const mode = modeInput(answer?.id ?? null);

        const names = chosen.map((choice) => choice.path);
        const requests: { what: string; input: Record<string, unknown> }[] =
          kind === "settings"
            ? [{ what: "settings.json", input: { kind, keys: names, ...mode } }]
            : kind === "mcp"
              ? [{ what: "mcp.json", input: { kind, servers: names, ...mode } }]
              : kind === "extensions"
                ? [
                    {
                      what: "extensions.json",
                      input: { kind, recommendations: names, ...mode },
                    },
                  ]
                : names.map((path) => ({ what: path, input: { kind, path, ...mode } }));
        const outcomes: PublishOutcome[] = [];
        for (const request of requests) {
          outcomes.push(
            // Quiet: the report below names what wasn't published and why (D463).
            await dispatcher.execute("team.publish", request.input, QUIET_USER).then(
              (result) => publishOutcome(request.what, result),
              (err: unknown) => publishFailure(request.what, err),
            ),
          );
        }
        const report = publishReport(outcomes, team.team.name);
        notifications.show(
          report.refused.length === 0 ? "success" : report.published.length ? "warning" : "error",
          report.message,
          { title: "Team" },
        );
        return {
          published: report.published,
          notPublished: report.refused,
          message: report.message,
        };
      },
    }),
  );
}
