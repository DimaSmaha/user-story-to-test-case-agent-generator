import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export interface AppConfig {
  port: number;
  nodeEnv: "development" | "production" | "test";
  apiKey: string | null;
  issueTracker: string;
  fakeTrackerUrl: string | undefined;
  appUrl: string | undefined;
  appUsername: string | undefined;
  appPassword: string | undefined;
  jobTimeoutMs: number;
  batchTimeoutMs: number;
}

const VALID_TRACKERS = ["fake", "github", "jira", "ado", "linear"] as const;

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`${key} is required but not set in environment`);
  return val;
}

function optional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function int(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export function buildBaseConfig(): Omit<AppConfig, "nodeEnv"> {
  const issueTracker = required("ISSUE_TRACKER");
  if (!VALID_TRACKERS.includes(issueTracker as (typeof VALID_TRACKERS)[number])) {
    throw new Error(
      `ISSUE_TRACKER must be one of: ${VALID_TRACKERS.join("|")} — got "${issueTracker}"`,
    );
  }

  const fakeTrackerUrl = optional("FAKE_TRACKER_URL");
  if (issueTracker === "fake" && !fakeTrackerUrl) {
    throw new Error("FAKE_TRACKER_URL is required when ISSUE_TRACKER=fake");
  }

  return {
    port: int("SERVER_PORT", 4000),
    apiKey: process.env["API_KEY"] ?? null,
    issueTracker,
    fakeTrackerUrl,
    appUrl: optional("APP_URL"),
    appUsername: optional("APP_USERNAME"),
    appPassword: optional("APP_PASSWORD"),
    jobTimeoutMs: int("JOB_TIMEOUT_MS", 40 * 60 * 1000),
    batchTimeoutMs: int("BATCH_TIMEOUT_MS", 60 * 60 * 1000),
  };
}
