import { createApp } from "./app";
import { logger } from "./logger";
import { batches } from "./services/batchStore";
import { cancelBatch } from "./services/batchRunner";
import type { AppConfig } from "./config/base";

export function startServer(config: AppConfig): void {
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info("Server started", { port: config.port, env: config.nodeEnv });
  });

  function shutdown(signal: string): void {
    logger.info(`${signal} received, shutting down`);
    for (const batch of batches.values()) {
      if (batch.status === "running") cancelBatch(batch);
    }
    server.close(() => {
      logger.info("Server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Shutdown timeout — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason: String(reason) });
    process.exit(1);
  });
}
