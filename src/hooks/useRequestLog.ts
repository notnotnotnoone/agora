"use client";

import { useEffect, useState } from "react";
import type { RequestRow } from "@/lib/types";

export interface RequestLog {
  rows: RequestRow[];
  error: string | null;
}

const EMPTY: RequestLog = { rows: [], error: null };

/**
 * One run's rows from flexrouter's request log, newest first. Re-read every
 * `everyMs` while `active`, and once more when it stops, since flexrouter
 * logs a request only once it has finished.
 */
export function useRequestLog(runId: string | null, active: boolean, everyMs = 2000): RequestLog {
  const [log, setLog] = useState<{ runId: string | null } & RequestLog>({ runId: null, ...EMPTY });

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      try {
        const res = await fetch(`/api/requests?run=${encodeURIComponent(runId)}&limit=1000`, { cache: "no-store" });
        const body = await res.json();
        if (stopped) return;
        setLog(res.ok ? { runId, rows: body.requests, error: null } : (prev) => ({ ...prev, runId, error: body.error }));
      } catch {
        if (!stopped) setLog((prev) => ({ ...prev, runId, error: "Agora's server isn't answering" }));
      }
      if (active && !stopped) timer = setTimeout(read, everyMs);
    };
    read();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, active, everyMs]);

  // Rows from a previous run are never shown for this one.
  return log.runId === runId ? { rows: log.rows, error: log.error } : EMPTY;
}
