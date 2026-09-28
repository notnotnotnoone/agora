"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, SkipForward } from "lucide-react";
import { motion } from "framer-motion";
import type { DebatePair, DebateEvent, ModelConfigPublic, PairState } from "@/lib/types";
import { DebatePanel } from "./debate-panel";

interface Round2ViewProps {
  question: string;
  choices: string[];
  pairs: DebatePair[];
  models: ModelConfigPublic[];
  symmetricMode?: boolean;
  onBack: () => void;
}

// Client-side backstop: the server resolves every pair well within this, but if
// a pair goes silent anyway we skip it rather than leave it spinning.
const PAIR_WATCHDOG_MS = 32_000;

function isSettled(s: PairState): boolean {
  return s.finalVote !== null || !!s.skipped;
}

function initialPairState(): PairState {
  return {
    started: false,
    persuaderText: "",
    persuaderDone: false,
    persuadeeText: "",
    persuadeeDone: false,
    finalVote: null,
    flipped: null,
    skipped: null,
  };
}

export function Round2View({ question, choices, pairs, models, onBack }: Round2ViewProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [pairStates, setPairStates] = useState<PairState[]>(() =>
    pairs.map(() => initialPairState())
  );
  const abortRef = useRef<AbortController | null>(null);
  const lastActivity = useRef<number[]>(pairs.map(() => 0));

  const skipPair = (pairIndex: number, reason: string) =>
    setPairStates((prev) =>
      prev.map((s, i) => (i === pairIndex && !isSettled(s) ? { ...s, skipped: reason } : s))
    );

  const skipRemaining = () => {
    abortRef.current?.abort();
    setPairStates((prev) => prev.map((s) => (isSettled(s) ? s : { ...s, skipped: "Skipped" })));
  };

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setPairStates((prev) =>
        prev.some((s, i) => s.started && !isSettled(s) && now - lastActivity.current[i] > PAIR_WATCHDOG_MS)
          ? prev.map((s, i) =>
              s.started && !isSettled(s) && now - lastActivity.current[i] > PAIR_WATCHDOG_MS
                ? { ...s, skipped: "Timed out" }
                : s
            )
          : prev
      );
    }, 2_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const res = await fetch("/api/debate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, choices, pairs }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) throw new Error(`Debate request failed: ${res.status}`);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // Events can straddle network chunks — only parse complete lines.
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            let event: DebateEvent;
            try {
              event = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if ("pairIndex" in event) lastActivity.current[event.pairIndex] = Date.now();

            if (event.type === "pair_start") {
              const { pairIndex } = event;
              setPairStates((prev) =>
                prev.map((s, i) => (i === pairIndex ? { ...s, started: true } : s))
              );
            } else if (event.type === "turn_model") {
              const { pairIndex, turn, modelId } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex) return s;
                  return turn === "persuader"
                    ? { ...s, persuaderModelId: modelId }
                    : { ...s, persuadeeModelId: modelId };
                })
              );
            } else if (event.type === "turn_reset") {
              const { pairIndex, turn } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex) return s;
                  return turn === "persuader" ? { ...s, persuaderText: "" } : { ...s, persuadeeText: "" };
                })
              );
            } else if (event.type === "pair_skipped") {
              skipPair(event.pairIndex, event.reason);
            } else if (event.type === "turn_token") {
              const { pairIndex, turn, token } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex || s.skipped) return s;
                  return turn === "persuader"
                    ? { ...s, persuaderText: s.persuaderText + token }
                    : { ...s, persuadeeText: s.persuadeeText + token };
                })
              );
            } else if (event.type === "turn_done") {
              const { pairIndex, turn, text } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex || s.skipped) return s;
                  return turn === "persuader"
                    ? { ...s, persuaderText: text || s.persuaderText, persuaderDone: true }
                    : { ...s, persuadeeText: text || s.persuadeeText, persuadeeDone: true };
                })
              );
            } else if (event.type === "verdict") {
              const { pairIndex, finalVote, flipped } = event;
              setPairStates((prev) =>
                prev.map((s, i) =>
                  i === pairIndex && !s.skipped ? { ...s, finalVote, flipped } : s
                )
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") console.error(err);
      }
      // Stream ended (or failed): anything still open will never resolve.
      if (!ctrl.signal.aborted) {
        setPairStates((prev) => prev.map((s) => (isSettled(s) ? s : { ...s, skipped: "Skipped — no response" })));
      }
    })();

    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getModelName(modelId: string): string {
    const m = models.find((mod) => mod.id === modelId);
    const full = m?.modelName ?? modelId;
    return full.split("/").pop() ?? full;
  }

  const showTabs = pairs.length > 1;
  const active = pairStates[activeTab];
  const unsettled = pairStates.filter((s) => !isSettled(s)).length;
  const flippedCount = pairStates.filter((s) => s.flipped).length;
  const doneCount = pairStates.filter((s) => s.finalVote !== null).length;

  return (
    <motion.div
      className="min-h-screen bg-background text-foreground"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Back nav */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Round 1
        </button>

        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Round 2 — Debate</h1>
          <p className="text-sm text-muted-foreground line-clamp-2">{question}</p>
        </div>

        {/* Progress + skip controls */}
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {doneCount}/{pairs.length} debates finished · {flippedCount} flipped
            {unsettled === 0 && pairStates.some((s) => s.skipped) &&
              ` · ${pairStates.filter((s) => s.skipped).length} skipped`}
          </span>
          <div className="flex items-center gap-2">
            {active && !isSettled(active) && (
              <button
                onClick={() => skipPair(activeTab, "Skipped")}
                className="flex items-center gap-1 rounded-full border border-border px-3 py-1 hover:text-foreground hover:border-foreground/40 transition-colors"
              >
                <SkipForward className="h-3 w-3" />
                Skip this pair
              </button>
            )}
            {unsettled > 1 && (
              <button
                onClick={skipRemaining}
                className="rounded-full border border-border px-3 py-1 hover:text-foreground hover:border-foreground/40 transition-colors"
              >
                Skip remaining ({unsettled})
              </button>
            )}
          </div>
        </div>

        {/* Tab bar */}
        {showTabs && (
          <div className="flex gap-1 border-b border-border">
            {pairs.map((_, i) => {
              const st = pairStates[i];
              const inProgress = st.started && !isSettled(st);
              return (
                <button
                  key={i}
                  onClick={() => setActiveTab(i)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors ${
                    activeTab === i
                      ? "border-foreground text-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Pair {i + 1}
                  {inProgress && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                  )}
                  {st.flipped && <span className="text-amber-600">↺</span>}
                  {st.skipped && <span className="text-muted-foreground">⤼</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Active debate panel */}
        <DebatePanel
          pair={pairs[activeTab]}
          state={pairStates[activeTab]}
          choices={choices}
          persuaderName={getModelName(pairs[activeTab].persuaderId)}
          persuadeeName={getModelName(pairs[activeTab].persuadeeId)}
          persuaderStandIn={
            active.persuaderModelId && active.persuaderModelId !== pairs[activeTab].persuaderId
              ? getModelName(active.persuaderModelId)
              : null
          }
          persuadeeStandIn={
            active.persuadeeModelId && active.persuadeeModelId !== pairs[activeTab].persuadeeId
              ? getModelName(active.persuadeeModelId)
              : null
          }
        />
      </div>
    </motion.div>
  );
}
