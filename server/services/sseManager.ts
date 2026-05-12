import type { Batch } from "../types";

export function sendSSE(batch: Batch, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of batch.sseClients) {
    try {
      client.write(msg);
    } catch {
      batch.sseClients.delete(client);
    }
  }
}
