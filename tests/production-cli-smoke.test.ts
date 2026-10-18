import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pouch-production-cli-"));
const credentialFreeEnvironment = { ...process.env };
delete credentialFreeEnvironment.DATABASE_URL;
delete credentialFreeEnvironment.POSTGRES_URL;

function runNpm(script: string, args: string[]) {
  return spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", script, "--", ...args],
    {
      cwd: process.cwd(),
      env: credentialFreeEnvironment,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

const sharedArgs = [
  "--target",
  "production",
  "--confirm-host",
  "prod-pooler.example.neon.tech",
  "--confirm-database",
  "prod_database",
  "--confirm-schema",
  "public",
  "--confirm-domain-tables",
  "film_order_events,film_order_files,film_orders,quotation_checklists,quotations",
];

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("production quotation CLI smoke", () => {
  it("loads Node 24 TypeScript entrypoints and reaches environment validation without credentials", () => {
    const phase1 = runNpm("cleanup:quotation-domain:production:phase1", [
      "--phase",
      "1",
      "--confirm-production-read-only-backup",
      ...sharedArgs,
      "--output-dir",
      join(temporaryRoot, "phase1"),
    ]);
    expect(phase1.status).toBe(1);
    expect(phase1.stderr).toContain(
      "quotation_production_cleanup_failed:production_postgresql_url_not_configured",
    );

    const phase2 = runNpm("cleanup:quotation-domain:production:phase2", [
      "--phase",
      "2",
      "--confirm-production-deletion",
      ...sharedArgs,
      "--backup-manifest",
      join(temporaryRoot, "manifest.json"),
      "--authorization-file",
      join(temporaryRoot, "authorization.json"),
      "--challenge-file",
      join(temporaryRoot, "authorization.challenge"),
    ]);
    expect(phase2.status).toBe(1);
    expect(phase2.stderr).toContain(
      "quotation_production_cleanup_failed:production_postgresql_url_not_configured",
    );
  }, 45_000);

  it("makes standalone backup validation failures nonzero without credentials", () => {
    const backup = runNpm("backup:quotation-domain:production", [
      "--target",
      "production",
      "--output-dir",
      join(temporaryRoot, "backup"),
    ]);
    expect(backup.status).toBe(1);
    expect(backup.stderr).toContain("production_postgresql_url_not_configured");
  }, 30_000);
});
