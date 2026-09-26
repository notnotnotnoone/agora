import type { ArenaState } from "@/lib/arena";
import { ms, modelName, num, providerOf } from "@/lib/format";
import type { Vote } from "@/lib/types";
import { Box, ChoiceTag, Tag } from "./ui";

/** Which models this vote passed over before one answered, e.g. ✕ a → ✕ b → ● c. */
function Chain({ vote }: { vote: Vote }) {
  if (vote.skipped.length === 0) return null;
  return (
    <div className="chain" aria-label="Failover">
      {vote.skipped.map((s, i) => (
        <span key={i}>
          <span className="skip" title={s.reason}>
            ✕ {modelName(s.model)}
          </span>
          <span className="arrow"> →</span>
        </span>
      ))}
      <span className={vote.status === "failed" ? "skip" : "hit"}>
        {vote.status === "failed" ? "nothing left" : `● ${modelName(vote.model)}`}
      </span>
    </div>
  );
}

function VoteCard({ vote, choices }: { vote: Vote; choices: string[] }) {
  const reason = vote.choice ? vote.reasons[vote.choice] : "";
  const tail = vote.text.length > 320 ? `…${vote.text.slice(-320)}` : vote.text;

  return (
    <article className={`vote ${vote.status}`}>
      <div className="vote-head">
        {!(vote.status === "failed" && vote.skipped.length) && <Tag>{providerOf(vote.model)}</Tag>}
        <span className="vote-model" title={vote.model}>
          {vote.status === "failed" && vote.skipped.length ? "no model left" : modelName(vote.model)}
        </span>
        {vote.status === "done" && vote.choice && <ChoiceTag choices={choices} choice={vote.choice} />}
        {vote.status === "streaming" && <Tag tone="blue">deciding</Tag>}
        {vote.status === "failed" && <Tag tone="bad">no vote</Tag>}
      </div>
      <Chain vote={vote} />
      {vote.status === "streaming" && <p className="vote-text cursor">{tail}</p>}
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
    <Box title="Votes" sub="each from a different model" flush>
      <div className="vote-grid">
        {state.votes.map((v) => (
          <VoteCard key={v.slot} vote={v} choices={state.choices} />
        ))}
      </div>
    </Box>
  );
}
