"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";
import type { DebatePair, DebateEvent, ModelConfigPublic, PairState } from "@/lib/types";
import { DebatePanel } from "./debate-panel";

interface Round2ViewProps {
  question: string;
  choices: string[];
  pairs: DebatePair[];
  models: ModelConfigPublic[];
  onBack: () => void;
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
  };
}

export function Round2View({ question, choices, pairs, models, onBack }: Round2ViewProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [pairStates, setPairStates] = useState<PairState[]>(() =>
    pairs.map(() => initialPairState())
  );
  const abortRef = useRef<AbortController | null>(null);

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

        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const dec = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });

          for (const line of chunk.split("\n")) {
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

            if (event.type === "pair_start") {
              const { pairIndex } = event;
              setPairStates((prev) =>
                prev.map((s, i) => (i === pairIndex ? { ...s, started: true } : s))
              );
            } else if (event.type === "turn_token") {
              const { pairIndex, turn, token } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex) return s;
                  return turn === "persuader"
                    ? { ...s, persuaderText: s.persuaderText + token }
                    : { ...s, persuadeeText: s.persuadeeText + token };
                })
              );
            } else if (event.type === "turn_done") {
              const { pairIndex, turn, text } = event;
              setPairStates((prev) =>
                prev.map((s, i) => {
                  if (i !== pairIndex) return s;
                  return turn === "persuader"
                    ? { ...s, persuaderText: text, persuaderDone: true }
                    : { ...s, persuadeeText: text, persuadeeDone: true };
                })
              );
            } else if (event.type === "verdict") {
              const { pairIndex, finalVote, flipped } = event;
              setPairStates((prev) =>
                prev.map((s, i) =>
                  i === pairIndex ? { ...s, finalVote, flipped } : s
                )
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") console.error(err);
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

        {/* Tab bar */}
        {showTabs && (
          <div className="flex gap-1 border-b border-border">
            {pairs.map((_, i) => {
              const inProgress = pairStates[i].started && !pairStates[i].persuadeeDone;
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
        />
      </div>
    </motion.div>
  );
}
