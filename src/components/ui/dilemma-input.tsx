"use client";

import { Shuffle, Play, Loader2 } from "lucide-react";
import { Button } from "./button";
import { Textarea } from "./textarea";

interface DilemmaInputProps {
  question: string;
  running: boolean;
  targetCount: number;
  round2Enabled: boolean;
  onQuestionChange: (q: string) => void;
  onTargetCountChange: (n: number) => void;
  onShuffle: () => void;
  onRun: () => void;
  onRound2Toggle: (enabled: boolean) => void;
}

export function DilemmaInput({
  question,
  running,
  targetCount,
  round2Enabled,
  onQuestionChange,
  onTargetCountChange,
  onShuffle,
  onRun,
  onRound2Toggle,
}: DilemmaInputProps) {
  const targetValid = targetCount >= 1 && targetCount <= 200;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Textarea
          className="flex-1 min-h-[100px] resize-none text-sm"
          placeholder="Enter an ethical dilemma…"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          disabled={running}
        />
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={onShuffle}
            disabled={running}
            title="Shuffle dilemma"
          >
            <Shuffle className="h-4 w-4" />
          </Button>
          <Button
            onClick={onRun}
            disabled={running || !question.trim() || !targetValid}
            className="gap-2"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {running ? "Running…" : "Run"}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground whitespace-nowrap">
            Target answers
          </label>
          <input
            type="number"
            min={1}
            max={200}
            value={targetCount}
            onChange={(e) => onTargetCountChange(Number(e.target.value))}
            disabled={running}
            className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground whitespace-nowrap">Round 2</label>
          <button
            role="switch"
            aria-checked={round2Enabled}
            onClick={() => onRound2Toggle(!round2Enabled)}
            disabled={running}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
              round2Enabled ? "bg-primary" : "bg-muted-foreground/30"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                round2Enabled ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
