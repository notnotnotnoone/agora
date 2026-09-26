import { providerShares, type ArenaState } from "@/lib/arena";
import { num, usd } from "@/lib/format";
import { Box } from "./ui";

const TONES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];

/** How the run's work spread across providers: the free-tier pooling, made visible. */
export function ProviderMix({ state, spentUsd }: { state: ArenaState; spentUsd: number | null }) {
  const shares = providerShares(state.votes, state.calls);
  if (shares.length === 0) return null;
  const maxVotes = Math.max(1, ...shares.map((s) => s.votes));
  const tokens = shares.reduce((n, s) => n + s.tokens, 0);

  return (
    <Box title="Provider mix" sub="votes per provider">
      <div className="mix">
        {shares.map((s, i) => (
          <div className="mix-row" key={s.provider}>
            <span className="mix-name" title={s.provider}>
              {s.provider}
            </span>
            <div className="mix-track">
              <div
                className="mix-fill"
                style={{ width: `${(s.votes / maxVotes) * 100}%`, background: TONES[i % TONES.length] }}
              />
            </div>
            <span className="n">
              {s.votes} · {num(s.tokens)} tok
            </span>
          </div>
        ))}
        <div className="mix-foot">
          <span className="n">{num(tokens)} tokens served</span>
          <span className="n" style={{ color: spentUsd === 0 ? "var(--green)" : undefined }}>
            {spentUsd === null ? "" : `${usd(spentUsd)} spent`}
          </span>
        </div>
      </div>
    </Box>
  );
}
