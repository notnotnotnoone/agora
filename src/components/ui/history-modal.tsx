// src/components/ui/history-modal.tsx
"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getAllRuns } from "@/lib/history-db";
import type { HistoryRun } from "@/lib/history-types";

interface HistoryModalProps {
  open: boolean;
  onClose: () => void;
  onLoadRun: (run: HistoryRun) => void;
}

export function HistoryModal({
  open,
  onClose,
  onLoadRun,
}: HistoryModalProps) {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    getAllRuns()
      .then(setRuns)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [open]);

  const handleLoadRun = (run: HistoryRun) => {
    onLoadRun(run);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 bg-black/50 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            key="modal"
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-card border border-border rounded-lg shadow-lg max-w-md w-full max-h-[70vh] flex flex-col">
              {/* Header */}
              <div className="p-4 border-b border-border">
                <h2 className="text-lg font-semibold">History</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Click to revisit a past dilemma
                </p>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : runs.length === 0 ? (
                  <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                    No history yet
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => handleLoadRun(run)}
                        className="w-full text-left p-3 hover:bg-muted transition-colors"
                      >
                        <div className="text-sm font-medium line-clamp-2">
                          {run.question}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(run.timestamp).toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-4 border-t border-border">
                <button
                  onClick={onClose}
                  className="w-full px-3 py-2 rounded-md bg-muted text-sm font-medium hover:bg-muted/80 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
