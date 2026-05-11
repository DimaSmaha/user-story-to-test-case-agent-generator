import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

export interface EnvVars {
  ISSUE_TRACKER: string;
  FAKE_TRACKER_URL: string;
}

export function getEnvVars(): EnvVars {
  const ISSUE_TRACKER = process.env["ISSUE_TRACKER"];
  const FAKE_TRACKER_URL = process.env["FAKE_TRACKER_URL"];
  if (!ISSUE_TRACKER) throw new Error("ISSUE_TRACKER is not set in .env or environment");
  if (!FAKE_TRACKER_URL) throw new Error("FAKE_TRACKER_URL is not set in .env or environment");
  return { ISSUE_TRACKER, FAKE_TRACKER_URL };
}
