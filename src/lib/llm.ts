import type { ModelConfig } from "./types";

export function buildHeaders(model: ModelConfig): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.apiKey}`,
  };
  if (model.headerParser === "openrouter") {
    base["HTTP-Referer"] = "http://localhost:9563";
    base["X-Title"] = "Agora";
  }
  return base;
}

export function encodeSSE(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
