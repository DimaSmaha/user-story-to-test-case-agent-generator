import * as crypto from "crypto";
import type { Batch, Job, JobStatus } from "../types";

export const batches = new Map<string, Batch>();

export function createBatch(storyIds: string[]): Batch {
  return {
    id: crypto.randomUUID(),
    storyIds,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    authLogs: [],
    authStatus: "running",
    authProcess: null,
    jobs: new Map(
      storyIds.map((id) => [
        id,
        {
          storyId: id,
          status: "pending" as JobStatus,
          startedAt: null,
          endedAt: null,
          pipelineLogs: [],
          process: null,
          timeoutHandle: null,
        } satisfies Job,
      ]),
    ),
    sseClients: new Set(),
    timeoutHandle: null,
  };
}

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
