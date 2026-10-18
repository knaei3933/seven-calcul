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

const {
  authenticate,
  closeDatabaseForTest,
  createUser,
  ensureAdministratorSeed,
  listUsers,
} = await import("@/lib/auth-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("Vercel database-backed authentication", () => {
  it("seeds durable administrators and allows managed users despite VERCEL=1", async () => {
    await ensureAdministratorSeed();
    const users = await listUsers();
    expect(users.map((user) => user.email)).toContain("kim@kanei-trade.co.jp");
    expect(users.map((user) => user.email)).toContain("gotou@727.co.jp");

    const created = await createUser({
      email: "managed@vercel-db.test",
      name: "Managed User",
      password: "managed-user-password",
      role: "user",
    });
    expect(created.email).toBe("managed@vercel-db.test");
    await expect(authenticate("kim@kanei-trade.co.jp", "vercel-database-password")).resolves.toMatchObject({
      email: "kim@kanei-trade.co.jp",
      role: "admin",
    });
  });
});
