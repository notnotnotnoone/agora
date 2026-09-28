import "server-only";

// Lets the viewer skip debate pairs while a debate streams. The debate runs
// inside one long SSE response, so a skip arrives as a separate request and
// finds the running debate here by its run id. Kept on globalThis so dev-mode
// module reloads don't split the registry.

export class PairSkips {
  private readonly controllers: AbortController[];

  constructor(pairs: number) {
    this.controllers = Array.from({ length: pairs }, () => new AbortController());
  }

  /** Aborts when the viewer skips this pair. */
  signal(pair: number): AbortSignal {
    return this.controllers[pair]?.signal ?? new AbortController().signal;
  }

  skip(pair: number | "all"): boolean {
    const targets = pair === "all" ? this.controllers : [this.controllers[pair]];
    if (targets.some((c) => !c)) return false;
    for (const c of targets) c.abort();
    return true;
  }
}

const registry: Map<string, PairSkips> = ((globalThis as { __agoraSkips?: Map<string, PairSkips> }).__agoraSkips ??=
  new Map());

export function openSkips(runId: string, pairs: number): PairSkips {
  const skips = new PairSkips(pairs);
  registry.set(runId, skips);
  return skips;
}

export function closeSkips(runId: string, skips: PairSkips) {
  if (registry.get(runId) === skips) registry.delete(runId);
}

/** Skips a pair (or every pair) of a running debate. False if there's no such debate or pair. */
export function skipPair(runId: string, pair: number | "all"): boolean {
  return registry.get(runId)?.skip(pair) ?? false;
}
