import { spawnLines, killProcess } from "./processManager";
import { sendSSE } from "./sseManager";
import type { Batch, Job, JobStatus } from "../types";

export function runBatch(batch: Batch): void {
  batch.authStatus = "running";
  sendSSE(batch, "auth-status", { status: "running" });

  batch.authProcess = spawnLines(
    ["tsx", "helpers/auth.ts"],
    (line) => {
      batch.authLogs.push(line);
      sendSSE(batch, "log", { block: "auth", text: line });
    },
    (code) => {
      batch.authProcess = null;
      if (batch.status === "cancelled") return;

      if (code !== 0) {
        batch.authStatus = "failed";
        sendSSE(batch, "auth-status", { status: "failed" });
        batch.status = "failed";
        batch.endedAt = Date.now();
        for (const job of batch.jobs.values()) {
          if (job.status === "pending") job.status = "cancelled" as JobStatus;
        }
        sendSSE(batch, "batch-done", { status: "failed" });
        return;
      }

      batch.authStatus = "completed";
      sendSSE(batch, "auth-status", { status: "completed" });

      const pending = Array.from(batch.jobs.values()).filter((j) => j.status === "pending");
      if (pending.length === 0) {
        finalizeBatch(batch);
        return;
      }

      let finished = 0;
      for (const job of pending) {
        startJob(batch, job, () => {
          finished++;
          if (finished === pending.length) finalizeBatch(batch);
        });
      }
    },
  );
}

export function startJob(batch: Batch, job: Job, onDone: () => void): void {
  if (job.status === "cancelled") {
    onDone();
    return;
  }

  job.status = "running";
  job.startedAt = Date.now();
  sendSSE(batch, "job-status", {
    storyId: job.storyId,
    status: "running",
    startedAt: job.startedAt,
  });

  job.process = spawnLines(
    ["tsx", "scripts/run-pipeline.ts", job.storyId],
    (line) => {
      job.pipelineLogs.push(line);
      sendSSE(batch, "log", { block: "pipeline", storyId: job.storyId, text: line });
    },
    (code) => {
      job.process = null;
      job.endedAt = Date.now();
      if (job.status !== "cancelled") {
        job.status = code === 0 ? "completed" : "failed";
        sendSSE(batch, "job-status", { storyId: job.storyId, status: job.status });
      }
      onDone();
    },
  );
}

export function finalizeBatch(batch: Batch): void {
  if (batch.status !== "running") return;
  const jobs = Array.from(batch.jobs.values());
  const anyFailed = jobs.some((j) => j.status === "failed");
  const anyCancelled = jobs.some((j) => j.status === "cancelled");
  batch.status = anyCancelled ? "cancelled" : anyFailed ? "failed" : "completed";
  batch.endedAt = Date.now();
  sendSSE(batch, "batch-done", { status: batch.status });
}

export function cancelBatch(batch: Batch): void {
  if (batch.status !== "running") return;
  batch.status = "cancelled";
  batch.endedAt = Date.now();

  if (batch.authProcess) {
    killProcess(batch.authProcess);
    batch.authProcess = null;
  }

  for (const job of batch.jobs.values()) {
    if (job.status === "running" || job.status === "pending") {
      job.status = "cancelled";
      job.endedAt = Date.now();
      if (job.process) {
        killProcess(job.process);
        job.process = null;
      }
    }
  }

  sendSSE(batch, "batch-done", { status: "cancelled" });
}

export function cancelJob(batch: Batch, job: Job): void {
  if (job.status !== "running" && job.status !== "pending") return;
  job.status = "cancelled";
  job.endedAt = Date.now();
  if (job.process) {
    killProcess(job.process);
    job.process = null;
  }
  sendSSE(batch, "job-status", { storyId: job.storyId, status: "cancelled" });

  const allDone = Array.from(batch.jobs.values()).every(
    (j) => j.status !== "pending" && j.status !== "running",
  );
  if (allDone) finalizeBatch(batch);
}
