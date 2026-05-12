import * as path from "path";
import * as dotenv from "dotenv";
import { createApp } from "./app";
import { batches } from "./services/batchStore";
import { cancelBatch } from "./services/batchRunner";
import { getEnvVars } from "../helpers/getEnvVars";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

try {
  getEnvVars();
} catch (err: unknown) {
  console.error(`[ERROR] ${(err as Error).message}`);
  process.exit(1);
}

const PORT = process.env["SERVER_PORT"] ?? 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  for (const batch of batches.values()) {
    if (batch.status === "running") cancelBatch(batch);
  }
  process.exit(0);
});
