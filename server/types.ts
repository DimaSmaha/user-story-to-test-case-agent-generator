import type { Response } from "express";
import type { ChildProcess } from "child_process";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type BatchStatus = "running" | "completed" | "failed" | "cancelled";
export type AuthStatus = "running" | "completed" | "failed";

export interface Job {
  storyId: string;
  status: JobStatus;
  startedAt: number | null;
  endedAt: number | null;
  pipelineLogs: string[];
  process: ChildProcess | null;
}

export interface Batch {
  id: string;
  storyIds: string[];
  status: BatchStatus;
  startedAt: number;
  endedAt: number | null;
  authLogs: string[];
  authStatus: AuthStatus;
  authProcess: ChildProcess | null;
  jobs: Map<string, Job>;
  sseClients: Set<Response>;
}
