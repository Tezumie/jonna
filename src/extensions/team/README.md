# extensions/team

The team's library (D442): what a team (a Sync subscriber and the people they invited) publishes
on purpose so every member's IDE works the same way. Rules, skills, commands, agents, output
styles, snippets, a list of MCP servers, default settings and recommended extensions. This
extension is the plumbing: it fetches the library, keeps a copy on this computer, and makes the
items that are on take effect as a read-only source that is the team's, under the user's own
files. There is no page here: the commands and `ide://team` are what a page is built on. That
page is the Sync tab's Team page (`extensions/sync/teamPage.ts`, with the picker
`sync.team.publish`): it imports nothing from here, reads `ide://team` again after each
`team.*` command and while it is shown, and runs these commands through the dispatcher.

Only in a build with teams: in the list of built-ins when `hasTeams()` (`core/ownServices.ts`:
Sync is built in and `teamPagePath` isn't empty; `docs/own-services.md`). It imports nothing
from `extensions/sync`: it reads the profile through `core/ipc/accounts.ts` and reacts to the
same events (`accounts.signIn`, `accounts.signOut`, `sync.checkPlan`, the window's focus). Works
without a screen too (the focus and timer parts need one).

- `controller.ts` — `TeamController`: the account's team (`team`: id, name, role, publisher),
  the library's `state` (on, lapsed), its `items`, which are on (`active`), `lastRefresh` and
  `problem`. `refresh({ fromServer, force })` reads the profile, clears the cache of a team the
  account is no longer in, applies what is cached, then (when the profile's `libraryRev` moved,
  texts are missing, or `force`) reads the list, downloads the texts that changed and applies
  again. One at a time; a change of what is on (`apply`, `setChoices`) waits its turn. Offline or
  refused: the cache keeps applying and `problem` says why; nothing is shown. No view code.
- `commands.ts` — the commands.
- `index.ts` — activation: the first refresh once the settings are read, the checks (below),
  `ide://team`.

The DOM-free rules are in `core/team` (tested): which items are on, what to download, names and
ids, the settings filter, the secret check for a published mcp.json. The service calls, the
cache and the path checks are Rust (`src-tauri/src/team`, `ipc/team.rs`; typed calls in
`core/ipc/team.ts`).

**When it refreshes:** at startup once the settings are read (the profile is asked of the
server); on `team.refresh`; after `accounts.signIn`, `accounts.signOut` and `sync.checkPlan`;
and at most every 10 minutes while the window has the focus (coming back to it, or a timer that
only acts while it is focused). The periodic check asks only for the profile; the library's list
is read when its `libraryRev` differs from the cached one (or texts are still missing).

**Which items are on:** a required item, always; an item marked default, unless this person
turned it off; plus the ones they added (`activeIds`, `core/team/items.ts`: the decision is
made here, Rust only carries the flags). An item's mode is optional, default or required
(`modeOf`): `isDefault` and `required` in its JSON, a required item carrying both so a build
that doesn't know `required` still has it on. Only the team's owner decides what is on for
everyone: a member who can publish publishes and updates optional items (`ownerOnlyRefusal`,
checked before anything is sent; the service answers 403 `not_owner` with the same sentence).
Required default settings still sit under the user's own: only the item as a whole can't be
switched off. Two settings hold what this person chose, as lists of item ids, and never sync (`staysLocal`):
`team.added` and `team.off`. A skill is every item under `skills/<skill>/`; its `SKILL.md` is
its switch (adding or turning off any of its files acts on that one, and the others follow); a
skill's files without a `SKILL.md` in the library are never on.

**The cache:** `<data>/team/<team>/` (beside `<data>/plugins`, not under `<data>/sync`):
`library.json` (the list as last read, and which texts are here), `items/` (every item's text,
on or not, so one can be looked at before it is added) and `active/` (only the items that are
on, each at its kind's name: `AGENTS.md`, `skills/…`, `commands/*.md`, `agents/*.md`,
`output-styles/*.md`, `snippets/*`, `mcp.json`, `settings.json`, `extensions.json`). The loaders
read `active/` through `core/team/source.ts` (`activeTeam`, a signal: its `stamp` moves when
the folder's content changed, which is how readers know, since the folder isn't watched). When
the account is in no team, signs out, or is in another team, the cache goes and nothing of a
team is on. While the team's subscription is lapsed the cache keeps applying.

**What a team's item may do** (it is other people's, so it is never the user's own for trust):

- A team's skill or command never pre-approves its `allowed-tools` (`skillPreApproves`,
  `commandTrusted` in `core/agent`): scope / origin "team", treated like a project's.
- A team's MCP servers ask before they start, like a folder's (`asksBeforeStart`,
  `core/mcp/config.ts`); `${input:…}` asks each member once and theirs stays on their computer;
  a config naming a stored secret itself isn't started.
- A team's settings are defaults under the user's own (the `team` layer of
  `core/settings/model.ts`): never a key that stays on a computer (`staysLocal`), one this build
  doesn't know, or `team.*` / `sync.*` / `accounts.*` (`core/team/settings.ts`, on download and
  on publish).
- Publishing never sends a secret: an MCP server with a key written out is refused, saying
  which (`core/team/mcp.ts`); only servers and the inputs they use go, never a typed-in value.
- What is downloaded is capped (500 items, 256 KiB an item, 20 MiB in all), every name is
  checked again here and in Rust (no `..`, nothing absolute, no device names, only the shapes
  the kinds have), and unknown kinds are left out.
- Extensions are recommended, never installed.

Where a team's items show, they are labeled as the team's: the Rules page ("From your team
(name), in every project"), the Skills and Commands pages (a Team group), an agent's source
(the team's name), the MCP list (Team), a settings row ("Set by your team, name."), and the
Extensions view's reasons ("Recommended by your team (name)").

**Commands:** `team.refresh` (returns `team`, `items`, `active`, `fetched`, `failed`,
`problem`), `team.readItem {id}` (the text, from the cache) — both open to agents. The person's
own, hidden from agents: `team.addItem {id}`, `team.turnOnItem {id}`, `team.turnOffItem {id}`
(refused for a required item); for publishers
`team.publish {kind, path?, mode?, keys?, recommendations?, servers?}` (one of the user's own
files, read through the user-files calls; `mode`: optional, default or required, the last two
and anything over an item that is one being the owner's; `isDefault` is still read as the older
word for it; a conflict is reported, never overwritten) and `team.unpublish {id}` (asks first;
a skill's `SKILL.md` removes the whole skill); and for the owner `team.setMode {id, mode}`
(returns `mode`, `changed`, `version`).
**Settings:** `team.added`, `team.off`.
**State:** `ide://team` (`team`: name, role, publisher; `state`; `items`: id, kind, path,
isDefault, required, active, version, by, updatedAt; `lastRefresh`; `problem`). Never an item's text,
never the members.
