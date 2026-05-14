import express from "express";
import * as path from "path";
import { apiKeyAuth } from "./middleware/apiKey";
import { errorHandler } from "./middleware/errorHandler";
import configRoutes from "./routes/config";
import batchRoutes from "./routes/batches";
import sseRoutes from "./routes/sse";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  // Health check — no auth required (used by Docker and load balancers)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Static HTML pages — no auth required (browser navigation)
  app.use(express.static(path.join(__dirname, "public")));

  // API key auth applies to all /api/* routes (before any API route handlers)
  app.use("/api", apiKeyAuth);

  // Route handlers — all /api/* routes are now behind auth
  app.use(configRoutes);
  app.use(batchRoutes);
  app.use(sseRoutes);

  // Global error handler must be last
  app.use(errorHandler);

  return app;
}
