import "server-only";

import { encodeEvent } from "../sse";

/**
 * An SSE response driven by `run`. Events go out as they're emitted; the
 * stream ends with {type:"done"}, or {type:"error"} if `run` throws. When the
 * browser disconnects, `signal` aborts so every in-flight model call stops.
 */
export function eventStream<E extends { type: string }>(
  request: Request,
  run: (emit: (event: E) => void, signal: AbortSignal) => Promise<void>
): Response {
  const encoder = new TextEncoder();
  const signal = request.signal;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: unknown) => {
        if (!open || signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false;
        }
      };
      try {
        await run(send, signal);
        send({ type: "done" });
      } catch (err) {
        if (!signal.aborted) send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by a disconnect
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
