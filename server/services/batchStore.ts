import type { Batch } from "../types";

export const batches = new Map<string, Batch>();

export function serializeBatch(batch: Batch) {
  return {
    id: batch.id,
    storyIds: batch.storyIds,
    status: batch.status,
    startedAt: batch.startedAt,
    endedAt: batch.endedAt,
    authStatus: batch.authStatus,
    authLogs: batch.authLogs,
    jobs: Object.fromEntries(
      Array.from(batch.jobs.entries()).map(([k, v]) => [
        k,
        {
          storyId: v.storyId,
          status: v.status,
          startedAt: v.startedAt,
          endedAt: v.endedAt,
          pipelineLogs: v.pipelineLogs,
        },
      ]),
    ),
  };
}
