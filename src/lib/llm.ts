export function encodeSSE(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
