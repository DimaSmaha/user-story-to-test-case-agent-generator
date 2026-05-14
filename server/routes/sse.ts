import { Router } from "express";
import { batches } from "../services/batchStore";
import { formatSSEMessage } from "../services/sseManager";

const router = Router();

router.get("/api/batches/:id/stream", (req, res) => {
  const batch = batches.get(req.params["id"] ?? "");
  if (!batch) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay existing state for late-joining clients
  for (const line of batch.authLogs) {
    res.write(formatSSEMessage("log", { block: "auth", text: line }));
  }
  res.write(formatSSEMessage("auth-status", { status: batch.authStatus }));

  for (const job of batch.jobs.values()) {
    res.write(formatSSEMessage("job-status", { storyId: job.storyId, status: job.status, startedAt: job.startedAt }));
    for (const line of job.pipelineLogs) {
      res.write(formatSSEMessage("log", { block: "pipeline", storyId: job.storyId, text: line }));
    }
  }

  if (batch.status !== "running") {
    res.write(formatSSEMessage("batch-done", { status: batch.status }));
    res.end();
    return;
  }

  batch.sseClients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    batch.sseClients.delete(res);
  });
});

export default router;
