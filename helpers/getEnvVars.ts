import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

export interface EnvVars {
  ISSUE_TRACKER: string;
  FAKE_TRACKER_URL: string;
  APP_URL: string | undefined;
  APP_USERNAME: string | undefined;
  APP_PASSWORD: string | undefined;
}

export function getEnvVars(): EnvVars {
  const ISSUE_TRACKER = process.env["ISSUE_TRACKER"];
  const FAKE_TRACKER_URL = process.env["FAKE_TRACKER_URL"];
  const APP_URL = process.env["APP_URL"];
  const APP_USERNAME = process.env["APP_USERNAME"];
  const APP_PASSWORD = process.env["APP_PASSWORD"];
  if (!ISSUE_TRACKER)
    throw new Error("ISSUE_TRACKER is not set in .env or environment");
  if (!FAKE_TRACKER_URL)
    throw new Error("FAKE_TRACKER_URL is not set in .env or environment");
  return { ISSUE_TRACKER, FAKE_TRACKER_URL, APP_URL, APP_USERNAME, APP_PASSWORD };
}
