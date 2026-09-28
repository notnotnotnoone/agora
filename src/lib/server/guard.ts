import type { ChatFn } from "./flexrouter";

// flexrouter keeps trying a bucket for about 30s before it gives up, and a
// model can go quiet halfway through an answer. For a live demo both look
// like a hang, so Agora puts its own clock on every call: a call that makes
// no visible progress for too long is stopped, and the caller asks again.

export interface Liveness {
  /** From sending the request until flexrouter names the model answering. */
  routeMs: number;
  /** From the model being named until its first token (reply or reasoning). */
  firstTokenMs: number;
  /** Longest silence allowed once tokens are flowing. */
  idleMs: number;
}

export const DEFAULT_LIVENESS: Liveness = { routeMs: 8_000, firstTokenMs: 8_000, idleMs: 6_000 };

export type StallStage = "route" | "first_token" | "idle";

/** A call stopped for making no progress. */
export class StallError extends Error {
  constructor(
    readonly stage: StallStage,
    /** The model that went quiet; null if flexrouter hadn't named one yet. */
    readonly model: string | null,
    readonly requestId: string | null,
    /** Whatever the model had written before it went quiet. */
    readonly partial: string
  ) {
    super(
      stage === "route"
        ? "flexrouter took too long to find a free model"
        : stage === "first_token"
          ? "Model accepted the request but never started answering"
          : "Model stalled mid-answer"
    );
    this.name = "StallError";
  }
}

/** `chat`, with each call stopped (as a StallError) when it stops making progress. */
export function guarded(chat: ChatFn, limits: Liveness = DEFAULT_LIVENESS): ChatFn {
  return async (req) => {
    const ctrl = new AbortController();
    const outer = req.signal;
    const onOuterAbort = () => ctrl.abort();
    if (outer?.aborted) ctrl.abort();
    else outer?.addEventListener("abort", onOuterAbort, { once: true });

    let stage: StallStage = "route";
    let stalled: StallStage | null = null;
    let model: string | null = null;
    let requestId: string | null = null;
    let partial = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (next: StallStage, ms: number) => {
      stage = next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = stage;
        ctrl.abort();
      }, ms);
    };

    arm("route", limits.routeMs);
    try {
      return await chat({
        ...req,
        signal: ctrl.signal,
        onRequest: (id) => {
          requestId = id;
          req.onRequest?.(id);
        },
        onModel: (m) => {
          model = m;
          arm("first_token", limits.firstTokenMs);
          req.onModel?.(m);
        },
        onReasoning: (t) => {
          arm("idle", limits.idleMs);
          req.onReasoning?.(t);
        },
        onToken: (t) => {
          partial += t;
          arm("idle", limits.idleMs);
          req.onToken?.(t);
        },
      });
    } catch (err) {
      if (stalled && !outer?.aborted) throw new StallError(stalled, model, requestId, partial);
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}
