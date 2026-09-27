"use client";

import { useEffect, useMemo, useState } from "react";
import { clock, ms, num, parseAt } from "@/lib/format";
import type { Journey, JourneyStep, Phase, RequestOutcome, RequestRow } from "@/lib/types";
import { Box, Sheet, Tag } from "./ui";

// flexrouter's Requests page (flexrouter/dashboard/requests_page.py), fed by
// flexrouter itself: the rows are GET /api/requests for this run's client
// tag, and the journey is GET /api/requests/{id}. Agora adds only what it
// alone knows: which phase of the run each request was for.

const RESULTS: [RequestOutcome | "", string][] = [
  ["", "Any result"],
  ["ok", "OK"],
  ["failover", "Failover"],
  ["failed", "Failed"],
];
const OUTCOME_WORD: Record<RequestOutcome, string> = { ok: "OK", failover: "FAILOVER", failed: "FAILED" };
const PHASE_WORD: Record<Phase, string> = { extract: "options", vote: "vote", summary: "tl;dr", debate: "debate" };
const PAGE = 50;

function answered(r: RequestRow): string {
  return r.answered_by ? `${r.answered_by.provider}/${r.answered_by.model}` : "nothing answered";
}

const where = (s: { provider: string; model: string }) => `${s.provider}/${s.model}`;

/** Journey steps, with a run of "already voted" exclusions folded into one. */
type Shown = JourneyStep | { kind: "excluded"; models: string[] };

function fold(steps: JourneyStep[]): Shown[] {
  const out: Shown[] = [];
  for (const s of steps) {
    const last = out.at(-1);
    if (s.kind === "skipped" && s.reason === "excluded") {
      if (last?.kind === "excluded") last.models.push(where(s));
      else out.push({ kind: "excluded", models: [where(s)] });
    } else out.push(s);
  }
  return out;
}

function Step({ step, n }: { step: Shown; n: number }) {
  const head = (glyph: string, word: string, at?: string) => (
    <div className="jstep-head">
      <span className="jstep-kind">
        {glyph} {word}
      </span>
      {at && <span className="jstep-where">{at}</span>}
    </div>
  );
  let body;
  switch (step.kind) {
    case "excluded":
      body = (
        <>
          {head("○", "LEFT OUT", `${step.models.length} model${step.models.length === 1 ? "" : "s"}`)}
          <div className="jstep-detail">Agora asked flexrouter to leave these out: they had already voted.</div>
          <details>
            <summary>Which</summary>
            <p className="mono dim">{step.models.join(", ")}</p>
          </details>
        </>
      );
      break;
    case "skipped":
      body = (
        <>
          {head("○", "PASSED OVER", where(step))}
          <div className="jstep-detail">{step.detail || step.reason.replaceAll("_", " ")}</div>
          <Tag>{step.reason.replaceAll("_", " ")}</Tag>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          {head("✕", "FAILED", where(step))}
          {step.message && <pre className="jstep-msg">{step.message}</pre>}
          <div className="jstep-meta">
            <Tag tone="bad">{step.status ? `HTTP ${step.status}` : "no status"}</Tag>
            {step.verdict && <Tag tone="violet">{step.verdict.replaceAll("_", " ")}</Tag>}
            {step.ms != null && <span className="n">{ms(step.ms)}</span>}
          </div>
        </>
      );
      break;
    case "answered":
      body = (
        <>
          {head("●", "ANSWERED", where(step))}
          <span className="n">{ms(step.ms ?? 0)} total</span>
        </>
      );
      break;
    case "gave_up":
      body = (
        <>
          {head("▲", "NOTHING ANSWERED")}
          <div className="jstep-detail">Every option was tried or passed over.</div>
        </>
      );
  }
  const cls = step.kind === "excluded" ? "skipped" : step.kind;
  return (
    <li className={`jstep jstep-${cls}`}>
      <span className="jstep-n">{n}</span>
      <div className="jstep-body">{body}</div>
    </li>
  );
}

function JourneySheet({
  id,
  phase,
  dashboardUrl,
  onClose,
}: {
  id: string;
  phase: Phase | undefined;
  dashboardUrl: string;
  onClose: () => void;
}) {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    fetch(`/api/requests/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (stopped) return;
        if (res.ok) setJourney(body);
        else setError(body.error ?? `flexrouter answered ${res.status}`);
      })
      .catch(() => !stopped && setError("Agora's server isn't answering"));
    return () => {
      stopped = true;
    };
  }, [id]);

  return (
    <Sheet title="Request" sub="What flexrouter tried, in order" onClose={onClose}>
      {error && <p className="error-note">{error}</p>}
      {!journey && !error && <p className="dim cursor">Reading flexrouter&apos;s trace</p>}
      {journey && (
        <>
          <div className="jtop">
            <span className={`outcome outcome-${journey.outcome}`}>{OUTCOME_WORD[journey.outcome]}</span>
            <span className="n">{journey.id}</span>
            {phase && <Tag>{PHASE_WORD[phase]}</Tag>}
          </div>
          <div className="jfacts">
            {(
              [
                ["Asked for", journey.bucket || "-"],
                ["Took", ms(journey.ms_total)],
                ["Tokens", `${num(journey.tokens_in)} in / ${num(journey.tokens_out)} out`],
                ["When", clock(parseAt(journey.at))],
              ] as const
            ).map(([k, v]) => (
              <div className="jfact" key={k}>
                <span className="stat-label">{k}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>
          <h3 className="sheet-h">Journey</h3>
          <ol className="journey">
            {fold(journey.steps).map((s, i) => (
              <Step key={i} step={s} n={i + 1} />
            ))}
          </ol>
        </>
      )}
      <a
        className="btn ghost"
        href={`${dashboardUrl}/requests?id=${encodeURIComponent(id)}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in flexrouter ↗
      </a>
    </Sheet>
  );
}

export function RequestLog({
  rows,
  phases,
  error,
  live,
  dashboardUrl,
}: {
  rows: RequestRow[];
  phases: Record<string, Phase>;
  error: string | null;
  live: boolean;
  dashboardUrl: string;
}) {
  const [result, setResult] = useState<RequestOutcome | "">("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!result || r.outcome === result) &&
        (!needle || `${r.id} ${r.bucket} ${answered(r)} ${phases[r.id] ?? ""}`.toLowerCase().includes(needle))
    );
  }, [rows, phases, result, q]);

  const count = (o: RequestOutcome) => rows.filter((r) => r.outcome === o).length;
  const filtering = Boolean(result || q.trim());

  return (
    <Box
      title="Requests"
      sub={
        rows.length
          ? `${num(rows.length)} this run · ${count("failover")} failovers · ${count("failed")} failed`
          : "this run's requests, read from flexrouter's log"
      }
      action={
        <span className={live ? "live" : "live off"}>
          <span className="live-dot" />
          {live ? "live" : "flexrouter log"}
        </span>
      }
      flush
    >
      <div className="filters">
        <input
          type="search"
          placeholder="Search id, model or phase"
          aria-label="Search requests"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as RequestOutcome | "")}>
          {RESULTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="error-note" style={{ margin: 14 }}>
          {error}
        </p>
      )}
      {matched.length === 0 ? (
        <div className="empty" style={{ margin: 14 }}>
          <p>
            {filtering
              ? "No requests match these filters."
              : "Nothing logged yet. flexrouter logs each request as it finishes, and they appear here."}
          </p>
        </div>
      ) : (
        <>
          <div className="scroll">
            <table className="log">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Phase</th>
                  <th>Answered by</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num">Took</th>
                  <th>Result</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {matched.slice(0, limit).map((r) => (
                  <tr key={r.id} className="req-row" onClick={() => setOpenId(r.id)}>
                    <td className="mono dim">
                      <button className="row-link" onClick={() => setOpenId(r.id)}>
                        {clock(parseAt(r.at))}
                      </button>
                    </td>
                    <td className="mono">{phases[r.id] ? PHASE_WORD[phases[r.id]] : "-"}</td>
                    <td className="mono">
                      {answered(r)}
                      {r.attempt_count > 0 && (
                        <span className="hop">
                          {" "}
                          · after {r.attempt_count} failed attempt{r.attempt_count === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="num mono">
                      {num(r.tokens_in)} / {num(r.tokens_out)}
                    </td>
                    <td className="num mono">{ms(r.ms_total)}</td>
                    <td>
                      <span className={`outcome outcome-${r.outcome}`}>{OUTCOME_WORD[r.outcome]}</span>
                    </td>
                    <td className="mono faint">{r.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matched.length > limit && (
            <div
              className="dilemma-row"
              style={{ justifyContent: "center", padding: 14, marginTop: 0, borderTop: "1px solid var(--rule)" }}
            >
              <button className="btn" onClick={() => setLimit(limit + PAGE)}>
                Load {Math.min(PAGE, matched.length - limit)} more
              </button>
            </div>
          )}
        </>
      )}
      {openId && (
        <JourneySheet id={openId} phase={phases[openId]} dashboardUrl={dashboardUrl} onClose={() => setOpenId(null)} />
      )}
    </Box>
  );
}
