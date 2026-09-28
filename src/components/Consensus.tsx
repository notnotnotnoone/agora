import { tally, type ArenaState } from "@/lib/arena";
import { pct } from "@/lib/format";
import { Box, choiceColor } from "./ui";

export function Consensus({ state }: { state: ArenaState }) {
  const { choices, votes, phase } = state;

  if (phase === "extracting") {
    return (
      <Box title="Consensus">
        <p className="dim cursor">Reading the dilemma for its options</p>
      </Box>
    );
  }
  if (choices.length === 0) return null;

  const counts = tally(votes, choices);
  const cast = [...counts.values()].reduce((a, b) => a + b, 0);
  const pending = votes.filter((v) => v.status === "streaming").length;
  const [leader, lead] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a));
  const unanimous = cast > 0 && lead === cast;

  return (
    <Box title="Consensus" sub={`${cast} vote${cast === 1 ? "" : "s"}${pending ? ` · ${pending} deciding` : ""}`}>
      <div className="consensus-bar" role="img" aria-label={choices.map((c) => `${c}: ${counts.get(c)}`).join(", ")}>
        {choices.map((c) => (
          <span key={c} style={{ flexGrow: counts.get(c) ?? 0, background: choiceColor(choices, c) }} />
        ))}
        {cast === 0 && <span style={{ flexGrow: 1 }} />}
      </div>
      <div className="legend">
        {choices.map((c) => (
          <span className="legend-item" key={c}>
            <span className="swatch" style={{ background: choiceColor(choices, c) }} />
            {c}
            <span className="legend-count">{counts.get(c)}</span>
            <span className="n">{pct(counts.get(c) ?? 0, cast)}</span>
          </span>
        ))}
      </div>
      {cast > 0 && phase === "done" && (
        <p className="consensus-note">
          {unanimous ? `Unanimous: every model chose ${leader}.` : `${leader} leads with ${pct(lead, cast)} of the vote.`}
        </p>
      )}
    </Box>
  );
}
