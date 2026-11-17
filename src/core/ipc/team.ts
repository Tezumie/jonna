// A team's library (Rust: src-tauri/src/team). `base` is the accounts server, as for the
// account. The list and the texts come from the service; Rust keeps them in `<data>/team/<team>`
// and writes the items that are on into its `active/` folder, which the loaders read.
import type { TeamItem } from "../team/items";
import { call } from "./invoke";

/** The library as this computer keeps it. `items` is as Rust read it: pass it through `teamItems`. */
export interface TeamLibrary {
  team: { id: string; name: string } | null;
  /** "lapsed": the team's subscription ended; the library can be read, not changed. */
  state: "on" | "lapsed" | "";
  /** The profile's `libraryRev` the list was read at. */
  rev: number | null;
  items: unknown[];
  /** Item id → the version whose text is kept here. */
  cached: Record<string, number>;
  /** When the list was last read from the service, in ms (0: never). */
  fetchedAt: number;
  /** The folder holding the items that are on (the loaders read it). */
  dir: string;
}

export interface TeamApplied {
  dir: string;
  /** Files in the folder now. */
  files: number;
  written: number;
  removed: number;
}

export type TeamPut =
  | { outcome: "published"; id: string; version: number }
  /** Someone published a newer version meanwhile: nothing was written. */
  | { outcome: "conflict"; current: TeamItem | null; text: string | null };

export const teamIpc = {
  /** Reads the list from the service and keeps it; null when the account is in no team. */
  library: (base: string, rev: number | null): Promise<TeamLibrary | null> =>
    call<TeamLibrary | null>("team_library", { base, rev }),
  /** The list as last kept for `team`: no network. */
  cache: (team: string): Promise<TeamLibrary> => call<TeamLibrary>("team_cache", { team }),
  /** Downloads the text of the listed items `ids` into the cache. */
  fetch: (
    base: string,
    team: string,
    ids: readonly string[],
  ): Promise<{ fetched: string[]; failed: string[] }> => call("team_fetch", { base, team, ids }),
  /** Makes the folder the loaders read hold exactly the items `active` whose text is here. */
  apply: (team: string, active: readonly string[]): Promise<TeamApplied> =>
    call<TeamApplied>("team_apply", { team, active }),
  /** Removes every team's cache but `keep`'s (null: all). */
  clear: (keep: string | null): Promise<number> => call<number>("team_clear", { keep }),
  /** An item's text from the cache (null when it isn't here yet). */
  itemText: (team: string, id: string): Promise<string | null> =>
    call<string | null>("team_item_text", { team, id }),
  /**
   * Publishes an item over the version it was made from (`expect`; null: it must be new).
   * `isDefault`: on for every member from the start; `required`: and never switched off.
   */
  put: (
    base: string,
    item: {
      id: string;
      kind: string;
      path: string;
      text: string;
      isDefault: boolean;
      required: boolean;
    },
    expect: number | null,
  ): Promise<TeamPut> => call<TeamPut>("team_put", { base, ...item, expect }),
  /** Takes an item out of the library. */
  remove: (base: string, id: string): Promise<boolean> =>
    call<boolean>("team_delete", { base, id }),
};
