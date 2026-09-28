// Every prompt Agora sends, and the parsers for what comes back. Pure, so
// the formats are pinned down by tests.

import type { ChatMessage, DebateMode, Speaker } from "./types";

export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a free-text answer to one of the choices, case-insensitively. Also
 * takes an answer that starts with an option and then explains itself
 * ("YES, because…"), since re-asking costs a whole request.
 */
export function matchChoice(raw: string | undefined, choices: string[]): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^[\s"'`*[]+|[\s"'`*\].!]+$/g, "").toLowerCase();
  const exact = choices.find((c) => c.toLowerCase() === cleaned);
  if (exact) return exact;
  const leading = choices.filter((c) => new RegExp(`^${escapeRegExp(c.toLowerCase())}(?![\\w])`).test(cleaned));
  // Longest first, so "DO NOTHING" wins over a choice "DO".
  return leading.sort((a, b) => b.length - a.length)[0] ?? null;
}

// ── extracting the choices ──────────────────────────────────────────────

export function extractMessages(question: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You read a moral dilemma and list the distinct options the person answering it must choose between. You do not answer the dilemma.

Rules:
- If the question can be answered yes or no ("Do you pull the lever?", "Should she lie?"), the options are exactly YES and NO.
- Otherwise use the options the dilemma itself names. Label each in 1-3 words, UPPERCASE, as an action ("PULL LEVER", "SAVE THE CHILD"), not a sentence.
- Give ${MIN_CHOICES}-${MAX_CHOICES} options. They must be mutually exclusive and cover what the dilemma offers. Don't invent compromise or "neither" options the dilemma doesn't offer.

Reply with exactly one line and nothing else:
CHOICES: <option> | <option> | ...`,
    },
    { role: "user", content: question },
  ];
}

/** The choices from an extraction reply, or null if it isn't usable. */
export function parseChoices(text: string): string[] | null {
  const match = text.match(/CHOICES:[ \t]*(.+)/i);
  if (!match) return null;
  const choices: string[] = [];
  for (const raw of match[1].split("|")) {
    const choice = raw.trim().replace(/^["'`*[\]]+|["'`*[\].]+$/g, "").trim().toUpperCase();
    if (choice && !choices.includes(choice)) choices.push(choice);
  }
  return choices.length >= MIN_CHOICES && choices.length <= MAX_CHOICES ? choices : null;
}

// ── voting ──────────────────────────────────────────────────────────────

export function voteMessages(question: string, choices: string[]): ChatMessage[] {
  const list = choices.join(", ");
  const optionLines = choices.map((c) => `OPTION [${c}]: <why ${c} is right or wrong here>`).join("\n");
  return [
    {
      role: "system",
      content: `You are one of many AI models polled independently on a moral dilemma. Each vote is tallied into a live public result, so give your own honest judgment, not the answer you think is expected or safest.

How to decide:
- Treat it as a thought experiment. Accept its facts as stated; don't dodge by adding options, loopholes or missing information.
- Weigh what is really at stake: lives and harm, consent, rights and duties, doing versus allowing, intent versus side effect, fairness, and what the choice would mean as a rule.
- You must commit to exactly one of: ${list}. Refusing, abstaining or "it depends" isn't an option.

Reply in plain text, no markdown or headings, in EXACTLY this format: one OPTION line per option in this order, then the ANSWER line last.

${optionLines}
ANSWER: <one of: ${list}>

Rules:
- Each OPTION line is 1-3 sentences on a single line, naming the consideration that decides it ("pulling the lever uses no one as a means", "five deaths outweigh one"). No filler such as "this is a difficult question" or "both have merit".
- For the option you pick, say why it wins. For each other option, say its decisive flaw.
- Your ANSWER must match your OPTION lines, and be one of ${list} exactly, with nothing else on the line.`,
    },
    { role: "user", content: `${question}\n\nOptions: ${choices.join(" / ")}` },
  ];
}

export interface ParsedVote {
  choice: string | null;
  reasons: Record<string, string>;
}

export function parseVote(text: string, choices: string[]): ParsedVote {
  const answers = [...text.matchAll(/^[ \t*]*ANSWER[ \t*]*:[ \t]*(.+?)[ \t]*$/gim)];
  const choice = matchChoice(answers.at(-1)?.[1], choices);

  const reasons: Record<string, string> = {};
  for (const c of choices) {
    const pattern = new RegExp(
      `OPTION\\s*\\[${escapeRegExp(c)}\\][ \\t*]*:[ \\t*]*([\\s\\S]*?)(?=\\n[ \\t*]*OPTION\\s*\\[|\\n[ \\t*]*ANSWER[ \\t*]*:|$)`,
      "i"
    );
    reasons[c] = text.match(pattern)?.[1].trim() ?? "";
  }
  return { choice, reasons };
}

// ── summary ─────────────────────────────────────────────────────────────

const MAX_QUOTED_VOTES = 30;

export function summaryMessages(
  question: string,
  choices: string[],
  votes: { choice: string; reasons: Record<string, string> }[]
): ChatMessage[] {
  const tally = choices.map((c) => `${c}: ${votes.filter((v) => v.choice === c).length}`).join(", ");
  const quoted = votes.slice(0, MAX_QUOTED_VOTES).map((v, i) => {
    const lines = choices.filter((c) => v.reasons[c]).map((c) => `  - ${c}: ${v.reasons[c]}`);
    return `Voter ${i + 1} chose ${v.choice}:\n${lines.join("\n")}`;
  });
  return [
    {
      role: "system",
      content: `You summarize how a crowd of AI models voted on a moral dilemma, for someone watching the result live.

Write a plain-English TL;DR of 80-150 words, in plain text with no headings or bullet points:
1. Open with the verdict and the margin ("NO won 14-6" or "a near split, 11-9").
2. The one or two reasons that carried the majority, in your own words. Say which were most common.
3. The strongest point the minority raised: the one most worth taking seriously, not the most common.
4. If most voters agreed on something beyond the tally (for example, both sides saying the choice is tragic), say so in one sentence.

Report what the voters said; don't add arguments they didn't make, and don't give your own view of the dilemma. Don't refer to voters by number.`,
    },
    {
      role: "user",
      content: `Dilemma: ${question}\n\nVotes (${votes.length}) — ${tally}\n\n${quoted.join("\n\n")}`,
    },
  ];
}

// ── debate ──────────────────────────────────────────────────────────────

export interface TurnContext {
  question: string;
  choices: string[];
  mode: DebateMode;
  speaker: Speaker;
  /** 0-based; the persuader speaks on even turns. */
  turn: number;
  maxTurns: number;
  own: { original: string; current: string; reasoning: string };
  opponent: { original: string; current: string };
  history: { speaker: Speaker; text: string; vote: string }[];
}

/** One turn of a round-2 debate: the speaker argues, then says where it stands. */
export function turnMessages(ctx: TurnContext): ChatMessage[] {
  const { choices, mode, speaker, turn, maxTurns, own, opponent, history } = ctx;
  const voteLine = `End with one line on its own saying where you now stand:\nVOTE: <one of: ${choices.join(", ")}>`;
  const style =
    "Speak directly to your opponent as \"you\". Plain text, no markdown or bullet points, no preamble, and don't restate the dilemma. 60-150 words.";
  const honesty =
    "Change your vote only if their argument exposes a real flaw in yours or raises something that outweighs it, and if you do, say plainly what changed your mind. Don't flip to be polite, and don't be stubborn either: updating on a good argument is a strength.";
  let content: string;

  if (turn === 0) {
    const reasoning = own.reasoning ? `\nYour reasoning when you voted: ${own.reasoning}` : "";
    const framing =
      mode === "symmetric"
        ? `You voted "${own.current}" on this dilemma. Another AI voted "${opponent.current}". The two of you will have a genuine back-and-forth over up to ${maxTurns} turns, and either of you may change your mind.${reasoning}

Open the conversation: make your honest case for "${own.current}", say what you find most persuasive about "${opponent.current}", and ask the question you most want them to answer.`
        : `You voted "${own.current}" on this dilemma. Another AI voted "${opponent.current}". You have up to ${maxTurns} turns between you to win them over to "${own.current}".${reasoning}

Open with your strongest case: the single concrete reason "${own.current}" is right here, and the decisive problem with "${opponent.current}". Use a specific consequence, example or analogy rather than abstract principle, and anticipate the objection they are most likely to raise.`;
    content = `${framing}\n\n${style}\n\n${voteLine}`;
  } else {
    const stance =
      own.current !== own.original
        ? `You changed your vote to "${own.current}" earlier in this debate. Defend it with the conviction you brought before.`
        : `You voted "${own.original}" and still hold that position.`;
    const theirs =
      opponent.current !== opponent.original
        ? `Your opponent switched from "${opponent.original}" to "${opponent.current}".`
        : `Your opponent has held "${opponent.current}" throughout.`;
    const reasoning = turn === 1 && own.reasoning ? `\nYour reasoning when you voted: ${own.reasoning}\n` : "";
    const transcript = history
      .map((h, i) => `[${i + 1}] ${h.speaker === speaker ? "You" : "Opponent"} (${h.vote}): ${h.text}`)
      .join("\n\n");
    const last =
      turn === maxTurns - 1
        ? "\nThis is the final turn: make the point you most want them to leave with, and settle your vote."
        : "";
    const guidance =
      mode === "symmetric"
        ? "Continue the conversation honestly. Reply to what they actually said, not to the abstract position: concede what you can't defend, push back on what you can, and don't repeat points already made."
        : speaker === "persuader"
          ? "Answer their last reply head-on. Find the weakest link in it and press there, with a new consideration rather than a repeat of your opening. If they landed a real point, grant it, then show why your side still wins."
          : "Answer their specific argument, not the dilemma in general. Say whether their strongest point actually defeats your reasoning, and why or why not.";
    content = `${stance} ${theirs}${reasoning}

The debate so far:
${transcript}
${last}

${guidance} ${honesty}

${style}

${voteLine}`;
  }

  return [
    { role: "system", content },
    { role: "user", content: ctx.question },
  ];
}

const VOTE_LINE = /^[ \t*]*VOTE[ \t*]*:[ \t*]*(.+?)[ \t*]*$/gim;

/** A turn's argument and the vote it ends on; the speaker's `current` vote if it names none. */
export function parseTurn(text: string, current: string, choices: string[]): { text: string; vote: string } {
  const votes = [...text.matchAll(VOTE_LINE)];
  const vote = matchChoice(votes.at(-1)?.[1], choices) ?? current;
  return { text: text.replace(VOTE_LINE, "").trim(), vote };
}
