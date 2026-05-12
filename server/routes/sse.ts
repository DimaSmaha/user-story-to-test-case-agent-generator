import { Router } from "express";
import { batches } from "../services/batchStore";

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
    res.write(`event: log\ndata: ${JSON.stringify({ block: "auth", text: line })}\n\n`);
  }
  res.write(`event: auth-status\ndata: ${JSON.stringify({ status: batch.authStatus })}\n\n`);

  for (const job of batch.jobs.values()) {
    res.write(
      `event: job-status\ndata: ${JSON.stringify({ storyId: job.storyId, status: job.status, startedAt: job.startedAt })}\n\n`,
    );
    for (const line of job.pipelineLogs) {
      res.write(
        `event: log\ndata: ${JSON.stringify({ block: "pipeline", storyId: job.storyId, text: line })}\n\n`,
      );
    }
  }

  if (batch.status !== "running") {
    res.write(`event: batch-done\ndata: ${JSON.stringify({ status: batch.status })}\n\n`);
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
