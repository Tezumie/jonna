// The team's library: what a team publishes on purpose so every member's IDE works the same
// way (rules, skills, commands, agents, output styles, snippets, a list of MCP servers, default
// settings, recommended extensions). This is the plumbing: the library is fetched, kept on this
// computer, and the items that are on take effect as a read-only source of its own, under the
// user's own files (core/team/source.ts; each loader appends it). Commands (commands.ts) and
// ide://team; a page is built on those. Only in a build with teams (`hasTeams`,
// docs/own-services.md).
import type { BuiltinExtension } from "../../core/extensions/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerTeamCommands } from "./commands";
import { ADDED_SETTING, OFF_SETTING, TeamController } from "./controller";
import manifest from "./extension.json";

/** While the window has the focus, the account's profile is asked for the library's number at most this often. */
const CHECK_MS = 10 * 60_000;

export const teamExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { events, settings, state } = services;
    const controller = sub.add(new TeamController(services));
    registerTeamCommands(sub, services, controller);

    let checkedAt = 0;
    /**
     * Reads the profile (`fromServer`: asks the accounts server) and the library when its number
     * moved. Failures stay quiet: the controller keeps the reason for ide://team.
     */
    const check = (fromServer: boolean) => {
      checkedAt = Date.now();
      void controller.refresh({ fromServer, force: false }).catch(() => {});
    };

    // At startup, once the settings are read: they say which server, and what this person
    // added and turned off.
    let started = false;
    sub.add(
      effect(() => {
        if (started || !settings.loaded.value) return undefined;
        started = true;
        queueMicrotask(() => check(true));
        return undefined;
      }),
    );

    // Signed in or out, or the plan was looked at again (the saved profile is fresh then).
    sub.add(
      events.on("command.executed", (event) => {
        if (event.status !== "ok") return;
        if (
          event.id === "accounts.signIn" ||
          event.id === "accounts.signOut" ||
          event.id === "sync.checkPlan"
        )
          check(false);
      }),
    );

    // What this person added or turned off changed (here, in the file, in another window).
    sub.add(
      settings.model.onDidChange((keys) => {
        if (started && (keys.includes(ADDED_SETTING) || keys.includes(OFF_SETTING)))
          void controller.apply().catch(() => {});
      }),
    );

    if (services.hasScreen) {
      // Back at the window, and now and then while it has the focus: never more often than
      // CHECK_MS, and never while the window is in the background.
      const due = () => {
        if (started && Date.now() - checkedAt >= CHECK_MS) check(true);
      };
      window.addEventListener("focus", due);
      const timer = setInterval(() => {
        if (document.hasFocus()) due();
      }, CHECK_MS);
      sub.add({
        dispose: () => {
          window.removeEventListener("focus", due);
          clearInterval(timer);
        },
      });
    }

    sub.add(
      state.register("ide://team", {
        description:
          "The library of the account's team: what the team published so every member's IDE works the same way. `team`: null (in no team, or signed out), or its `name`, the account's `role` (owner or member) and whether it is a `publisher` (may change the library); never the members. `state`: on, or lapsed (the team's subscription ended: the library still applies and can be read, not changed). `items`: each with its `id`, `kind` (rules, skills, commands, agents, outputStyles, snippets, mcp, settings, extensions), `path` (its name, like the user's own files: skills/review/SKILL.md), `isDefault` (on for every member from the start; a member may turn it off), `required` (on for every member, always: it can't be turned off; what is on for everyone is the team's owner's to decide), `active` (on here: a required item, a default this person didn't turn off, or one they added; a skill's files follow its SKILL.md), `version`, `by` (who published it) and `updatedAt` (ms). `lastRefresh` (ms, when the library was last read from the service) and `problem` (why it couldn't be read, else null; what is on this computer keeps applying). Never an item's text: team.readItem returns one. Items that are on are read only and the team's, not the user's own: a team's skill or command never pre-approves tools, its MCP servers ask before starting, its settings are defaults under the user's.",
        get: () => {
          const team = controller.team.peek();
          const active = controller.active.peek();
          return {
            team: team ? { name: team.name, role: team.role, publisher: team.publisher } : null,
            state: controller.state.peek(),
            items: controller.items.peek().map((item) => ({
              id: item.id,
              kind: item.kind,
              path: item.path,
              isDefault: item.isDefault,
              required: item.required,
              active: active.has(item.id),
              version: item.version,
              by: item.by,
              updatedAt: item.updatedAt,
            })),
            lastRefresh: controller.lastRefresh.peek(),
            problem: controller.problem.peek(),
          };
        },
      }),
    );
  },
};
