import type { ArenaState } from "@/lib/arena";
import type { RequestRow } from "@/lib/types";
import { num, usd } from "@/lib/format";

export function StatsStrip({
  state,
  requests,
  spentUsd,
}: {
  state: ArenaState;
  requests: RequestRow[];
  spentUsd: number | null;
}) {
  const done = state.votes.filter((v) => v.status === "done");
  const providers = new Set(done.flatMap((v) => (v.model ? [v.model.split("/")[0]] : [])));
  const failovers = requests.filter((r) => r.outcome === "failover").length;
  const tokens = requests.reduce((n, r) => n + r.tokens_in + r.tokens_out, 0);

  const stats: { label: string; value: string; note: string; good?: boolean }[] = [
    { label: "Votes", value: `${done.length}`, note: state.requested ? `of ${state.requested} asked` : "none yet" },
    { label: "Providers", value: `${providers.size}`, note: "free tiers pooled" },
    { label: "Failovers", value: `${failovers}`, note: "requests saved by another model" },
    { label: "Requests", value: num(requests.length), note: "in flexrouter's log" },
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
