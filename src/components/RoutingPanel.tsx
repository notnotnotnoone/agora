"use client";

import { useNow } from "@/hooks/useFlexrouter";
import type { ArenaState } from "@/lib/arena";
import { countdown } from "@/lib/format";
import type { FlexrouterSnapshot, RosterModel } from "@/lib/types";
import { Box } from "./ui";

const STATE_WORD: Record<RosterModel["state"], string> = {
  ready: "ready",
  busy: "cooling",
  struggling: "struggling",
  needs_you: "needs you",
  off: "off",
};

/** Every model flexrouter can route to, its live status, and what it's doing in this run. */
export function RoutingPanel({ snapshot, state }: { snapshot: FlexrouterSnapshot | null; state: ArenaState }) {
  const now = useNow();

  if (!snapshot) {
    return (
      <Box title="Routing" sub="flexrouter">
        <p className="dim cursor" style={{ margin: 0 }}>
          Connecting
        </p>
      </Box>
    );
  }
  if (!snapshot.connected) {
    return (
      <Box title="Routing" sub="flexrouter">
        <div className="empty">
          <p>{snapshot.error}</p>
          <p className="faint" style={{ marginTop: 8 }}>
            Start it with <code>flexrouter serve</code>. This panel reconnects on its own.
          </p>
        </div>
      </Box>
    );
  }

  const activity = new Map<string, string>();
  for (const v of state.votes) {
    for (const s of v.skipped) activity.set(s.model, "skipped");
    if (v.status === "streaming") activity.set(v.model, "voting");
    if (v.status === "done" && v.choice) activity.set(v.model, `voted ${v.choice}`);
  }

  const ready = snapshot.models.filter((m) => m.state === "ready").length;

  return (
    <Box title="Routing" sub={`${ready} of ${snapshot.models.length} ready`} flush>
      {snapshot.models.length === 0 ? (
        <div className="empty" style={{ margin: 14 }}>
          <p>flexrouter has no models yet. Add some to its config.yaml.</p>
        </div>
      ) : (
        <ul className="roster">
          {snapshot.models.map((m) => {
            const doing = activity.get(m.id);
            const left = countdown(m.until, now);
            return (
              <li key={m.id} className={doing === "voting" ? "active" : undefined} title={m.reason || undefined}>
                <span className={`swatch state-${m.state}`} />
                <span style={{ minWidth: 0 }}>
                  <span className="roster-name">{m.name}</span>
                  <span className="roster-sub">
                    {m.provider} · score {m.score}
                    {doing ? ` · ${doing}` : ""}
                  </span>
                </span>
                <span className={`roster-state text-${m.state}`}>
                  {STATE_WORD[m.state]}
                  {left && <span className="n roster-left">{left}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Box>
  );
}
