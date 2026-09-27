"use client";

import { useEffect, useState } from "react";
import { tally } from "@/lib/arena";
import { deleteRun, listRuns, type SavedRun } from "@/lib/history";
import { Sheet, Tag } from "./ui";

export function HistorySheet({ onLoad, onClose }: { onLoad: (run: SavedRun) => void; onClose: () => void }) {
  const [runs, setRuns] = useState<SavedRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns()
      .then(setRuns)
      .catch(() => setError("This browser won't let Agora read its saved runs."));
  }, []);

  const remove = async (id: string) => {
    await deleteRun(id).catch(() => undefined);
    setRuns((prev) => prev?.filter((r) => r.id !== id) ?? null);
  };

  return (
    <Sheet title="History" sub="Finished runs, saved in this browser" onClose={onClose}>
      {error && <p className="error-note">{error}</p>}
      {runs && runs.length === 0 && (
        <div className="empty">
          <p>No runs yet. Finished runs are saved here automatically.</p>
        </div>
      )}
      {runs && runs.length > 0 && (
        <ul className="runs">
          {runs.map((run) => {
            const counts = [...tally(run.votes, run.choices)].sort((a, b) => b[1] - a[1]);
            const providers = new Set(run.votes.flatMap((v) => (v.model ? [v.model.split("/")[0]] : []))).size;
            return (
              <li key={run.id}>
                <button
                  className="run-open"
                  onClick={() => {
                    onLoad(run);
                    onClose();
                  }}
                >
                  <p className="run-q">{run.question}</p>
                  <span className="run-meta">
                    <span className="n">{new Date(run.at).toLocaleString()}</span>
                    {counts.map(([c, n]) => (
                      <Tag key={c}>
                        {c} {n}
                      </Tag>
                    ))}
                    <span className="n">{providers} providers</span>
                  </span>
                </button>
                <button className="btn ghost" onClick={() => remove(run.id)} aria-label="Delete run">
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
