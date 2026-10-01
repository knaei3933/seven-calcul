import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "env-auth-admins-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.AUTH_MODE = "env";
process.env.ADMIN_EMAIL = "primary@env-auth.test";
process.env.ADMIN_PASSWORD = "primary-password";
process.env.ADMIN_NAME = "Primary Administrator";
process.env.SECOND_ADMIN_EMAIL = "second@env-auth.test";
process.env.SECOND_ADMIN_PASSWORD = "second-password";
process.env.SECOND_ADMIN_NAME = "Second Administrator";
process.env.THIRD_ADMIN_EMAIL = "Narimiya@727.co.jp";
process.env.THIRD_ADMIN_PASSWORD = "seven12321";
process.env.THIRD_ADMIN_NAME = "成宮寛幸";

const {
  authenticate,
  closeDatabaseForTest,
  createSession,
  ensureAdministratorSeed,
  getSessionUserFromToken,
  listUsers,
} = await import("@/lib/auth-store");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("environment-backed administrators", () => {
  it("supports a third environment administrator and issues a valid session", async () => {
    await expect(ensureAdministratorSeed()).resolves.toBe(1);

    const users = await listUsers();
    expect(users.map((user) => user.email)).toEqual([
      "primary@env-auth.test",
      "second@env-auth.test",
      "narimiya@727.co.jp",
    ]);

    const third = await authenticate("Narimiya@727.co.jp", "seven12321");
    expect(third).toMatchObject({
      id: 3,
      email: "narimiya@727.co.jp",
      name: "成宮寛幸",
      role: "admin",
      isActive: true,
    });

    const session = await createSession(third!.id);
    await expect(getSessionUserFromToken(session.token)).resolves.toMatchObject({
      email: "narimiya@727.co.jp",
    });
    await expect(authenticate("narimiya@727.co.jp", "wrong-password")).resolves.toBeNull();
  });
});
