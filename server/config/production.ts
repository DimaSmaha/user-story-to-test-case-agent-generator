import { buildBaseConfig } from "./base";

export const config = {
  ...buildBaseConfig(),
  nodeEnv: "production" as const,
};
