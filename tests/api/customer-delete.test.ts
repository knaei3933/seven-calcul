import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "customer-delete-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "gotou@727.co.jp";
process.env.ADMIN_PASSWORD = "gotou-admin-password";
process.env.ADMIN_NAME = "Gotou Admin";

const { DELETE: deleteRoute, GET: getCode } = await import("@/app/api/customers/[code]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { createUser } = await import("@/lib/auth-store");
const { saveCustomer } = await import("@/lib/customer-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

function request(url: string, init: RequestInit = {}, token?: string): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { cookie: `pouch_session=${token}` } : {}) },
  });
}

async function loginToken(email: string, password: string): Promise<string | undefined> {
  const response = await login(request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  return response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/)?.[1];
}

describe("customer deletion API", () => {
  let adminToken: string | undefined;
  let userToken: string | undefined;

  beforeAll(async () => {
    await saveCustomer({
      customerCode: "DEL-001",
      customerName: "삭제검증주식회사",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });
    await createUser({ email: "staff@727.co.jp", name: "Staff", password: "staff-password-123", role: "user" });
    adminToken = await loginToken("gotou@727.co.jp", "gotou-admin-password");
    userToken = await loginToken("staff@727.co.jp", "staff-password-123");
  });

  it("requires authentication", async () => {
    const response = await deleteRoute(
      request("http://localhost/api/customers/DEL-001", { method: "DELETE" }),
      { params: Promise.resolve({ code: "DEL-001" }) } as never,
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-admin accounts", async () => {
    const response = await deleteRoute(
      request("http://localhost/api/customers/DEL-001", { method: "DELETE" }, userToken),
      { params: Promise.resolve({ code: "DEL-001" }) } as never,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "admin_required" });
  });

  it("deletes as admin and then reports the missing customer", async () => {
    const response = await deleteRoute(
      request("http://localhost/api/customers/DEL-001", { method: "DELETE" }, adminToken),
      { params: Promise.resolve({ code: "DEL-001" }) } as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });

    const missing = await deleteRoute(
      request("http://localhost/api/customers/DEL-001", { method: "DELETE" }, adminToken),
      { params: Promise.resolve({ code: "DEL-001" }) } as never,
    );
    expect(missing.status).toBe(404);

    const readBack = await getCode(
      request("http://localhost/api/customers/DEL-001", {}, adminToken),
      { params: Promise.resolve({ code: "DEL-001" }) } as never,
    );
    expect(readBack.status).toBe(404);
  });
});
