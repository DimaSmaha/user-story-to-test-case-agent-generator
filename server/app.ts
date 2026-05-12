import express from "express";
import * as path from "path";
import configRoutes from "./routes/config";
import batchRoutes from "./routes/batches";
import sseRoutes from "./routes/sse";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  app.use(configRoutes);
  app.use(batchRoutes);
  app.use(sseRoutes);
  return app;
}
