"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleDotDashed,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ModelConfigPublic, ResponseEntry } from "@/lib/types";
import { BADGE_COLORS, choiceIndex } from "@/lib/choice-colors";

interface ModelResponseCardProps {
  model: ModelConfigPublic;
  responses: ResponseEntry[];
  choices: string[];
}

const PROVIDER_COLORS: Record<string, string> = {
  Openrouter: "bg-purple-100 text-purple-700",
  Cerebras: "bg-blue-100 text-blue-700",
  Groq: "bg-orange-100 text-orange-700",
};

function getProviderColor(provider: string) {
  return PROVIDER_COLORS[provider] ?? "bg-muted text-muted-foreground";
}

function getOverallStatus(responses: ResponseEntry[]): ResponseEntry["status"] {
  if (responses.every((r) => r.status === "pending")) return "pending";
  if (responses.every((r) => r.status === "done" || r.status === "failed")) {
    return responses.some((r) => r.status === "failed") ? "failed" : "done";
  }
  return "streaming";
}

function StatusIcon({ status }: { status: ResponseEntry["status"] }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />;
  if (status === "streaming") return <CircleDotDashed className="h-4 w-4 text-blue-500 flex-shrink-0 animate-spin" />;
  return <Circle className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
}

function ResponseRow({
  response,
  choices,
}: {
  response: ResponseEntry;
  choices: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const badgeColor =
    response.vote
      ? BADGE_COLORS[choiceIndex(response.vote, choices)]
      : "bg-muted text-muted-foreground";

  const hasOptionReasons =
    response.status === "done" &&
    response.optionReasons &&
    Object.keys(response.optionReasons).length > 0;

  return (
    <motion.li
      className="flex flex-col py-0.5 pl-6"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 25 }}
    >
      <motion.div
        className="flex flex-1 items-center rounded-md p-1 cursor-pointer"
        onClick={() => hasOptionReasons && setExpanded((p) => !p)}
        whileHover={{ backgroundColor: "rgba(0,0,0,0.03)" }}
      >
        <div className="mr-2">
          <AnimatePresence mode="wait">
            <motion.div
              key={response.status + String(response.vote)}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              <StatusIcon status={response.status} />
            </motion.div>
          </AnimatePresence>
        </div>
        <span className="text-sm flex-1">
          <span className="text-muted-foreground mr-1.5">[{response.requestIndex + 1}]</span>
          {response.status === "pending" && (
            <span className="text-muted-foreground italic">waiting…</span>
          )}
          {response.status === "streaming" && (
            <span className="text-blue-600 italic text-xs">streaming…</span>
          )}
          {response.status === "done" && response.vote && (
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${badgeColor}`}>
              {response.vote}
            </span>
          )}
          {response.status === "done" && !response.vote && (
            <span className="text-yellow-700">no answer</span>
          )}
        </span>
        {hasOptionReasons && (
          <span className="text-xs text-muted-foreground ml-1">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </motion.div>

      <AnimatePresence>
        {hasOptionReasons && expanded && (
          <motion.div
            className="mt-1 ml-1.5 border-l border-dashed border-foreground/20 pl-5 overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ul className="py-1 space-y-2">
              {choices.map((choice) => {
                const isChosen = choice === response.vote;
                const reason = response.optionReasons[choice] ?? "";
                const idx = choiceIndex(choice, choices);
                const chipColor = BADGE_COLORS[idx] ?? "bg-muted text-muted-foreground";
                return (
                  <li key={choice} className="flex flex-col gap-0.5">
                    <span
                      className={`self-start rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        isChosen ? chipColor : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {isChosen ? `✓ ${choice}` : `✗ ${choice}`}
                    </span>
                    <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                      {reason || <span className="italic">No reason provided.</span>}
                    </p>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function ModelResponseCard({ model, responses, choices }: ModelResponseCardProps) {
  const [expanded, setExpanded] = useState(true);
  const overallStatus = getOverallStatus(responses);

  const voteSummary = responses
    .filter((r) => r.vote !== null)
    .reduce<Record<string, number>>((acc, r) => {
      const v = r.vote!;
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});

  return (
    <motion.li
      className="pt-2"
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
    >
      <motion.div
        className="group flex items-center px-3 py-1.5 rounded-md cursor-pointer"
        whileHover={{ backgroundColor: "rgba(0,0,0,0.03)" }}
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="mr-2 flex-shrink-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={overallStatus}
              initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
              transition={{ duration: 0.2 }}
            >
              <StatusIcon status={overallStatus} />
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex min-w-0 flex-grow items-center justify-between">
          <div className="mr-2 flex-1 min-w-0">
            <span className="text-sm font-medium truncate">{model.modelName}</span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2 text-xs">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getProviderColor(model.provider)}`}
            >
              {model.provider}
            </span>
            <span className="text-muted-foreground">int:{model.intelligence}</span>
            {Object.entries(voteSummary).map(([v, count]) => {
              const idx = choiceIndex(v, choices);
              return (
                <span key={v} className={`text-[11px] ${BADGE_COLORS[idx]?.split(" ")[1] ?? "text-muted-foreground"}`}>
                  {count}×{v}
                </span>
              );
            })}
            <span className="text-muted-foreground">{expanded ? "▲" : "▼"}</span>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="relative overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] }}
          >
            <div className="absolute top-0 bottom-0 left-[20px] border-l-2 border-dashed border-muted-foreground/30" />
            <ul className="mt-1 mr-2 mb-1.5 ml-3 space-y-0.5">
              {responses.map((r) => (
                <ResponseRow key={r.requestIndex} response={r} choices={choices} />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
