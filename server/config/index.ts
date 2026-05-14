import type { AppConfig } from "./base";

export type { AppConfig } from "./base";

// Dynamic re-export: picks the right config based on NODE_ENV so all existing
// imports from '../config' keep working without touching middleware/routes/services.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const config: AppConfig =
  process.env["NODE_ENV"] === "production"
    ? require("./production").config
    : require("./local").config;
