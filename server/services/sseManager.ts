import type { Batch } from "../types";

export function formatSSEMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sendSSE(batch: Batch, event: string, data: unknown): void {
  const msg = formatSSEMessage(event, data);
  for (const client of batch.sseClients) {
    try {
      client.write(msg);
    } catch {
      batch.sseClients.delete(client);
    }
  }
}
