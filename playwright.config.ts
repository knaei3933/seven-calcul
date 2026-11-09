import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ordinaryStatePath = join(tmpdir(), "pouch-playwright-admin-state.json");
const kanaiStatePath = join(tmpdir(), "pouch-playwright-kanai-state.json");
const testDatabaseUrl = process.env.POUCH_E2E_POSTGRESQL_URL ?? "postgresql://root:pouch-local-test@127.0.0.1:5433/pouch_test";

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
    command: `PGURL=${JSON.stringify(testDatabaseUrl)} node -e 'const {Client}=require("pg"); (async()=>{const c=new Client(process.env.PGURL); await c.connect(); await c.query("DROP SCHEMA public CASCADE"); await c.query("CREATE SCHEMA public"); await c.end();})().catch((e)=>{console.error(e);process.exit(1)})' && DATABASE_URL=${JSON.stringify(testDatabaseUrl)} POSTGRES_URL=${JSON.stringify(testDatabaseUrl)} MAIL_DRY_RUN=true FILM_EXTERNAL_LINK_ORIGINS='http://127.0.0.1:3101,http://localhost:3101' FILM_DEFAULT_EXTERNAL_LINK_ORIGIN='http://127.0.0.1:3101' ADMIN_EMAIL=admin@pouch-e2e.test ADMIN_PASSWORD=admin-e2e-password ADMIN_NAME='E2E Administrator' SECOND_ADMIN_EMAIL=kanai-admin@kanei-trade.co.jp SECOND_ADMIN_PASSWORD=kanai-e2e-password SECOND_ADMIN_NAME='Kanai E2E Administrator' npm run start -- -H 127.0.0.1 -p 3101`,
    url: "http://127.0.0.1:3101",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 60000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
