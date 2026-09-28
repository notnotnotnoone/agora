"use client";

import { useState } from "react";
import { useArena } from "@/hooks/useArena";
import { useFlexrouter } from "@/hooks/useFlexrouter";
import { useRequestLog } from "@/hooks/useRequestLog";
import { Consensus } from "./Consensus";
import { Debate } from "./Debate";
import { DilemmaForm } from "./DilemmaForm";
import { HistorySheet } from "./HistorySheet";
import { ProviderMix } from "./ProviderMix";
import { RequestLog } from "./RequestLog";
import { RoutingPanel } from "./RoutingPanel";
import { StatsStrip } from "./StatsStrip";
import { Summary } from "./Summary";
import { VoteGrid } from "./VoteGrid";
import { Box } from "./ui";

const USABLE = new Set(["ready", "busy", "struggling"]);

export function Arena() {
  const { state, live, start, stop, startDebate, load } = useArena();
  const snapshot = useFlexrouter();
  const [historyOpen, setHistoryOpen] = useState(false);
  const busy = live || (state.debate?.running ?? false);
  const log = useRequestLog(state.runId, busy);

  const connected = snapshot?.connected ?? false;
  const available = snapshot?.connected ? snapshot.models.filter((m) => USABLE.has(m.state)).length : null;
  const spent = snapshot?.connected ? snapshot.spentUsd : null;
  const dashboardUrl = snapshot?.dashboardUrl ?? "http://localhost:4891";

  return (
    <main className="main">
      <header className="page-head">
        <div>
          <h1 className="page-title">Agora</h1>
          <p className="page-status">
            Pose a moral dilemma to every model you have. Each one votes once, all of it routed through{" "}
            <a href="https://github.com/notnotnotnoone/flexrouter" target="_blank" rel="noreferrer">
              flexrouter
            </a>{" "}
            across pooled free tiers.
          </p>
        </div>
        <div className="page-actions">
          <span className={snapshot && !connected ? "live off" : "live"}>
            <span className="live-dot" />
            {snapshot ? (connected ? "flexrouter connected" : "flexrouter offline") : "connecting"}
          </span>
          <a className="btn ghost" href={dashboardUrl} target="_blank" rel="noreferrer">
            Dashboard ↗
          </a>
          <button className="btn" onClick={() => setHistoryOpen(true)}>
            History
          </button>
        </div>
      </header>

      <StatsStrip state={state} requests={log.rows} spentUsd={spent} />

      <div className="columns">
        <div className="stack">
          <DilemmaForm live={live} available={available} onRun={start} onStop={stop} />
          {state.fromHistory && (
            <Box title="From history" sub={new Date(state.at).toLocaleString()}>
              <p style={{ margin: 0 }}>{state.question}</p>
            </Box>
          )}
          {state.error && (
            <Box title="Run stopped">
              <p className="error-note">{state.error}</p>
            </Box>
          )}
          <Consensus state={state} />
          <VoteGrid state={state} />
          <Summary state={state} />
          <Debate state={state} live={busy} onStart={startDebate} />
        </div>
        <div className="stack aside">
          <RoutingPanel snapshot={snapshot} state={state} />
          <ProviderMix state={state} requests={log.rows} spentUsd={spent} />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <RequestLog
          rows={log.rows}
          phases={state.phases}
          error={log.error}
          live={busy}
          dashboardUrl={dashboardUrl}
        />
      </div>

      {historyOpen && <HistorySheet onLoad={load} onClose={() => setHistoryOpen(false)} />}
    </main>
  );
}
