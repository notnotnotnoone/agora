/**
 * Epoch ms from one of flexrouter's trace times. flexrouter writes them as
 * "2026-09-26T10:00:00.000+00:00Z", an offset and a Z, which Date.parse
 * rejects; drop the Z when an offset is already there.
 */
export function parseAt(at: string): number {
  return Date.parse(/[+-]\d\d:\d\dZ$/.test(at) ? at.slice(0, -1) : at);
}

export function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour12: false });
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function ms(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${num(n)} ms`;
}

export function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/** "3m 04s" / "42s" until an epoch-seconds deadline; "" once it has passed. */
export function countdown(untilSec: number | null, nowMs: number): string {
  if (untilSec == null) return "";
  const left = Math.ceil(untilSec - nowMs / 1000);
  if (left <= 0) return "";
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** The model half of a "provider/model" id. */
export function modelName(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

export function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}
