import type { ArenaState } from "@/lib/arena";
import { num, usd } from "@/lib/format";

export function StatsStrip({ state, spentUsd }: { state: ArenaState; spentUsd: number | null }) {
  const done = state.votes.filter((v) => v.status === "done");
  const providers = new Set(done.map((v) => v.model.split("/")[0]));
  const failovers = state.votes.reduce((n, v) => n + v.skipped.length, 0);
  const tokens = state.calls.reduce((n, c) => n + c.usage.in + c.usage.out, 0);

  const stats: { label: string; value: string; note: string; good?: boolean }[] = [
    { label: "Votes", value: `${done.length}`, note: state.requested ? `of ${state.requested} asked` : "none yet" },
    { label: "Providers", value: `${providers.size}`, note: "free tiers pooled" },
    { label: "Failovers", value: `${failovers}`, note: "models skipped, votes kept" },
    { label: "Requests", value: num(state.calls.length), note: "through flexrouter" },
    { label: "Tokens", value: num(tokens), note: "in + out" },
    {
      label: "Spent",
      value: spentUsd === null ? "-" : usd(spentUsd),
      note: "flexrouter session",
      good: spentUsd === 0,
    },
  ];

  return (
    <div className="stats">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <span className="stat-label">{s.label}</span>
          <span className={s.good ? "stat-value good" : "stat-value"}>{s.value}</span>
          <span className="stat-note">{s.note}</span>
        </div>
      ))}
    </div>
  );
}
