import type { DebateMode, DebatePair } from "../types";
import { MAX_PAIRS } from "../debate";
import { MAX_CHOICES, MIN_CHOICES } from "../prompts";
import { MAX_VOTES } from "./run";

// Request bodies come from the browser; check shape and size before any of
// it reaches a prompt.

const MAX_QUESTION = 4000;
const MAX_TEXT = 4000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** A browser-made run id; it ends up in flexrouter's client tag, so keep it plain. */
export const isRunId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{1,40}$/.test(v);

/** A flexrouter request id ("req_" + hex), safe to put in a URL path. */
export const isRequestId = (v: unknown): v is string => typeof v === "string" && /^req_[A-Za-z0-9]{1,64}$/.test(v);

const MODES: readonly DebateMode[] = ["persuade", "symmetric"];

function question(v: unknown): string | null {
  return isText(v, MAX_QUESTION) && v.trim() ? v.trim() : null;
}

export function parseRunBody(body: unknown): Result<{ question: string; votes: number; runId: string }> {
  if (!isRecord(body)) return { ok: false, error: "Expected a JSON object" };
  const q = question(body.question);
  if (!q) return { ok: false, error: `question must be 1-${MAX_QUESTION} characters` };
  const votes = body.votes;
  if (typeof votes !== "number" || !Number.isInteger(votes) || votes < 1 || votes > MAX_VOTES) {
    return { ok: false, error: `votes must be a whole number from 1 to ${MAX_VOTES}` };
  }
  if (!isRunId(body.runId)) return { ok: false, error: "runId must be 1-40 letters, digits or dashes" };
  return { ok: true, value: { question: q, votes, runId: body.runId } };
}

function side(v: unknown, choices: string[]): v is DebatePair["persuader"] {
  return (
    isRecord(v) &&
    isText(v.model, 200) &&
    (v.model as string).includes("/") &&
    typeof v.choice === "string" &&
    choices.includes(v.choice) &&
    isText(v.reasoning, MAX_TEXT)
  );
}

export function parseDebateBody(
  body: unknown
): Result<{ question: string; choices: string[]; pairs: DebatePair[]; mode: DebateMode; runId: string }> {
  if (!isRecord(body)) return { ok: false, error: "Expected a JSON object" };
  const q = question(body.question);
  if (!q) return { ok: false, error: `question must be 1-${MAX_QUESTION} characters` };
  const { choices, pairs } = body;
  if (
    !Array.isArray(choices) ||
    choices.length < MIN_CHOICES ||
    choices.length > MAX_CHOICES ||
    !choices.every((c) => isText(c, 100) && c)
  ) {
    return { ok: false, error: "choices must be a list of option labels" };
  }
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > MAX_PAIRS) {
    return { ok: false, error: `pairs must be a list of 1-${MAX_PAIRS} match-ups` };
  }
  for (const p of pairs) {
    if (!isRecord(p) || !side(p.persuader, choices) || !side(p.persuadee, choices)) {
      return { ok: false, error: "Each pair needs a persuader and persuadee with model, choice and reasoning" };
    }
  }
  const mode = body.mode ?? "persuade";
  if (!MODES.includes(mode as DebateMode)) return { ok: false, error: `mode must be one of: ${MODES.join(", ")}` };
  if (!isRunId(body.runId)) return { ok: false, error: "runId must be 1-40 letters, digits or dashes" };
  return {
    ok: true,
    value: { question: q, choices: choices as string[], pairs: pairs as DebatePair[], mode: mode as DebateMode, runId: body.runId },
  };
}
