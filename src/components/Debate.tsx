import type { ArenaState, Exchange } from "@/lib/arena";
import { buildPairs } from "@/lib/debate";
import { modelName } from "@/lib/format";
import type { DebatePair } from "@/lib/types";
import { Box, ChoiceTag, Tag } from "./ui";

function Side({
  label,
  side,
  text,
  done,
  started,
  choices,
}: {
  label: string;
  side: DebatePair["persuader"];
  text: string;
  done: boolean;
  started: boolean;
  choices: string[];
}) {
  return (
    <div className="exchange-side">
      <div className="vote-head">
        <span className="field-label">{label}</span>
        <span className="vote-model" title={side.model}>
          {modelName(side.model)}
        </span>
        <ChoiceTag choices={choices} choice={side.choice} />
      </div>
      <p className={started && !done ? "cursor" : undefined}>{text || (started ? "" : "waiting…")}</p>
    </div>
  );
}

function ExchangeView({ pair, exchange, choices }: { pair: DebatePair; exchange: Exchange; choices: string[] }) {
  const { verdict } = exchange;
  return (
    <div className="exchange">
      <Side
        label="Argues"
        side={pair.persuader}
        text={exchange.persuader}
        done={exchange.persuaderDone}
        started={exchange.started}
        choices={choices}
      />
      <Side
        label="Replies"
        side={pair.persuadee}
        text={exchange.persuadee}
        done={exchange.persuadeeDone}
        started={exchange.persuaderDone}
        choices={choices}
      />
      {verdict && (
        <div className="exchange-foot">
          {verdict.flipped ? (
            <>
              <Tag tone="violet">flipped</Tag>
              <span className="mono">
                {pair.persuadee.choice} → {verdict.finalChoice}
              </span>
            </>
          ) : (
            <>
              <Tag>held</Tag>
              <span className="mono dim">stayed with {verdict.finalChoice}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Debate({
  state,
  live,
  onStart,
}: {
  state: ArenaState;
  live: boolean;
  onStart: () => void;
}) {
  const { debate, choices } = state;

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
          <div className="dilemma-row" style={{ marginTop: 0 }}>
            <span className="dim">
              Each minority voter faces a majority voter. They argue once, then the minority votes again.
            </span>
            <span className="spacer" />
            <button className="btn primary" onClick={onStart} disabled={live}>
              Start {pairs} match-up{pairs === 1 ? "" : "s"} →
            </button>
          </div>
        )}
      </Box>
    );
  }

  const decided = debate.exchanges.filter((e) => e.verdict);
  const flipped = decided.filter((e) => e.verdict?.flipped).length;
  const sub = debate.running
    ? `${decided.length} of ${debate.pairs.length} decided`
    : `${flipped} of ${decided.length} changed their mind`;

  return (
    <Box title="Round 2 · the debate" sub={sub} flush>
      {debate.error && (
        <p className="error-note" style={{ padding: 14 }}>
          {debate.error}
        </p>
      )}
      <div className="debate">
        {debate.pairs.map((pair, i) => (
          <ExchangeView key={i} pair={pair} exchange={debate.exchanges[i]} choices={choices} />
        ))}
      </div>
    </Box>
  );
}
