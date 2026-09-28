// src/lib/history-types.ts
export interface HistoryRun {
  id: string;
  question: string;
  choices: string[];
  timestamp: number;
  responses: Array<{
    modelId: string;
    vote: string | null;
    reasoning: string;
    optionReasons: Record<string, string>;
    rawText?: string;
    thinking?: string;
  }>;
}
