import { Router } from "express";
import { batches, serializeBatch, createBatch } from "../services/batchStore";
import { runBatch, cancelBatch, cancelJob } from "../services/batchRunner";

const router = Router();

router.post("/api/batches", (req, res) => {
  const { storyIds } = req.body as { storyIds?: string[] };
  if (!Array.isArray(storyIds) || storyIds.length === 0) {
    res.status(400).json({ error: "storyIds must be a non-empty array" });
    return;
  }

  const batch = createBatch(storyIds);
  batches.set(batch.id, batch);
  runBatch(batch);
  res.json({ id: batch.id, batch: serializeBatch(batch) });
});

router.get("/api/batches", (_req, res) => {
  res.json(Array.from(batches.values()).map(serializeBatch));
});

router.delete("/api/batches", (_req, res) => {
  for (const batch of batches.values()) {
    if (batch.status === "running") cancelBatch(batch);
  }
  res.json({ ok: true });
});

router.delete("/api/batches/:id", (req, res) => {
  const batch = batches.get(req.params["id"] ?? "");
  if (!batch) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  cancelBatch(batch);
  res.json({ ok: true });
});

router.delete("/api/batches/:batchId/jobs/:storyId", (req, res) => {
  const batch = batches.get(req.params["batchId"] ?? "");
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  const job = batch.jobs.get(req.params["storyId"] ?? "");
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  cancelJob(batch, job);
  res.json({ ok: true });
});

router.delete("/api/batches/:id/clear", (req, res) => {
  const batch = batches.get(req.params["id"] ?? "");
  if (!batch) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (batch.status === "running") {
    res.status(409).json({ error: "Cannot clear a running batch" });
    return;
  }
  batches.delete(batch.id);
  res.json({ ok: true });
});

export default router;
