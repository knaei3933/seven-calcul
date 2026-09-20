import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "page-auth-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@page-auth.test";
process.env.ADMIN_PASSWORD = "admin-page-auth-password";
process.env.ADMIN_NAME = "Page Auth Admin";

const redirectMock = vi.fn((url: string): never => {
  throw new Error(`REDIRECT:${url}`);
});
const forgedToken = "forged-session-cookie-value";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "pouch_session" ? { name, value: forgedToken } : undefined,
  }),
}));

const { requirePageUser } = await import("@/lib/page-auth");
const { GET: listQuotations, POST: createQuotation } = await import("@/app/api/quotations/route");
const { listQuotations: readQuotations } = await import("@/lib/quotation-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("server page authentication", () => {
  it("redirects a forged cookie before reading or creating quotation data", async () => {
    await expect(requirePageUser("/history")).rejects.toThrow(
      "REDIRECT:/login?next=%2Fhistory",
    );
    expect(redirectMock).toHaveBeenCalledWith("/login?next=%2Fhistory");

    const listResponse = await listQuotations(new Request("http://localhost/api/quotations"));
    expect(listResponse.status).toBe(401);

    const createResponse = await createQuotation(new Request("http://localhost/api/quotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quotationNumber: "S7-FORGED-PAGE",
        status: "draft",
        issueDate: "2026-09-20",
        quantity: "1",
        fillingCostPerPiece: "0",
        filmCostPerPiece: "0",
        filmMeterPrice: "0",
        filmOrderLengthM: "0",
        targetMargin: "0",
        taxRatePercent: "0",
        pricePerPiece: "0",
        subtotal: "0",
        tax: "0",
        grandTotal: "0",
        payload: {},
      }),
    }));
    expect(createResponse.status).toBe(401);
    await expect(readQuotations()).resolves.toHaveLength(0);
  });
});
