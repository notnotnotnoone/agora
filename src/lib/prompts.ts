// Every prompt Agora sends, and the parsers for what comes back. Pure, so
// the formats are pinned down by tests.

import type { ChatMessage, DebateMode, Speaker } from "./types";

export const MIN_CHOICES = 2;
export const MAX_CHOICES = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a free-text answer to one of the choices, case-insensitively. */
export function matchChoice(raw: string | undefined, choices: string[]): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^[\s"'`*[]+|[\s"'`*\].]+$/g, "").toLowerCase();
  return choices.find((c) => c.toLowerCase() === cleaned) ?? null;
}

// ── extracting the choices ──────────────────────────────────────────────

export function extractMessages(question: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You read a moral dilemma and identify the distinct options the person answering must choose between.

Rules:
- If it is a yes/no question, the options are YES and NO.
- Otherwise give each option a short label of 1-3 words, in UPPERCASE.
- Give between ${MIN_CHOICES} and ${MAX_CHOICES} options, mutually exclusive, no duplicates.

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
  const optionLines = choices
    .map((c) => `OPTION [${c}]: <specific reason why you would or would not choose this option>`)
    .join("\n");
  return [
    {
      role: "system",
      content: `You are answering a moral dilemma. Think through every available option carefully.

Format your response EXACTLY as follows: one OPTION line per choice, then the ANSWER line.

${optionLines}
ANSWER: <one of: ${list}>

Rules:
- Write an OPTION line for EVERY option above, each on a single line.
- Each OPTION must give a specific, concrete moral reason, not a platitude.
- The ANSWER line must contain exactly one of: ${list}.`,
    },
    { role: "user", content: question },
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
      content: `You summarize how a crowd of AI models voted on a moral dilemma.
Write a plain-English TL;DR under 150 words: which option won and by how much, the main
reasons behind the majority, and the strongest points the minority raised.
Do not give your own opinion on the dilemma.`,
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
  const voteLine = `End with one line:\nVOTE: <one of: ${choices.join(", ")}>`;
  let content: string;

  if (turn === 0) {
    const reasoning = own.reasoning ? ` Your reasoning was: ${own.reasoning}` : "";
    const framing =
      mode === "symmetric"
        ? `You voted "${own.current}" on this dilemma. Another AI voted "${opponent.current}". Have a genuine back-and-forth about it: make your honest case, but stay open to theirs.`
        : `You voted "${own.current}" on this dilemma. Another AI voted "${opponent.current}". Open with your strongest case: the concrete reason "${own.current}" is right here, and what is actually wrong with "${opponent.current}".`;
    content = `${framing}${reasoning}\n\nUnder 150 words.\n\n${voteLine}`;
  } else {
    const stance =
      own.current !== own.original
        ? `You changed your vote to "${own.current}" earlier in this debate. Defend it with the conviction you brought before.`
        : `You voted "${own.original}" and still hold that position.`;
    const theirs =
      opponent.current !== opponent.original
        ? `Your opponent switched from "${opponent.original}" to "${opponent.current}".`
        : `Your opponent has held "${opponent.current}" throughout.`;
    const reasoning = turn === 1 && own.reasoning ? `\nYour original reasoning: ${own.reasoning}\n` : "";
    const transcript = history
      .map((h, i) => `[${i + 1}] ${h.speaker === speaker ? "You" : "Opponent"} (${h.vote}): ${h.text}`)
      .join("\n\n");
    const last = turn === maxTurns - 1 ? "\nThis is the final turn." : "";
    const guidance =
      mode === "symmetric"
        ? "Continue the debate honestly. Engage with what they actually said, not the abstract position. Concede points you can't defend; push back on what you can."
        : "Respond to what was just said. Don't restate your position: engage with their specific argument. If they landed a real point, say so. If you have genuinely changed your mind, say it clearly and defend your new position.";
    content = `${stance} ${theirs}${reasoning}\n\nThe debate so far:\n${transcript}\n${last}\n\n${guidance} Under 150 words. Don't flip to be polite, and don't be stubborn either.\n\n${voteLine}`;
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
