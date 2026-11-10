// An empty chat's greeting (D240): one short line picked at random ("Good morning, Sam", "What are
// we building today?"), as modern chat apps do, instead of instructions. Its own set for a folder
// with a project open and for no folder; with the user's first name when it's known. Lines that
// presume an earlier visit ("Welcome back", "Where were we?") only for a user with saved chats.
// DOM-free.

export type GreetingPlace = "new" | "project";

interface Line {
  text: (name: string) => string;
  /** Only at this time of day. */
  when?: PartOfDay;
  /** Presumes the user has been here before: not for a brand-new user. */
  returning?: true;
}

type PartOfDay = "morning" | "afternoon" | "evening" | "night";

export function partOfDay(hour: number): PartOfDay {
  return hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

const HELLO: Record<PartOfDay, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Up late",
};

function lines(now: Date): Record<GreetingPlace, { named: Line[]; anon: Line[] }> {
  const hello = HELLO[partOfDay(now.getHours())];
  const day = now.toLocaleDateString(undefined, { weekday: "long" });
  return {
    new: {
      named: [
        { text: (n) => `${hello}, ${n}` },
        { text: (n) => `${hello}, ${n}` },
        { text: (n) => `Welcome back, ${n}`, returning: true },
        { text: (n) => `What are we building today, ${n}?` },
        { text: (n) => `Ready when you are, ${n}` },
        { text: (n) => `Hey ${n}, what's next?` },
        { text: (n) => `Let's make something, ${n}` },
        { text: (n) => `${n}, got an idea?` },
        { text: (n) => `Good to see you, ${n}` },
        { text: (n) => `What's on your mind, ${n}?` },
        { text: (n) => `Happy ${day}, ${n}` },
        { text: (n) => `Fresh start, ${n}?`, returning: true },
        { text: (n) => `Coffee and code, ${n}?`, when: "morning" },
        { text: (n) => `Burning the midnight oil, ${n}?`, when: "night" },
      ],
      anon: [
        { text: () => hello },
        { text: () => "What are we building today?" },
        { text: () => "Let's make something" },
        { text: () => "Got an idea?" },
        { text: () => "Ready when you are" },
        { text: () => "What's next?" },
        { text: () => "What should we make?" },
        { text: () => `Happy ${day}` },
        { text: () => "A blank canvas awaits" },
        { text: () => "Coffee and code?", when: "morning" },
        { text: () => "Burning the midnight oil?", when: "night" },
      ],
    },
    project: {
      named: [
        { text: (n) => `${hello}, ${n}` },
        { text: (n) => `Welcome back, ${n}`, returning: true },
        { text: (n) => `What should we work on, ${n}?` },
        { text: (n) => `Where were we, ${n}?`, returning: true },
        { text: (n) => `Ready to pick this up, ${n}?`, returning: true },
        { text: (n) => `What are we changing, ${n}?` },
        { text: (n) => `How can I help, ${n}?` },
        { text: (n) => `Anything to fix or add, ${n}?` },
        { text: (n) => `Back at it, ${n}`, returning: true },
        { text: (n) => `Burning the midnight oil, ${n}?`, when: "night" },
      ],
      anon: [
        { text: () => hello },
        { text: () => "What should we work on?" },
        { text: () => "What's next for this project?" },
        { text: () => "Ready to pick this up?", returning: true },
        { text: () => "What are we changing?" },
        { text: () => "Anything to fix or add?" },
        { text: () => "Let's improve something" },
        { text: () => "Where were we?", returning: true },
      ],
    },
  };
}

/** A first name for the greeting: the first word, at most 24 characters; null when there's none. */
export function greetingName(raw: string | null | undefined): string | null {
  const first = (raw ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 24) : null;
}

/**
 * A random greeting for `place`, with `name` when it's known, fitting the time of day. `returning`:
 * the user has saved chats (a brand-new user isn't welcomed back).
 */
export function pickGreeting(
  place: GreetingPlace,
  name: string | null,
  returning: boolean,
  now = new Date(),
  random: () => number = Math.random,
): string {
  const part = partOfDay(now.getHours());
  const set = lines(now)[place];
  const pool = (name ? set.named : set.anon).filter(
    (l) => (!l.when || l.when === part) && (returning || !l.returning),
  );
  const line = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return line ? line.text(name ?? "") : HELLO[part];
}
