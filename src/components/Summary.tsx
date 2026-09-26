import type { ArenaState } from "@/lib/arena";
import { modelName } from "@/lib/format";
import { Box } from "./ui";

export function Summary({ state }: { state: ArenaState }) {
  const { summary, phase } = state;
  if (!summary.model && !summary.text) return null;
  const writing = phase === "summarizing";
  return (
    <Box title="TL;DR" sub={summary.model ? `written by ${modelName(summary.model)}` : undefined}>
      <p className={writing ? "summary-text cursor" : "summary-text"}>{summary.text}</p>
    </Box>
  );
}
