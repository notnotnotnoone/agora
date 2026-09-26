import { describe, expect, it } from "vitest";
import { matchChoice, parseChoices, parsePersuadee, parseVote } from "./prompts";

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

describe("parsePersuadee", () => {
  it("splits the reply from the new vote", () => {
    expect(parsePersuadee("RESPONSE: fair point.\nANSWER: YES", ["YES", "NO"])).toEqual({
      response: "fair point.",
      choice: "YES",
    });
  });

  it("tolerates markdown bold", () => {
    expect(parsePersuadee("**RESPONSE:** fair.\n**ANSWER:** NO", ["YES", "NO"])).toEqual({ response: "fair.", choice: "NO" });
  });

  it("falls back to the whole text when the format is ignored", () => {
    expect(parsePersuadee("I stand firm.", ["YES", "NO"])).toEqual({ response: "I stand firm.", choice: null });
  });
});
