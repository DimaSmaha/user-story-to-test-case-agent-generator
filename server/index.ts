import express from "express";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
const PORT = process.env["SERVER_PORT"] ?? 4000;
const PROJECT_ROOT = path.resolve(__dirname, "..");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type BatchStatus = "running" | "completed" | "failed" | "cancelled";
type AuthStatus = "running" | "completed" | "failed";

interface Job {
  storyId: string;
  status: JobStatus;
  startedAt: number | null;
  endedAt: number | null;
  pipelineLogs: string[];
  process: ChildProcess | null;
}

interface Batch {
  id: string;
  storyIds: string[];
  status: BatchStatus;
  startedAt: number;
  endedAt: number | null;
  authLogs: string[];
  authStatus: AuthStatus;
  authProcess: ChildProcess | null;
  jobs: Map<string, Job>;
  sseClients: Set<express.Response>;
}

// ─── State ────────────────────────────────────────────────────────────────────

const batches = new Map<string, Batch>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;]*[mGKHFJABCDST]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");

function sendSSE(batch: Batch, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of batch.sseClients) {
    try {
      client.write(msg);
    } catch {
      batch.sseClients.delete(client);
    }
  }
}

function killProcess(proc: ChildProcess): void {
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { shell: true });
  } else {
    proc.kill("SIGTERM");
  }
}

function spawnLines(
  args: string[],
  onLine: (line: string) => void,
  onClose: (code: number | null) => void,
): ChildProcess {
  const proc = spawn("npx", args, {
    cwd: PROJECT_ROOT,
    shell: true,
    env: process.env,
  });

  let buf = "";
  const handle = (data: Buffer) => {
    buf += data.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const clean = stripAnsi(line);
      if (clean.trim()) onLine(clean);
    }
  };

  proc.stdout?.on("data", handle);
  proc.stderr?.on("data", handle);
  proc.on("close", (code) => {
    if (buf.trim()) onLine(stripAnsi(buf));
    buf = "";
    onClose(code);
  });

  return proc;
}

// ─── Batch execution ──────────────────────────────────────────────────────────

function runBatch(batch: Batch): void {
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
          if (job.status === "pending") job.status = "cancelled";
        }
        sendSSE(batch, "batch-done", { status: "failed" });
        return;
      }

      batch.authStatus = "completed";
      sendSSE(batch, "auth-status", { status: "completed" });

      const pending = Array.from(batch.jobs.values()).filter(
        (j) => j.status === "pending",
      );
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

function startJob(batch: Batch, job: Job, onDone: () => void): void {
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
        sendSSE(batch, "job-status", {
          storyId: job.storyId,
          status: job.status,
        });
      }
      onDone();
    },
  );
}

function finalizeBatch(batch: Batch): void {
  if (batch.status !== "running") return;
  const jobs = Array.from(batch.jobs.values());
  const anyFailed = jobs.some((j) => j.status === "failed");
  const anyCancelled = jobs.some((j) => j.status === "cancelled");
  batch.status = anyCancelled ? "cancelled" : anyFailed ? "failed" : "completed";
  batch.endedAt = Date.now();
  sendSSE(batch, "batch-done", { status: batch.status });
}

function cancelBatch(batch: Batch): void {
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

function cancelJob(batch: Batch, job: Job): void {
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

// ─── Serialization ────────────────────────────────────────────────────────────

function serializeBatch(batch: Batch) {
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

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/generate", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "generate.html")),
);

app.get("/api/config", (_req, res) => {
  res.json({
    issueTracker: process.env["ISSUE_TRACKER"] ?? "fake",
    trackerUrl: process.env["FAKE_TRACKER_URL"] ?? "http://localhost:3000",
  });
});

app.post("/api/batches", (req, res) => {
  const { storyIds } = req.body as { storyIds?: string[] };
  if (!Array.isArray(storyIds) || storyIds.length === 0) {
    res.status(400).json({ error: "storyIds must be a non-empty array" });
    return;
  }

  const batch: Batch = {
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
        },
      ]),
    ),
    sseClients: new Set(),
  };

  batches.set(batch.id, batch);
  runBatch(batch);
  res.json({ id: batch.id, batch: serializeBatch(batch) });
});

app.get("/api/batches", (_req, res) => {
  res.json(Array.from(batches.values()).map(serializeBatch));
});

app.get("/api/batches/:id/stream", (req, res) => {
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

  // Replay existing state
  for (const line of batch.authLogs) {
    res.write(
      `event: log\ndata: ${JSON.stringify({ block: "auth", text: line })}\n\n`,
    );
  }
  res.write(
    `event: auth-status\ndata: ${JSON.stringify({ status: batch.authStatus })}\n\n`,
  );

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
    res.write(
      `event: batch-done\ndata: ${JSON.stringify({ status: batch.status })}\n\n`,
    );
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

app.delete("/api/batches", (_req, res) => {
  for (const batch of batches.values()) {
    if (batch.status === "running") cancelBatch(batch);
  }
  res.json({ ok: true });
});

app.delete("/api/batches/:id", (req, res) => {
  const batch = batches.get(req.params["id"] ?? "");
  if (!batch) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  cancelBatch(batch);
  res.json({ ok: true });
});

app.delete("/api/batches/:batchId/jobs/:storyId", (req, res) => {
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  for (const batch of batches.values()) {
    if (batch.status === "running") cancelBatch(batch);
  }
  process.exit(0);
});
