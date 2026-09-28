"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { arenaReducer, initialState, isLive, toSavedRun } from "@/lib/arena";
import { buildPairs } from "@/lib/debate";
import { saveRun, type SavedRun } from "@/lib/history";
import { readJsonEvents } from "@/lib/sse";
import type { DebateEvent, DebateMode, RunEvent } from "@/lib/types";

async function postStream<E>(url: string, body: unknown, signal: AbortSignal, onEvent: (event: E) => void) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `${url} answered ${res.status}`);
  }
  for await (const event of readJsonEvents<E>(res.body)) onEvent(event);
}

// Not crypto.randomUUID: that only exists on https or localhost, and Agora is
// often opened over plain http from another device on the network.
const newRunId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

export function useArena() {
  const [state, dispatch] = useReducer(arenaReducer, initialState);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    async (question: string, votes: number) => {
      cancel();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const runId = newRunId();
      dispatch({ type: "start", runId, at: Date.now(), question, votes });
      try {
        await postStream<RunEvent>("/api/run", { question, votes, runId }, ctrl.signal, (event) =>
          dispatch({ type: "run", event })
        );
      } catch (err) {
        if (!isAbort(err)) dispatch({ type: "fail", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [cancel]
  );

  const stop = useCallback(() => {
    cancel();
    dispatch({ type: "stop" });
    dispatch({ type: "debate_stop" });
  }, [cancel]);

  const startDebate = useCallback(
    async (mode: DebateMode) => {
    const pairs = buildPairs(state.votes);
    if (pairs.length === 0 || !state.runId) return;
    cancel();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    dispatch({ type: "debate_start", pairs, mode });
    try {
      await postStream<DebateEvent>(
        "/api/debate",
        { question: state.question, choices: state.choices, pairs, mode, runId: state.runId },
        ctrl.signal,
        (event) => dispatch({ type: "debate", event })
      );
    } catch (err) {
      if (!isAbort(err)) dispatch({ type: "debate_fail", message: err instanceof Error ? err.message : String(err) });
    }
    },
    [cancel, state.votes, state.question, state.choices, state.runId]
  );

  /** Skips one debate pair, or every pair still going. */
  const skipPair = useCallback(
    async (pair: number | "all") => {
      if (!state.runId) return;
      const res = await fetch("/api/debate/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: state.runId, pair }),
      }).catch(() => null);
      if (res?.ok) return; // the server ends the pair and reports it on the stream
      // The server has no such debate running; stop waiting on it here.
      if (pair === "all") {
        cancel();
        dispatch({ type: "debate_stop" });
      } else {
        dispatch({ type: "debate", event: { type: "pair_skipped", pair, reason: "Skipped" } });
      }
    },
    [cancel, state.runId]
  );

  const load = useCallback(
    (run: SavedRun) => {
      cancel();
      dispatch({ type: "load", run });
    },
    [cancel]
  );

  // Save finished live runs, and again once their debate has finished.
  const debateRunning = state.debate?.running ?? false;
  useEffect(() => {
    if (state.fromHistory || debateRunning) return;
    const run = toSavedRun(state);
    if (run) saveRun(run).catch((err) => console.error("Agora: couldn't save run", err));
    // Only when a run or debate finishes, not on every token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, debateRunning, state.fromHistory, state.runId]);

  return { state, live: isLive(state.phase), start, stop, startDebate, skipPair, load };
}
