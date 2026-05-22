"use client";

import { motion, AnimatePresence } from "framer-motion";
import { BADGE_COLORS, choiceIndex } from "@/lib/choice-colors";
import type { DebatePair, PairState } from "@/lib/types";

interface DebatePanelProps {
  pair: DebatePair;
  state: PairState;
  choices: string[];
  persuaderName: string;
  persuadeeName: string;
}

export function DebatePanel({ pair, state, choices, persuaderName, persuadeeName }: DebatePanelProps) {
  const persuaderBadge = BADGE_COLORS[choiceIndex(pair.persuaderVote, choices)];
  const persuadeeBadge = BADGE_COLORS[choiceIndex(pair.persuadeeVote, choices)];
  const finalBadge = state.finalVote
    ? BADGE_COLORS[choiceIndex(state.finalVote, choices)]
    : persuadeeBadge;

  return (
    <div className="space-y-4">
      {/* Matchup header */}
      <div className="flex items-center justify-between text-xs text-muted-foreground border border-border rounded-lg px-4 py-2 bg-muted/20">
        <span className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${persuaderBadge}`}>
            {pair.persuaderVote}
          </span>
          {persuaderName}
        </span>
        <span className="text-muted-foreground font-medium">vs</span>
        <span className="flex items-center gap-1.5">
          {persuadeeName}
          <span className={`rounded px-1.5 py-0.5 font-semibold ${persuadeeBadge}`}>
            {pair.persuadeeVote}
          </span>
        </span>
      </div>

      {/* Chat bubbles */}
      <div className="space-y-4">
        {/* Persuader bubble — right aligned */}
        <AnimatePresence>
          {state.started && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="flex flex-col items-end gap-1"
            >
              <span className="text-xs text-muted-foreground">{persuaderName} argues</span>
              <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary/10 border border-primary/20 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                {state.persuaderText || (
                  <span className="italic text-muted-foreground animate-pulse">thinking…</span>
                )}
                {!state.persuaderDone && state.persuaderText && (
                  <span className="inline-block w-1 h-3 bg-foreground animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Persuadee bubble — left aligned, appears after persuader done */}
        <AnimatePresence>
          {state.persuaderDone && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="flex flex-col items-start gap-1"
            >
              <span className="text-xs text-muted-foreground">{persuadeeName} responds</span>
              <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-card border border-border px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                {state.persuadeeText || (
                  <span className="italic text-muted-foreground animate-pulse">thinking…</span>
                )}
                {!state.persuadeeDone && state.persuadeeText && (
                  <span className="inline-block w-1 h-3 bg-foreground animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Verdict badge */}
        <AnimatePresence>
          {state.finalVote !== null && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="flex justify-center pt-2"
            >
              <div
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${
                  state.flipped
                    ? "bg-amber-50 border-amber-300 text-amber-800"
                    : "bg-muted border-border text-muted-foreground"
                }`}
              >
                <span>{state.flipped ? "↺ Flipped to" : "🔒 Held"}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${finalBadge}`}>
                  {state.finalVote}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
