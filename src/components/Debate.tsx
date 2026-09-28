"use client";

import { useState } from "react";
import type { ArenaState, Exchange } from "@/lib/arena";
import { buildPairs } from "@/lib/debate";
import { modelName } from "@/lib/format";
import type { DebateMode, DebatePair } from "@/lib/types";
import { Box, ChoiceTag, Tag } from "./ui";

const MODES: { mode: DebateMode; label: string; blurb: string }[] = [
  {
    mode: "persuade",
    label: "Persuade",
    blurb: "The majority voter sets out to change the minority voter's mind. They take up to 5 turns.",
  },
  {
    mode: "symmetric",
    label: "Symmetric",
    blurb: "Both sides make their case and stay open to the other's, for up to 5 turns. Either can change its mind.",
  },
];

function Side({ label, side, choices }: { label: string; side: DebatePair["persuader"]; choices: string[] }) {
  return (
    <div className="vote-head">
      <span className="field-label">{label}</span>
      <span className="vote-model" title={side.model}>
        {modelName(side.model)}
      </span>
      <ChoiceTag choices={choices} choice={side.choice} />
    </div>
  );
}

function Outcome({ label, from, to, flipped }: { label: string; from: string; to: string; flipped: boolean }) {
  return flipped ? (
    <>
      <Tag tone="violet">{label} flipped</Tag>
      <span className="mono">
        {from} → {to}
      </span>
    </>
  ) : (
    <>
      <Tag>{label} held</Tag>
      <span className="mono dim">{to}</span>
    </>
  );
}

function ExchangeView({
  pair,
  exchange,
  mode,
  choices,
  running,
  onSkip,
}: {
  pair: DebatePair;
  exchange: Exchange;
  mode: DebateMode;
  choices: string[];
  running: boolean;
  onSkip: () => void;
}) {
  const { verdict } = exchange;
  const [skipping, setSkipping] = useState(false);
  const open = running && !verdict && !exchange.skipped;
  const [first, second] = mode === "symmetric" ? ["Side A", "Side B"] : ["Argues", "Replies"];
  return (
    <div className="exchange">
      <Side label={first} side={pair.persuader} choices={choices} />
      <Side label={second} side={pair.persuadee} choices={choices} />
      {exchange.turns.length === 0 && (
        <p className="dim turn-wait">{exchange.started ? "" : "waiting…"}</p>
      )}
      {exchange.turns.length > 0 && (
        <ol className="turns">
          {exchange.turns.map((t, i) => {
            const side = pair[t.speaker];
            const switched = t.vote !== null && t.vote !== side.choice;
            const standIn = t.standIn !== undefined;
            return (
              <li key={i} className={`turn turn-${t.speaker}`}>
                <div className="turn-head">
                  <span className="n">{i + 1}</span>
                  <span className="vote-model" title={standIn ? t.standIn || undefined : side.model}>
                    {standIn ? (t.standIn ? modelName(t.standIn) : "rerouting…") : modelName(side.model)}
                  </span>
                  {standIn && (
                    <Tag tone="warn" title={`${modelName(side.model)} didn't answer in time, so flexrouter found a stand-in`}>
                      for {modelName(side.model)}
                    </Tag>
                  )}
                  {t.vote && <ChoiceTag choices={choices} choice={t.vote} />}
                  {switched && <Tag tone="violet">switched</Tag>}
                </div>
                <p className={t.done ? undefined : "cursor"}>{t.text}</p>
              </li>
            );
          })}
        </ol>
      )}
      {open && (
        <div className="exchange-foot">
          <span className="dim">{exchange.started ? "debating…" : "queued"}</span>
          <span className="spacer" />
          <button
            className="btn ghost"
            disabled={skipping}
            onClick={() => {
              setSkipping(true);
              onSkip();
            }}
          >
            {skipping ? "Skipping…" : "Skip"}
          </button>
        </div>
      )}
      {verdict && (
        <div className="exchange-foot">
          {exchange.skipped && <Tag title={exchange.skipped}>{exchange.skipped === "Skipped" ? "skipped" : "cut short"}</Tag>}
          <Outcome
            label={modelName(pair.persuader.model)}
            from={pair.persuader.choice}
            to={verdict.persuader.finalChoice}
            flipped={verdict.persuader.flipped}
          />
          <span className="spacer" />
          <Outcome
            label={modelName(pair.persuadee.model)}
            from={pair.persuadee.choice}
            to={verdict.persuadee.finalChoice}
            flipped={verdict.persuadee.flipped}
          />
        </div>
      )}
    </div>
  );
}

export function Debate({
  state,
  live,
  onStart,
  onSkip,
}: {
  state: ArenaState;
  live: boolean;
  onStart: (mode: DebateMode) => void;
  onSkip: (pair: number | "all") => void;
}) {
  const { debate, choices } = state;
  const [mode, setMode] = useState<DebateMode>("persuade");

  if (!debate) {
    if (state.phase !== "done" || state.fromHistory) return null;
    const pairs = buildPairs(state.votes).length;
    return (
      <Box title="Round 2 · the debate">
        {pairs === 0 ? (
          <p className="dim" style={{ margin: 0 }}>
            No dissent to debate: every model agreed.
          </p>
        ) : (
          <>
            <div className="seg" role="radiogroup" aria-label="Debate mode">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  role="radio"
                  aria-checked={mode === m.mode}
                  className={mode === m.mode ? "on" : undefined}
                  onClick={() => setMode(m.mode)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="dilemma-row">
              <span className="dim">
                Each minority voter faces a majority voter. {MODES.find((m) => m.mode === mode)!.blurb}
              </span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => onStart(mode)} disabled={live}>
                Start {pairs} match-up{pairs === 1 ? "" : "s"} →
              </button>
            </div>
          </>
        )}
      </Box>
    );
  }

  const decided = debate.exchanges.filter((e) => e.verdict);
  const remaining = debate.exchanges.filter((e) => !e.verdict && !e.skipped).length;
  const flips = decided.reduce(
    (n, e) => n + (e.verdict!.persuader.flipped ? 1 : 0) + (e.verdict!.persuadee.flipped ? 1 : 0),
    0
  );
  const sub = debate.running
    ? `${debate.mode} · ${decided.length} of ${debate.pairs.length} decided`
    : `${debate.mode} · ${flips} mind${flips === 1 ? "" : "s"} changed in ${decided.length} match-up${decided.length === 1 ? "" : "s"}`;

  return (
    <Box
      title="Round 2 · the debate"
      sub={sub}
      flush
      action={
        debate.running && remaining > 1 ? (
          <button className="btn ghost" onClick={() => onSkip("all")}>
            Skip remaining ({remaining})
          </button>
        ) : undefined
      }
    >
      {debate.error && (
        <p className="error-note" style={{ padding: 14 }}>
          {debate.error}
        </p>
      )}
      <div className="debate">
        {debate.pairs.map((pair, i) => (
          <ExchangeView
            key={i}
            pair={pair}
            exchange={debate.exchanges[i]}
            mode={debate.mode}
            choices={choices}
            running={debate.running}
            onSkip={() => onSkip(i)}
          />
        ))}
      </div>
    </Box>
  );
}
