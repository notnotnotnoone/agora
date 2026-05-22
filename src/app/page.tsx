"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DilemmaInput } from "@/components/ui/dilemma-input";
import { ConsensusBar } from "@/components/ui/consensus-bar";
import { ModelResponseList } from "@/components/ui/model-response-list";
import { TldrPanel } from "@/components/ui/tldr-panel";
import { Round2View } from "@/components/ui/round2-view";
import { DILEMMAS, shuffleDilemma } from "@/lib/questions";
import type { ModelConfigPublic, ResponseEntry, RunEvent, DebatePair } from "@/lib/types";

function buildDebatePairs(responses: ResponseEntry[]): DebatePair[] {
  const byVote = new Map<string, ResponseEntry[]>();
  for (const r of responses) {
    if (!r.vote) continue;
    const arr = byVote.get(r.vote) ?? [];
    arr.push(r);
    byVote.set(r.vote, arr);
  }
  if (byVote.size < 2) return [];

  let majorityVote = "";
  let majorityCount = 0;
  for (const [vote, entries] of byVote) {
    if (entries.length > majorityCount) {
      majorityCount = entries.length;
      majorityVote = vote;
    }
  }

  const majority = byVote.get(majorityVote) ?? [];
  const pairs: DebatePair[] = [];

  for (const [vote, entries] of byVote) {
    if (vote === majorityVote) continue;
    for (const persuadee of entries) {
      const persuader = majority[Math.floor(Math.random() * majority.length)];
      pairs.push({
        persuaderId: persuader.modelId,
        persuaderVote: persuader.vote!,
        persuaderReasoning: persuader.reasoning,
        persuadeeId: persuadee.modelId,
        persuadeeVote: persuadee.vote!,
        persuadeeReasoning: persuadee.reasoning,
      });
    }
  }

  return pairs;
}

export default function Home() {
  const [question, setQuestion] = useState(DILEMMAS[0]);
  const [models, setModels] = useState<ModelConfigPublic[]>([]);
  const [responses, setResponses] = useState<ResponseEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [choices, setChoices] = useState<string[]>([]);
  const [targetCount, setTargetCount] = useState(20);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const [tldrVisible, setTldrVisible] = useState(false);
  const [tldrText, setTldrText] = useState("");
  const [tldrLoading, setTldrLoading] = useState(false);
  const [tldrSynthesizer, setTldrSynthesizer] = useState("");

  const [round2Enabled, setRound2Enabled] = useState(true);
  const [round2Active, setRound2Active] = useState(false);
  const [debatePairs, setDebatePairs] = useState<DebatePair[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: ModelConfigPublic[]) => setModels(data))
      .catch(console.error);
  }, []);

  const triggerTldr = async (
    q: string,
    collected: ResponseEntry[],
    extractedChoices: string[],
    signal: AbortSignal
  ) => {
    setTldrVisible(true);
    setTldrLoading(true);

    try {
      const res = await fetch("/api/tldr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, responses: collected, choices: extractedChoices }),
        signal,
      });

      if (!res.ok || !res.body) {
        setTldrLoading(false);
        return;
      }

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
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === "meta") {
              setTldrSynthesizer(parsed.synthesizer);
            } else if (parsed.type === "token") {
              setTldrText((prev) => prev + parsed.token);
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") console.error(err);
    } finally {
      setTldrLoading(false);
    }
  };

  const handleRun = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setRunning(true);
    setResponses([]);
    setChoices([]);
    setExtractError(null);
    setTldrVisible(false);
    setTldrText("");
    setTldrSynthesizer("");
    setRound2Active(false);
    setDebatePairs([]);

    // Phase 1: extract choices
    setExtracting(true);
    let extractedChoices: string[];
    try {
      const extractRes = await fetch("/api/extract-choices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: ctrl.signal,
      });
      const extractData = await extractRes.json() as { choices?: string[]; error?: string };
      if (!extractRes.ok || !extractData.choices) {
        setExtractError(extractData.error ?? "Failed to extract choices");
        setExtracting(false);
        setRunning(false);
        return;
      }
      extractedChoices = extractData.choices;
      setChoices(extractedChoices);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setExtractError("Failed to connect to server");
      }
      setExtracting(false);
      setRunning(false);
      return;
    } finally {
      setExtracting(false);
    }

    // Phase 2: polling
    const collectedResponses: ResponseEntry[] = [];

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, choices: extractedChoices, targetCount }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        console.error("Run failed:", res.status);
        setRunning(false);
        return;
      }

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

          let event: RunEvent;
          try {
            event = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (event.type === "response_start") {
            const newEntry: ResponseEntry = {
              modelId: event.modelId,
              requestIndex: event.requestIndex,
              status: "pending",
              reasoning: "",
              vote: null,
              rawText: "",
            };
            setResponses((prev) => [...prev, newEntry]);
          } else if (event.type === "response_done") {
            setResponses((prev) =>
              prev.map((r) =>
                r.modelId === event.modelId && r.requestIndex === event.requestIndex
                  ? { ...r, status: "done", vote: event.vote, reasoning: event.reasoning }
                  : r
              )
            );
            const updated: ResponseEntry = {
              modelId: event.modelId,
              requestIndex: event.requestIndex,
              status: "done",
              vote: event.vote,
              reasoning: event.reasoning,
              rawText: "",
            };
            collectedResponses.push(updated);
          } else if (event.type === "all_done") {
            setRunning(false);
            triggerTldr(question, collectedResponses, extractedChoices, ctrl.signal);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error(err);
      }
      setRunning(false);
    }
  }, [models, question, targetCount]);

  const handleStartRound2 = useCallback(() => {
    const pairs = buildDebatePairs(responses);
    setDebatePairs(pairs);
    setRound2Active(true);
  }, [responses]);

  // Derive counts for consensus bar
  const voteCounts = new Map<string, number>();
  let pendingCount = 0;
  for (const r of responses) {
    if (r.vote !== null) {
      voteCounts.set(r.vote, (voteCounts.get(r.vote) ?? 0) + 1);
    } else {
      pendingCount++;
    }
  }
  const collectedCount = responses.filter((r) => r.vote !== null).length;
  const isUnanimous = collectedCount > 0 && voteCounts.size <= 1;
  const showRound2Button = round2Enabled && !running && collectedCount > 0 && !round2Active;

  // Group responses by modelId for the list
  const responsesByModel = new Map<string, ResponseEntry[]>();
  for (const r of responses) {
    const entries = responsesByModel.get(r.modelId) ?? [];
    entries.push(r);
    responsesByModel.set(r.modelId, entries);
  }

  const hasResponses = responses.length > 0;
  const showConsensusArea = extracting || extractError !== null || hasResponses;

  return (
    <AnimatePresence mode="wait">
      {round2Active ? (
        <Round2View
          key="round2"
          question={question}
          choices={choices}
          pairs={debatePairs}
          models={models}
          onBack={() => setRound2Active(false)}
        />
      ) : (
        <motion.main
          key="round1"
          className="min-h-screen bg-background text-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
            {/* Header */}
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">Agora</h1>
              <p className="text-sm text-muted-foreground">
                Ethical dilemma arena — see how every AI votes
              </p>
            </div>

            {/* Dilemma input */}
            <div className="bg-card border border-border rounded-lg p-4 shadow-sm">
              <DilemmaInput
                question={question}
                running={running}
                targetCount={targetCount}
                round2Enabled={round2Enabled}
                onQuestionChange={setQuestion}
                onTargetCountChange={setTargetCount}
                onShuffle={() => setQuestion(shuffleDilemma(question))}
                onRun={handleRun}
                onRound2Toggle={setRound2Enabled}
              />
            </div>

            {/* Consensus bar / extraction state */}
            {showConsensusArea && (
              <div className="bg-card border border-border rounded-lg p-4 shadow-sm">
                {extracting && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                    <span className="h-2 w-2 rounded-full bg-muted-foreground animate-ping inline-block" />
                    Identifying choices…
                  </div>
                )}
                {extractError && !extracting && (
                  <p className="text-sm text-red-600">{extractError}</p>
                )}
                {!extracting && !extractError && hasResponses && (
                  <ConsensusBar
                    choices={choices}
                    voteCounts={voteCounts}
                    pendingCount={pendingCount}
                    targetCount={targetCount}
                    collectedCount={collectedCount}
                  />
                )}
              </div>
            )}

            {/* Model responses */}
            {hasResponses && (
              <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden">
                <div className="p-4">
                  <ModelResponseList
                    models={models}
                    responses={responsesByModel}
                    choices={choices}
                  />
                </div>
              </div>
            )}

            {/* TLDR */}
            <TldrPanel
              visible={tldrVisible}
              synthesizer={tldrSynthesizer}
              text={tldrText}
              loading={tldrLoading}
            />

            {/* Start Round 2 button */}
            {showRound2Button && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={handleStartRound2}
                  disabled={isUnanimous}
                  title={isUnanimous ? "No minority votes to debate" : undefined}
                  className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold shadow hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Start Round 2 →
                </button>
              </div>
            )}
          </div>
        </motion.main>
      )}
    </AnimatePresence>
  );
}
