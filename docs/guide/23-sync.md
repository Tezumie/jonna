# Sync and teams

Sync keeps your settings, your chats and your unfinished work the same on every computer you
use, and keeps snapshots of your projects so you can pick up where you left off, or go back.
What you sync is encrypted on your computer before it leaves it. This page covers turning it
on, adding a second computer, what syncs, projects and snapshots, storage, and teams.

Sync needs an account, and a plan that includes it. The editor itself is the same with or
without it. Some builds of {{product}} are made without Sync; in those, none of this is there.

## Turn it on

1. Sign in: the **Accounts** menu (the person icon above the gear) → **Sign in**.
2. Open **Accounts → Sync** (or run **Sync** from the command palette).
3. If your account doesn't have Sync yet, the tab says how to get it: plans and payment are on
   your account page, which opens in the browser. Come back to the window afterwards; the tab
   notices within a moment (or press **I already subscribed**).
4. Press **Turn on sync**. You are shown a **recovery key** once. Write it down or put it in a
   password manager, then type it back to confirm.

The recovery key matters. Your synced copy is encrypted with keys that only your computers
have. If you lose every computer that syncs and the recovery key, nobody can open that copy,
including us. **Make a new recovery key** (in the Sync tab) replaces a lost or exposed one.

## Add another computer

On the new computer, sign in and open the Sync tab; it offers to join sync from this computer.
Two ways in:

- **With a computer that already syncs.** Both computers show six digits. Check they are the
  same, then approve the new computer on the old one (Sync → Computers, or the notification).
  If the digits differ, don't approve: something is in between.
- **With the recovery key.** Type it in. Use this when no other computer is at hand.

Sync → **Computers** lists every computer of the account, when each was last seen, and lets
you rename this one or remove one you no longer use. Removing a computer makes new keys for
the others, so what is synced afterwards can't be read with what it had.

## What syncs

| What | Notes |
|---|---|
| Settings | Everything except what belongs to one computer (window size and zoom, paths, keys and tokens). Name more to keep local in `sync.ignoredSettings` |
| Keyboard shortcuts, snippets | Your own |
| Rules, skills, commands, agents, output styles | The ones you made for every folder |
| Chats | Those of no folder, and those of the projects that sync |
| Projects | Only the ones you turn on, see below |

Each kind has its own switch in **Settings → Sync** (`sync.settings`, `sync.chats`, and so
on). Model provider keys and other secrets never sync: sign in to providers on each computer.

When the same thing changed on two computers, the later change wins for a setting; for a file,
both are kept and the other one is saved beside it as a conflict copy for you to compare.

The status bar's sync item says where things stand (syncing, up to date, offline, needs
attention) and opens the tab. **Sync now** runs a pass at once.

## Projects and snapshots

A project's chats and unfinished work travel only once you turn sync on for it: open the
folder and choose **Sync this project** (Sync → Projects, or the command palette). The
Projects page shows your synced projects as folders; open one for its snapshots, its chats and
which computers have it. Right-click a project to rename it, stop syncing it from this
computer, or delete it from the account.

A **snapshot** is the project's unfinished work at a moment:

- **In a git project:** the commit you are on, commits you haven't pushed, what is staged,
  every changed and new file, and your stashes. What your remote already has isn't uploaded
  again (set `sync.snapshotScope` to `everything` to include the whole history).
- **In a folder without git:** every file, minus well-known heavy folders (dependencies, build
  output), files over 100 MB, and whatever `.syncignore`, `.gitignore` or `.ignore` name.
  Before you turn it on, the tab says how many files and how much it would upload.

Snapshots are taken every few minutes while something changed, when you close the window, and
on demand (**Snapshot now**). **Choose what snapshots leave out…** opens the project's
`.syncignore` (gitignore syntax).

On another computer:

- **Continue from another computer** brings the folder to the latest snapshot.
- **Restore a snapshot…** goes back to an earlier one; **Restore a file from a snapshot…**
  brings back one file.
- If the folder has changes of its own, you are asked first: they can be stashed, and the
  message tells you the stash's name. Files that `.syncignore` names are left as they are.

History is kept for the last 30 days you worked on the project (`sync.historyDays`): every
snapshot of the latest day and the last one of each earlier day. **Pin** a snapshot to keep it
for good.

Sync is for continuing your work elsewhere, with a history to go back to. It isn't a
replacement for pushing to a remote or for a backup of work you can't afford to lose.

## Storage and your plan

Sync → **Storage** shows how much the account uses and what the plan carries. More storage,
cards, invoices and cancelling are on your account page (**Manage plan…**), never in the
editor. When storage is full, old snapshots are pruned first; if it is still full, uploads
wait and the tab says so, while everything already synced stays readable.

If a subscription ends, your computers keep everything they have. The synced copy stays
readable for 30 days, so you can still restore snapshots, and is then deleted. Subscribing
again within that time continues where you were.

## Teams

A team is a Sync subscriber and the people they added from their account page (**Manage
team…**). Each member has Sync through the team, on one bill, and the team shares one pool of
storage. What each person syncs stays their own: the owner and the other members can't read
it.

A team also has a **library** (Sync → **Team**): the rules, skills, commands, agents, output
styles, snippets, MCP server lists, default settings and recommended extensions the team
wants everyone to have.

- **Using it.** Items the team marked as defaults are on from the start; switch any off. Add
  the others one by one. Your own files and settings always win over the team's, and the
  Settings tab marks a value that comes from the team as "Set by your team".
- **Publishing.** The owner, and members the owner chose, see **Publish…**: pick a kind, pick
  which of your own items, and whether it is a default. A library is readable by every member
  and stored as plain text, so it never holds secrets: an MCP server with a key written out is
  refused, and each member is asked for their own.
- **What a team's items can't do.** They are other people's files, so they get no head start:
  a team's command asks before running anything in a shell, a team's MCP server asks before it
  starts, and a team's settings can't switch on a feature that calls a model, open the editor
  to outside control, change which programs run, or lower a protection.

## Turn it off

**Turn off sync on this computer…** (in the Sync tab) stops syncing here and removes this
computer's keys; the account and your other computers are untouched. To delete everything in
the account, use **Reset sync** on your account page.

## Common questions

### Can you read what I sync?
No. It is encrypted on your computer with keys only your computers hold. The service sees
sizes, times and the names you give computers and projects. A team's library is the exception:
it is shared text the service can read.

### I lost my recovery key
If a computer still syncs, make a new one in the Sync tab. If none does and the key is
gone, the synced copy can't be opened; reset sync from your account page and turn it on again
from a computer that has your work.

### A project shows on another computer but nothing happened to my folder
Projects aren't written into folders on their own. Open the folder (or an empty one) and
choose **This folder is one of my synced projects…**, then **Continue from another computer**.

### Where do I manage payment?
On your account page, in the browser. The editor never asks for a card.
