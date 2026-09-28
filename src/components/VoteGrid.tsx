"use client";

import { useState } from "react";
import { voteChain, type ArenaState } from "@/lib/arena";
import { ms, modelName, num, providerOf } from "@/lib/format";
import type { Vote } from "@/lib/types";
import { Box, ChoiceTag, Tag } from "./ui";

/**
 * What this vote went through before it counted, from flexrouter's journeys:
 * ✕ models that failed, ⊘ answers that didn't count, ● the model that voted.
 * Nothing is shown for a vote that went straight through.
 */
function Chain({ vote }: { vote: Vote }) {
  const chain = voteChain(vote);
  if (!chain.some((l) => l.kind !== "answered")) return null;
  return (
    <div className="chain" aria-label="Failover">
      {chain.map((l, i) => (
        <span key={i}>
          {l.kind === "answered" ? (
            <span className="hit">● {modelName(l.model)}</span>
          ) : (
            <>
              <span className={l.kind === "failed" ? "skip" : "rejected"} title={l.note}>
                {l.kind === "failed" ? "✕" : "⊘"} {modelName(l.model)}
              </span>
              <span className="arrow"> →</span>
            </>
          )}
        </span>
      ))}
      {vote.status === "failed" && <span className="skip">no vote</span>}
    </div>
  );
}

/** Text clamped to a few lines, with a toggle to read all of it. */
function Expandable({ text, collapsed, className }: { text: string; collapsed?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 5;
  return (
    <>
      <p className={["vote-text", open && "open", className].filter(Boolean).join(" ")}>
        {open ? text : (collapsed ?? text)}
      </p>
      {long && (
        <button className="more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "show less" : "show more"}
        </button>
      )}
    </>
  );
}

/** A collapsed section holding a long block of the model's own words. */
function Section({ label, text }: { label: string; text: string }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <details>
      <summary>
        {label} <span className="dim">· {num(words)} words</span>
      </summary>
      <p className="full-text">{text.trim()}</p>
    </details>
  );
}

function VoteCard({ vote, choices }: { vote: Vote; choices: string[] }) {
  const reason = vote.choice ? vote.reasons[vote.choice] : "";
  const tail = vote.text.length > 320 ? `…${vote.text.slice(-320)}` : vote.text;

  return (
    <article className={`vote ${vote.status}`}>
      <div className="vote-head">
        {vote.model && <Tag>{providerOf(vote.model)}</Tag>}
        <span className="vote-model" title={vote.model ?? undefined}>
          {vote.model ? modelName(vote.model) : vote.status === "failed" ? "no model" : "routing…"}
        </span>
        {vote.status === "done" && vote.choice && <ChoiceTag choices={choices} choice={vote.choice} />}
        {vote.status === "streaming" && <Tag tone="blue">{vote.model ? "deciding" : "asking flexrouter"}</Tag>}
        {vote.status === "failed" && <Tag tone="bad">no vote</Tag>}
      </div>
      <Chain vote={vote} />
      {vote.status === "streaming" && vote.model && <Expandable text={vote.text} collapsed={tail} className="cursor" />}
      {vote.status === "failed" && vote.error && <p className="vote-text dim">{vote.error}</p>}
      {vote.status === "done" && reason && <Expandable text={reason} />}
      {vote.status === "done" && (
        <>
          <details>
            <summary>Every option</summary>
            <ul className="reasons">
              {choices.map((c) => (
                <li key={c}>
                  <b>{c}</b>
                  {vote.reasons[c] || <span className="dim">no reason given</span>}
                </li>
              ))}
            </ul>
          </details>
          {vote.thinking?.trim() && <Section label="Model reasoning" text={vote.thinking} />}
          {vote.text.trim() && <Section label="Full reply" text={vote.text} />}
          <div className="vote-foot">
            {vote.ms !== undefined && <span className="n">{ms(vote.ms)}</span>}
            {vote.usage && <span className="n">{num(vote.usage.in + vote.usage.out)} tok</span>}
          </div>
        </>
      )}
    </article>
  );
}

export function VoteGrid({ state }: { state: ArenaState }) {
  if (state.votes.length === 0) return null;
  return (
    <Box title="Votes" sub="each from a different model, picked by flexrouter" flush>
      <div className="vote-grid">
        {state.votes.map((v) => (
          <VoteCard key={v.slot} vote={v} choices={state.choices} />
        ))}
      </div>
    </Box>
  );
}
