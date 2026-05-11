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

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(APP_URL!);
  await page.fill('[data-test="username"]', USERNAME!);
  await page.fill('[data-test="password"]', PASSWORD!);
  await page.click('[data-test="login-button"]');
  await page.waitForURL("**/inventory.html");

  fs.mkdirSync(path.dirname(path.resolve(STORAGE_STATE_PATH)), {
    recursive: true,
  });
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  console.log(`✓ Auth state saved to ${STORAGE_STATE_PATH}`);
}

main().catch((err) => {
  console.error("Auth failed:", err.message);
  process.exit(1);
});
