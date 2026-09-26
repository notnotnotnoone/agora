"use client";

import { useMemo, useState } from "react";
import { clock, ms, num } from "@/lib/format";
import type { CallRecord, Outcome, Phase } from "@/lib/types";
import { Box, Sheet, Tag } from "./ui";

// A port of flexrouter's Requests page (flexrouter/dashboard/requests_page.py):
// the same columns, filters and journey panel, fed by the requests this
// Agora session sent through flexrouter. flexrouter only reports a request's
// failed attempts when the request fails, so rows here are OK or FAILED; the
// full trace, failovers included, is one click away in flexrouter itself.

const RESULTS: [Outcome | "", string][] = [
  ["", "Any result"],
  ["ok", "OK"],
  ["failed", "Failed"],
];
const OUTCOME_WORD: Record<Outcome, string> = { ok: "OK", failed: "FAILED" };
const PHASE_WORD: Record<Phase, string> = { extract: "options", vote: "vote", summary: "tl;dr", debate: "debate" };
const PAGE = 50;

function answered(c: CallRecord): string {
  return c.answeredBy ?? (c.outcome === "failed" ? "nothing answered" : `bucket ${c.asked}`);
}

function Journey({ call, dashboardUrl, onClose }: { call: CallRecord; dashboardUrl: string; onClose: () => void }) {
  const facts: [string, string][] = [
    ["Asked for", call.asked],
    ["Took", ms(call.ms)],
    ["Tokens", `${num(call.usage.in)} in / ${num(call.usage.out)} out`],
    ["When", clock(call.at)],
  ];
  const fromFlexrouter = call.id.startsWith("req_");

  return (
    <Sheet title="Request" sub="What flexrouter tried, in order" onClose={onClose}>
      <div className="jtop">
        <span className={`outcome outcome-${call.outcome}`}>{OUTCOME_WORD[call.outcome]}</span>
        <span className="n">{call.id}</span>
        <Tag>{PHASE_WORD[call.phase]}</Tag>
      </div>
      <div className="jfacts">
        {facts.map(([k, v]) => (
          <div className="jfact" key={k}>
            <span className="stat-label">{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <h3 className="sheet-h">Journey</h3>
      <ol className="journey">
        {call.attempts.map((a, i) => (
          <li className="jstep jstep-failed" key={i}>
            <span className="jstep-n">{i + 1}</span>
            <div className="jstep-body">
              <div className="jstep-head">
                <span className="jstep-kind">✕ FAILED</span>
                <span className="jstep-where">{a.model}</span>
              </div>
              {a.message && <pre className="jstep-msg">{a.message}</pre>}
              <div className="jstep-meta">
                <Tag tone="bad">{a.status ? `HTTP ${a.status}` : "no status"}</Tag>
                {a.verdict && <Tag tone="violet">{a.verdict.replaceAll("_", " ")}</Tag>}
                {a.ms !== null && <span className="n">{ms(a.ms)}</span>}
              </div>
            </div>
          </li>
        ))}
        {call.outcome === "failed" ? (
          <li className="jstep jstep-gave_up">
            <span className="jstep-n">{call.attempts.length + 1}</span>
            <div className="jstep-body">
              <div className="jstep-head">
                <span className="jstep-kind">▲ NOTHING ANSWERED</span>
              </div>
              <div className="jstep-detail">{call.error ?? "Every option was tried or passed over."}</div>
            </div>
          </li>
        ) : (
          <li className="jstep jstep-answered">
            <span className="jstep-n">{call.attempts.length + 1}</span>
            <div className="jstep-body">
              <div className="jstep-head">
                <span className="jstep-kind">● ANSWERED</span>
                <span className="jstep-where">{answered(call)}</span>
              </div>
              <span className="n">{ms(call.ms)} total</span>
            </div>
          </li>
        )}
      </ol>
      {fromFlexrouter && (
        <a className="btn ghost" href={`${dashboardUrl}/requests?id=${encodeURIComponent(call.id)}`} target="_blank" rel="noreferrer">
          Full trace in flexrouter ↗
        </a>
      )}
    </Sheet>
  );
}

export function RequestLog({ calls, dashboardUrl }: { calls: CallRecord[]; dashboardUrl: string }) {
  const [result, setResult] = useState<Outcome | "">("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return calls.filter(
      (c) =>
        (!result || c.outcome === result) &&
        (!needle || `${c.id} ${c.asked} ${answered(c)} ${c.phase}`.toLowerCase().includes(needle))
    );
  }, [calls, result, q]);

  const failed = calls.filter((c) => c.outcome === "failed").length;
  const open = calls.find((c) => c.id === openId);
  const filtering = Boolean(result || q.trim());

  return (
    <Box
      title="Requests"
      sub={calls.length ? `${num(calls.length)} this run · ${failed} failed` : "every request Agora sends through flexrouter"}
      action={
        <span className="live">
          <span className="live-dot" />
          live
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
        <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as Outcome | "")}>
          {RESULTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {matched.length === 0 ? (
        <div className="empty" style={{ margin: 14 }}>
          <p>
            {filtering
              ? "No requests match these filters."
              : "Nothing has come through yet. Ask a dilemma and every request appears here as it happens."}
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
                {matched.slice(0, limit).map((c) => (
                  <tr key={c.id} className="req-row" onClick={() => setOpenId(c.id)}>
                    <td className="mono dim">
                      <button className="row-link" onClick={() => setOpenId(c.id)}>
                        {clock(c.at)}
                      </button>
                    </td>
                    <td className="mono">{PHASE_WORD[c.phase]}</td>
                    <td className="mono">
                      {answered(c)}
                      {c.attempts.length > 0 && (
                        <span className="hop">
                          {" "}
                          · {c.attempts.length} failed attempt{c.attempts.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="num mono">
                      {num(c.usage.in)} / {num(c.usage.out)}
                    </td>
                    <td className="num mono">{ms(c.ms)}</td>
                    <td>
                      <span className={`outcome outcome-${c.outcome}`}>{OUTCOME_WORD[c.outcome]}</span>
                    </td>
                    <td className="mono faint">{c.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matched.length > limit && (
            <div className="dilemma-row" style={{ justifyContent: "center", padding: 14, marginTop: 0, borderTop: "1px solid var(--rule)" }}>
              <button className="btn" onClick={() => setLimit(limit + PAGE)}>
                Load {Math.min(PAGE, matched.length - limit)} more
              </button>
            </div>
          )}
        </>
      )}
      {open && <Journey call={open} dashboardUrl={dashboardUrl} onClose={() => setOpenId(null)} />}
    </Box>
  );
}
