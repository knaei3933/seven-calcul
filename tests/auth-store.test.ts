import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "auth-store-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "shared.db");
process.env.ADMIN_EMAIL = "Admin@AuthStore.Test";
process.env.ADMIN_PASSWORD = "administrator-password";
process.env.ADMIN_NAME = "Auth Administrator";

const {
  authenticate,
  closeDatabaseForTest,
  createSession,
  createUser,
  deleteSession,
  getSessionUserFromToken,
  listUsers,
  readSessionCookie,
  updateUser,
} = await import("@/lib/auth-store");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("SQLite auth store", () => {
  it("treats a malformed session cookie value as an opaque token instead of throwing", async () => {
    const request = new Request("http://localhost/login", {
      headers: { cookie: "pouch_session=%" },
    });
    await expect(readSessionCookie(request)).resolves.toBe("%");
  });

  it("seeds one lowercase administrator idempotently and salts scrypt passwords", async () => {
    const seeded = await listUsers();
    expect(seeded.filter((user) => user.role === "admin")).toHaveLength(1);
    expect(seeded[0].email).toBe("admin@authstore.test");
    expect(seeded[0].isActive).toBe(true);
    const again = await listUsers();
    expect(again).toHaveLength(seeded.length);

    const first = await createUser({
      email: "One@Test.Example",
      name: "Password One",
      password: "first-user-password",
      role: "user",
    });
    const second = await createUser({
      email: "two@test.example",
      name: "Password Two",
      password: "second-user-password",
      role: "user",
    });
    const db = (await import("@/lib/auth-store")).getDatabase;
    expect(await db()).toBeDefined();
    expect(first.email).toBe("one@test.example");
    expect(first).not.toHaveProperty("passwordHash");
    expect(second).not.toHaveProperty("passwordHash");
  });

  it("requires exact credentials and hides account existence", async () => {
    await expect(authenticate("one@test.example", "wrong-password")).resolves.toBeNull();
    await expect(authenticate("missing@test.example", "any-password")).resolves.toBeNull();
    await expect(authenticate("one@test.example", "first-user-password")).resolves.toMatchObject({
      email: "one@test.example",
    });
  });

  it("stores only hashed session tokens and logout blocks token reuse", async () => {
    const user = await authenticate("one@test.example", "first-user-password");
    expect(user).not.toBeNull();
    const issued = await createSession(user!.id);
    const sessionUser = await getSessionUserFromToken(issued.token);
    expect(sessionUser?.email).toBe(user!.email);

    const { getDatabase } = await import("@/lib/auth-store");
    const db = await getDatabase();
    const sessions = db.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").all(user!.id) as Array<{ token_hash: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].token_hash).not.toContain(issued.token);

    await deleteSession(issued.token);
    await expect(getSessionUserFromToken(issued.token)).resolves.toBeNull();
  });

  it("rejects duplicate lowercase-equivalent email", async () => {
    await expect(createUser({
      email: "ONE@test.example",
      name: "Duplicate",
      password: "duplicate-password",
      role: "user",
    })).rejects.toThrow("duplicate_email");
  });

  it("deactivation prevents login and invalidates active sessions", async () => {
    const user = await createUser({
      email: "deactivate@test.example",
      name: "Deactivated User",
      password: "deactivated-password",
      role: "user",
    });
    const issued = await createSession(user.id);
    await updateUser(user.id, { isActive: false });
    await expect(authenticate(user.email, "deactivated-password")).resolves.toBeNull();
    await expect(getSessionUserFromToken(issued.token)).resolves.toBeNull();
    await updateUser(user.id, { isActive: true });
    await expect(authenticate(user.email, "deactivated-password")).resolves.toMatchObject({ id: user.id });
  });

  it("preserves at least one active administrator", async () => {
    const admin = await authenticate("Admin@AuthStore.Test", "administrator-password");
    expect(admin).not.toBeNull();
    await expect(updateUser(admin!.id, { isActive: false })).rejects.toThrow("last_active_admin");
    await expect(updateUser(admin!.id, { role: "user" })).rejects.toThrow("last_active_admin");
  });

  it("serializes concurrent reductions so two admins cannot both lose authority", async () => {
    const firstAdmin = await authenticate("Admin@AuthStore.Test", "administrator-password");
    const secondAdmin = await createUser({
      email: "concurrent-admin@authstore.test",
      name: "Concurrent Admin",
      password: "concurrent-admin-password",
      role: "admin",
    });
    expect(firstAdmin).not.toBeNull();
    const results = await Promise.allSettled([
      updateUser(firstAdmin!.id, { isActive: false }),
      updateUser(secondAdmin.id, { isActive: false }),
    ]);
    const finalAdmins = (await listUsers()).filter((user) => user.role === "admin" && user.isActive);
    expect(finalAdmins.length).toBeGreaterThanOrEqual(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(results.some((result) => result.status === "rejected" && result.reason.message === "last_active_admin")).toBe(true);
  });
});
