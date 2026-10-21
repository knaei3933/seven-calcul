import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "vercel-db-auth-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.VERCEL = "1";
delete process.env.AUTH_MODE;
process.env.ADMIN_EMAIL = "kim@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "vercel-database-password";
process.env.ADMIN_NAME = "Kim Admin";
process.env.SECOND_ADMIN_EMAIL = "gotou@727.co.jp";
process.env.SECOND_ADMIN_PASSWORD = "vercel-database-password-2";
process.env.SECOND_ADMIN_NAME = "Gotou Admin";

const { closeDatabaseForTest, ensureAdministratorSeed } = await import("@/lib/auth-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("Vercel database-backed authentication", () => {
  it("refuses managed local SQLite fallback on Vercel and requires Neon", async () => {
    await expect(ensureAdministratorSeed()).rejects.toThrow("neon_database_url_required");
  });
});
