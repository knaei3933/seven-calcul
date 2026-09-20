import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminStatePath = join(tmpdir(), "pouch-playwright-admin-state.json");
const databasePath = join(tmpdir(), "pouch-playwright-quotations.db");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: adminStatePath },
    },
    {
      name: "mobile-chrome",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], storageState: adminStatePath },
    },
  ],
  webServer: {
    command: `rm -f ${databasePath} ${databasePath}-shm ${databasePath}-wal; POUCH_QUOTATION_DB=${JSON.stringify(databasePath)} ADMIN_EMAIL=admin@pouch-e2e.test ADMIN_PASSWORD=admin-e2e-password ADMIN_NAME='E2E Administrator' npm run dev -- -H 127.0.0.1 -p 3100`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 60000,
  },
});
