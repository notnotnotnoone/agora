import { describe, expect, it } from "vitest";
import { matchChoice, parseChoices, parseTurn, parseVote, turnMessages, type TurnContext } from "./prompts";

describe("parseChoices", () => {
  it("reads and normalises the options", () => {
    expect(parseChoices('CHOICES: "Pull the lever" | do nothing.')).toEqual(["PULL THE LEVER", "DO NOTHING"]);
  });

  it("drops duplicates", () => {
    expect(parseChoices("CHOICES: YES | yes | NO")).toEqual(["YES", "NO"]);
  });

  it("rejects too few options or no CHOICES line", () => {
    expect(parseChoices("CHOICES: YES")).toBeNull();
    expect(parseChoices("I think yes or no")).toBeNull();
  });
});

describe("matchChoice", () => {
  it("ignores case, quotes, markdown and a trailing period", () => {
    expect(matchChoice(' **"yes".** ', ["YES", "NO"])).toBe("YES");
    expect(matchChoice("maybe", ["YES", "NO"])).toBeNull();
    expect(matchChoice(undefined, ["YES"])).toBeNull();
  });

  it("takes an answer that starts with an option and explains itself, but not a longer word", () => {
    expect(matchChoice("YES, because five lives", ["YES", "NO"])).toBe("YES");
    expect(matchChoice("No!", ["YES", "NO"])).toBe("NO");
    expect(matchChoice("YESTERDAY", ["YES", "NO"])).toBeNull();
    expect(matchChoice("do nothing - it's wrong", ["DO", "DO NOTHING"])).toBe("DO NOTHING");
  });
});

describe("parseVote", () => {
  const choices = ["YES", "NO"];

  it("reads each option's reason and the answer", () => {
    const text = "OPTION [YES]: saves five lives.\nOPTION [NO]: avoids killing directly.\nANSWER: YES";
    expect(parseVote(text, choices)).toEqual({
      choice: "YES",
      reasons: { YES: "saves five lives.", NO: "avoids killing directly." },
    });
  });

  it("keeps multi-line reasons and tolerates markdown bold", () => {
    const text = "**OPTION [YES]:** first line\nsecond line\n**OPTION [NO]:** no\n\n**ANSWER:** no";
    const vote = parseVote(text, choices);
    expect(vote.choice).toBe("NO");
    expect(vote.reasons.YES).toBe("first line\nsecond line");
  });

  it("uses the last ANSWER line when a model restates it", () => {
    expect(parseVote("ANSWER: YES\n...on reflection\nANSWER: NO", choices).choice).toBe("NO");
  });

  it("has no choice when the answer isn't an option", () => {
    expect(parseVote("ANSWER: it depends", choices).choice).toBeNull();
  });

  it("handles options containing regex characters", () => {
    const vote = parseVote("OPTION [A (B)]: why\nANSWER: A (B)", ["A (B)", "C"]);
    expect(vote).toEqual({ choice: "A (B)", reasons: { "A (B)": "why", C: "" } });
  });
});

describe("parseTurn", () => {
  it("splits the argument from the vote it ends on", () => {
    expect(parseTurn("Five lives matter more.\nVOTE: YES", "NO", ["YES", "NO"])).toEqual({
      text: "Five lives matter more.",
      vote: "YES",
    });
  });

  it("tolerates markdown bold and uses the last VOTE line", () => {
    expect(parseTurn("I said VOTE: NO before.\n**VOTE:** yes", "NO", ["YES", "NO"])).toEqual({
      text: "I said VOTE: NO before.",
      vote: "YES",
    });
  });

  it("keeps the speaker's current vote when the line is missing or not an option", () => {
    expect(parseTurn("I stand firm.", "NO", ["YES", "NO"])).toEqual({ text: "I stand firm.", vote: "NO" });
    expect(parseTurn("Hmm.\nVOTE: MAYBE", "NO", ["YES", "NO"]).vote).toBe("NO");
  });
});

describe("turnMessages", () => {
  const base: TurnContext = {
    question: "Pull the lever?",
    choices: ["YES", "NO"],
    mode: "persuade",
    speaker: "persuader",
    turn: 0,
    maxTurns: 5,
    own: { original: "YES", current: "YES", reasoning: "five > one" },
    opponent: { original: "NO", current: "NO" },
    history: [],
  };
  const system = (ctx: TurnContext) => turnMessages(ctx)[0].content;

  it("opens by making the case, or by starting a two-way exchange in symmetric mode", () => {
    expect(system(base)).toMatch(/strongest case/);
    expect(system({ ...base, mode: "symmetric" })).toMatch(/back-and-forth/);
    expect(turnMessages(base)[1]).toEqual({ role: "user", content: "Pull the lever?" });
  });

  it("labels the transcript from the speaker's side", () => {
    const history = [
      { speaker: "persuader" as const, text: "Pull it.", vote: "YES" },
      { speaker: "persuadee" as const, text: "No.", vote: "NO" },
    ];
    const persuader = system({ ...base, turn: 2, history });
    expect(persuader).toContain("[1] You (YES): Pull it.");
    expect(persuader).toContain("[2] Opponent (NO): No.");

    const persuadee = system({
      ...base,
      speaker: "persuadee",
      turn: 3,
      own: { original: "NO", current: "NO", reasoning: "" },
      opponent: { original: "YES", current: "YES" },
      history,
    });
    expect(persuadee).toContain("[1] Opponent (YES): Pull it.");
    expect(persuadee).toContain("[2] You (NO): No.");
  });

  it("tells a speaker who has switched to defend the new side", () => {
    const text = system({ ...base, turn: 2, own: { original: "YES", current: "NO", reasoning: "" } });
    expect(text).toMatch(/changed your vote to "NO"/);
  });

  it("marks the last turn and always asks for a VOTE line", () => {
    expect(system({ ...base, turn: 4, history: [] })).toMatch(/final turn/);
    expect(system(base)).toMatch(/VOTE: <one of: YES, NO>/);
  });
});
