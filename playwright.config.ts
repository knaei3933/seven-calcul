import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ordinaryStatePath = join(tmpdir(), "pouch-playwright-admin-state.json");
const kanaiStatePath = join(tmpdir(), "pouch-playwright-kanai-state.json");
const databasePath = join(tmpdir(), "pouch-playwright-quotations.db");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:3101", trace: "retain-on-failure" },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { baseURL: "http://127.0.0.1:3101", trace: "retain-on-failure" },
    },
    {
      name: "ordinary-chromium",
      testMatch: /(candidate-integrity|gravure-master|gravure-selection-routing)\.spec\.ts/,
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: ordinaryStatePath },
    },
    {
      name: "ordinary-mobile-chrome",
      testMatch: /candidate-integrity\.spec\.ts/,
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], storageState: ordinaryStatePath },
    },
    {
      name: "kanai-chromium",
    testIgnore: /(candidate-integrity|gravure-master)\.spec\.ts|auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: kanaiStatePath },
    },
    {
      name: "kanai-mobile-chrome",
      testIgnore: /(candidate-integrity|gravure-master)\.spec\.ts|auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], storageState: kanaiStatePath },
    },
  ],
  webServer: {
    command: `node -e 'for (const suffix of ["", "-shm", "-wal"]) require("node:fs").rmSync("/tmp/pouch-playwright-quotations.db" + suffix, { force: true })' && POUCH_QUOTATION_DB=${JSON.stringify(databasePath)} ADMIN_EMAIL=admin@pouch-e2e.test ADMIN_PASSWORD=admin-e2e-password ADMIN_NAME='E2E Administrator' SECOND_ADMIN_EMAIL=kanai-admin@kanei-trade.co.jp SECOND_ADMIN_PASSWORD=kanai-e2e-password SECOND_ADMIN_NAME='Kanai E2E Administrator' npm run start -- -H 127.0.0.1 -p 3101`,
    url: "http://127.0.0.1:3101",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 60000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
