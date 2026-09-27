import type { DebatePair, Vote } from "./types";

export const MAX_PAIRS = 12;

/** The reason a voter gave for the option it picked. */
export function reasoningOf(vote: Pick<Vote, "choice" | "reasons">): string {
  return vote.choice ? (vote.reasons[vote.choice] ?? "") : "";
}

/**
 * Round 2 match-ups: every minority voter faces a majority voter.
 * Persuaders are dealt out in turn, so the majority's models share the work
 * instead of one model arguing every pair. Returns [] when the vote was
 * unanimous (or tied with nothing to argue).
 */
export function buildPairs(votes: Vote[]): DebatePair[] {
  const byChoice = new Map<string, (Vote & { model: string })[]>();
  for (const v of votes) {
    if (v.status !== "done" || !v.choice || !v.model) continue;
    byChoice.set(v.choice, [...(byChoice.get(v.choice) ?? []), { ...v, model: v.model }]);
  }
  if (byChoice.size < 2) return [];

  const [majorityChoice, majority] = [...byChoice].reduce((best, entry) =>
    entry[1].length > best[1].length ? entry : best
  );

  const pairs: DebatePair[] = [];
  let dealt = 0;
  for (const [choice, voters] of byChoice) {
    if (choice === majorityChoice) continue;
    for (const persuadee of voters) {
      if (pairs.length >= MAX_PAIRS) return pairs;
      const persuader = majority[dealt++ % majority.length];
      pairs.push({
        persuader: { model: persuader.model, choice: majorityChoice, reasoning: reasoningOf(persuader) },
        persuadee: { model: persuadee.model, choice, reasoning: reasoningOf(persuadee) },
      });
    }
  }
  return pairs;
}
