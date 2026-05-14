import { buildBaseConfig } from "./base";

export const config = {
  ...buildBaseConfig(),
  nodeEnv: "development" as const,
};
