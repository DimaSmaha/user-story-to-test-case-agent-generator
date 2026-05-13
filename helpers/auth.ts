import { chromium } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { getEnvVars } from "./getEnvVars";

const STORAGE_STATE_PATH = ".playwright-auth/auth.json";
const {
  APP_URL,
  APP_USERNAME: USERNAME,
  APP_PASSWORD: PASSWORD,
} = getEnvVars();

const a = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};
const tag = `${a.cyan}[AUTH]${a.reset}`;

async function main() {
  console.log(`${tag} Launching browser...`);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`${tag} Navigating to ${APP_URL}...`);
  await page.goto(APP_URL!);

  console.log(`${tag} Filling credentials for user "${USERNAME}"...`);
  await page.fill('[data-test="username"]', USERNAME!);
  await page.fill('[data-test="password"]', PASSWORD!);

  console.log(`${tag} Submitting login form...`);
  await page.click('[data-test="login-button"]');

  console.log(`${tag} Waiting for navigation to inventory...`);
  await page.waitForURL("**/inventory.html");

  console.log(`${tag} Saving auth state to ${STORAGE_STATE_PATH}...`);
  fs.mkdirSync(path.dirname(path.resolve(STORAGE_STATE_PATH)), {
    recursive: true,
  });
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  console.log(`${a.green}${a.bold}✓ Auth complete${a.reset} — state saved to ${STORAGE_STATE_PATH}`);
}

main().catch((err) => {
  console.error(`${a.red}[AUTH FAILED]${a.reset} ${err.message}`);
  if (err.stack) console.error(`${a.dim}${err.stack}${a.reset}`);
  process.exit(1);
});
