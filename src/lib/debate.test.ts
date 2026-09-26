import { describe, expect, it } from "vitest";
import { buildPairs, MAX_PAIRS } from "./debate";
import type { Vote } from "./types";

const vote = (slot: number, model: string, choice: string | null, status: Vote["status"] = "done"): Vote => ({
  slot,
  model,
  status,
  text: "",
  choice,
  reasons: choice ? { [choice]: `because ${model}` } : {},
  skipped: [],
});

describe("buildPairs", () => {
  it("pairs every minority voter with a majority voter, sharing out persuaders", () => {
    const pairs = buildPairs([
      vote(0, "a/1", "YES"),
      vote(1, "b/1", "YES"),
      vote(2, "c/1", "YES"),
      vote(3, "d/1", "NO"),
      vote(4, "e/1", "NO"),
    ]);
    expect(pairs.map((p) => [p.persuader.model, p.persuadee.model])).toEqual([
      ["a/1", "d/1"],
      ["b/1", "e/1"],
    ]);
    expect(pairs[0].persuadee).toEqual({ model: "d/1", choice: "NO", reasoning: "because d/1" });
  });

  it("returns nothing for a unanimous vote, ignoring failed votes", () => {
    expect(buildPairs([vote(0, "a/1", "YES"), vote(1, "b/1", null, "failed")])).toEqual([]);
  });

  it("caps the number of match-ups", () => {
    const votes = [vote(0, "m/0", "YES"), ...Array.from({ length: 30 }, (_, i) => vote(i + 1, `x/${i}`, i % 2 ? "NO" : "MAYBE"))];
    votes.push(...Array.from({ length: 40 }, (_, i) => vote(100 + i, `y/${i}`, "YES")));
    expect(buildPairs(votes)).toHaveLength(MAX_PAIRS);
  });
});
