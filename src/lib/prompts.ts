// Every prompt Agora sends, and the parsers for what comes back. Pure, so
// the formats are pinned down by tests.

import type { ChatMessage } from "./types";

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

export function persuaderMessages(
  question: string,
  own: { choice: string; reasoning: string },
  opponentChoice: string
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You chose ${own.choice} on this moral dilemma${own.reasoning ? `, because: ${own.reasoning}` : "."}
Your opponent chose ${opponentChoice}. Make your strongest case to change their mind.
Be direct and concrete, under 150 words. Reply with the argument only.`,
    },
    { role: "user", content: question },
  ];
}

export function persuadeeMessages(
  question: string,
  own: { choice: string; reasoning: string },
  opponentChoice: string,
  argument: string,
  choices: string[]
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You chose ${own.choice} on this moral dilemma${own.reasoning ? `, because: ${own.reasoning}` : "."}

Your opponent argues for ${opponentChoice}:
${argument}

Respond honestly. Change your vote only if the argument is genuinely compelling:
don't flip to be polite, and don't be stubborn either.
Format your reply EXACTLY as:
RESPONSE: <your reply, under 120 words>
ANSWER: <one of: ${choices.join(", ")}>`,
    },
    { role: "user", content: question },
  ];
}

export function parsePersuadee(text: string, choices: string[]): { response: string; choice: string | null } {
  const response = text.match(/RESPONSE[ \t*]*:[\s*]*([\s\S]*?)(?=\n[ \t*]*ANSWER[ \t*]*:|$)/i)?.[1].trim();
  const answers = [...text.matchAll(/^[ \t*]*ANSWER[ \t*]*:[ \t]*(.+?)[ \t]*$/gim)];
  return { response: response || text.trim(), choice: matchChoice(answers.at(-1)?.[1], choices) };
}
