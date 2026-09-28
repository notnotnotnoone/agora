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
      {vote.status === "streaming" && vote.model && <p className="vote-text cursor">{tail}</p>}
      {vote.status === "failed" && vote.error && <p className="vote-text dim">{vote.error}</p>}
      {vote.status === "done" && reason && <p className="vote-text">{reason}</p>}
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
