"use client";

import { useState } from "react";
import { DILEMMAS, shuffleDilemma } from "@/lib/dilemmas";
import { Box } from "./ui";

export const DEFAULT_VOTES = 20;

export function DilemmaForm({
  live,
  available,
  onRun,
  onStop,
}: {
  live: boolean;
  /** Models flexrouter can route to; each votes at most once. */
  available: number | null;
  onRun: (question: string, votes: number) => void;
  onStop: () => void;
}) {
  const [question, setQuestion] = useState(DILEMMAS[0]);
  const [votes, setVotes] = useState(DEFAULT_VOTES);
  const cap = Math.max(1, available ?? DEFAULT_VOTES);
  // Shown clamped, so the input never exceeds its own max (which would make
  // the browser block the submit) when flexrouter has fewer models.
  const effective = Math.min(votes, cap);

  return (
    <Box title="Dilemma" sub="one question, many models">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!live && question.trim()) onRun(question.trim(), effective);
        }}
      >
        <label htmlFor="question" className="visually-hidden">
          Dilemma
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={live}
          maxLength={4000}
          rows={4}
        />
        <div className="dilemma-row">
          <button type="button" className="btn ghost" onClick={() => setQuestion(shuffleDilemma(question))} disabled={live}>
            Shuffle
          </button>
          <label className="field">
            <span className="field-label">Voters</span>
            <input
              type="number"
              min={1}
              max={cap}
              value={effective}
              onChange={(e) => setVotes(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
              disabled={live}
            />
          </label>
          <span className="faint">
            {available === null
              ? "waiting for flexrouter…"
              : `each model votes once · ${available} available`}
          </span>
          <span className="spacer" />
          {live ? (
            <button type="button" className="btn danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!question.trim() || available === 0}>
              Ask {effective} model{effective === 1 ? "" : "s"} →
            </button>
          )}
        </div>
      </form>
    </Box>
  );
}
