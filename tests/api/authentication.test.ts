import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "auth-api-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@auth-api.test";
process.env.ADMIN_PASSWORD = "admin-auth-api-password";
process.env.ADMIN_NAME = "Auth API Admin";

const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: logout } = await import("@/app/api/auth/logout/route");
const { GET: session } = await import("@/app/api/auth/session/route");
const { GET: listUsers, POST: createUserRoute } = await import("@/app/api/users/route");
const { PATCH: updateUserRoute } = await import("@/app/api/users/[id]/route");
const { GET: listQuotations } = await import("@/app/api/quotations/route");
const { GET: listCustomers } = await import("@/app/api/customers/route");
const { GET: getChecklists } = await import("@/app/api/quotations/[id]/checklists/route");
const { saveQuotation } = await import("@/lib/quotation-store");
const { createUser } = await import("@/lib/auth-store");

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

describe("authentication and authorization APIs", () => {
  it("returns generic failures and establishes an HttpOnly server session", async () => {
    const invalid = await login(request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@test.example", password: "invalid-password-value" }),
    }));
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_credentials" });

    const admin = await loginToken("admin@auth-api.test", "admin-auth-api-password");
    expect(admin).toBeDefined();
    const loginResponse = await login(request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@auth-api.test", password: "admin-auth-api-password" }),
    }));
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toContain("Secure");
    const httpsLogin = await login(request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@auth-api.test", password: "admin-auth-api-password" }),
    }));
    expect(httpsLogin.headers.get("set-cookie") ?? "").toContain("Secure");
    const current = await session(request("http://localhost/api/auth/session", {}, admin));
    expect(current.status).toBe(200);
    const payload = await current.json();
    expect(payload.user.email).toBe("admin@auth-api.test");
    expect(JSON.stringify(payload)).not.toContain("password_hash");
    expect(current.headers.get("set-cookie") ?? "").not.toContain(admin!);

    const oldToken = admin!;
    const response = await logout(request("http://localhost/api/auth/logout", { method: "POST" }, oldToken));
    expect(response.status).toBe(200);
    await expect(session(request("http://localhost/api/auth/session", {}, oldToken))).resolves.toMatchObject({ status: 401 });
  });

  it("protects quotation, customer, and checklist APIs independently", async () => {
    const adminToken = await loginToken("admin@auth-api.test", "admin-auth-api-password");
    const quotation = await saveQuotation({
      quotationNumber: "S7-AUTH-PROTECTED",
      status: "draft",
      issueDate: "2026-09-20",
      validUntil: "2026-10-20",
      customerName: "Auth Test",
      customerContact: "Tester",
      productName: "Auth Pouch",
      sizeSummary: "50×90mm / 1連",
      quantity: "10000",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "1",
      filmMeterPrice: "200",
      filmOrderLengthM: "500",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "10",
      subtotal: "100000",
      tax: "10000",
      grandTotal: "110000",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "manual-entry",
      resultHash: "",
      payload: {},
    }, 1);
    expect(quotation).not.toBeNull();
    await expect(listQuotations(request("http://localhost/api/quotations"))).resolves.toMatchObject({ status: 401 });
    await expect(listCustomers(request("http://localhost/api/customers"))).resolves.toMatchObject({ status: 401 });
    await expect(getChecklists(request("http://localhost/api/quotations/1/checklists"), { params: Promise.resolve({ id: "1" }) } as never)).resolves.toMatchObject({ status: 401 });
    await expect(listQuotations(request("http://localhost/api/quotations", {}, adminToken))).resolves.toMatchObject({ status: 200 });
  });

  it("administers users without exposing secrets and protects the last active admin", async () => {
    const adminToken = await loginToken("admin@auth-api.test", "admin-auth-api-password");
    const normal = await createUser({
      email: "normal@auth-api.test",
      name: "Normal User",
      password: "normal-auth-password",
      role: "user",
    });
    const userToken = await loginToken(normal.email, "normal-auth-password");
    expect(userToken).toBeDefined();
    const oldUserSession = await session(request("http://localhost/api/auth/session", {}, userToken));
    expect(oldUserSession.status).toBe(200);

    await expect(listUsers(request("http://localhost/api/users", {}, userToken))).resolves.toMatchObject({ status: 403 });
    const listed = await listUsers(request("http://localhost/api/users", {}, adminToken));
    const listedBody = await listed.json();
    expect(listedBody.users).toHaveLength(2);
    expect(JSON.stringify(listedBody)).not.toMatch(/password_hash|session_token/);

    const created = await createUserRoute(request("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "NORMAL@auth-api.test",
        name: "Duplicate User",
        password: "duplicate-auth-password",
        role: "user",
      }),
    }, adminToken));
    expect(created.status).toBe(409);

    const reset = await updateUserRoute(request(`http://localhost/api/users/${normal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "reset-auth-password" }),
    }, adminToken), { params: Promise.resolve({ id: String(normal.id) }) });
    expect(reset.status).toBe(200);
    await expect(session(request("http://localhost/api/auth/session", {}, userToken))).resolves.toMatchObject({ status: 401 });
    await expect(loginToken(normal.email, "normal-auth-password")).resolves.toBeUndefined();
    await expect(loginToken(normal.email, "reset-auth-password")).resolves.toBeDefined();

    const adminId = 1;
    const deactivated = await updateUserRoute(request(`http://localhost/api/users/${adminId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    }, adminToken), { params: Promise.resolve({ id: String(adminId) }) });
    expect(deactivated.status).toBe(400);
  });
});
