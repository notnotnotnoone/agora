"use client";

import { useEffect, useState } from "react";
import type { FlexrouterSnapshot } from "@/lib/types";

/** flexrouter's live roster and spend, re-read every `everyMs` while the tab is visible. */
export function useFlexrouter(everyMs = 2500): FlexrouterSnapshot | null {
  const [snapshot, setSnapshot] = useState<FlexrouterSnapshot | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch("/api/flexrouter", { cache: "no-store" });
          if (!stopped && res.ok) setSnapshot(await res.json());
        } catch {
          // Agora's own server is down; keep showing the last snapshot
        }
      }
      if (!stopped) timer = setTimeout(tick, everyMs);
    };
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [everyMs]);

  return snapshot;
}

/** Re-renders every second, for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
