import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "customer-ownership-reconcile-"));
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "system@customer-reconcile.test";
process.env.ADMIN_PASSWORD = "system-admin-password";
process.env.ADMIN_NAME = "System Admin";

const { listCustomers, reconcileLegacyCustomerOwnershipForTest, saveCustomer } = await import("@/lib/customer-store");
const { createUser } = await import("@/lib/auth-store");
const { saveQuotation } = await import("@/lib/quotation-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("legacy customer ownership reconciliation", () => {
  it("moves legacy K customers back to Kanei unless Seven created them", async () => {
    const input = {
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    };
    await saveCustomer("seven", { customerCode: "K-9001", customerName: "Kanei legacy customer", ...input });
    await saveCustomer("seven", { customerCode: "K-9002", customerName: "Seven legacy customer", ...input });

    const evidence = new Map<string, Set<"kanei" | "seven">>([
      ["K-9001", new Set(["kanei"])],
      ["K-9002", new Set(["seven"])],
    ]);
    await reconcileLegacyCustomerOwnershipForTest(evidence);

    expect((await listCustomers("", 10, "kanei")).map((row) => row.customerCode)).toEqual(["K-9001"]);
    expect((await listCustomers("", 10, "seven")).map((row) => row.customerCode)).toEqual(["K-9002"]);
  });

  it("reads Seven/Kanei evidence from quotation creators", async () => {
    const seven = await createUser({
      email: "evidence@727.co.jp",
      name: "Seven Evidence",
      password: "seven-evidence-pass",
      role: "user",
    });
    const input = {
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    };
    await saveCustomer("seven", { customerCode: "K-9003", customerName: "Seven quoted K customer", ...input });
    await saveCustomer("seven", { customerCode: "K-9004", customerName: "Unquoted K customer", ...input });
    await saveQuotation({
      quotationNumber: "S7-CUSTOMER-EVIDENCE-001",
      status: "draft",
      issueDate: "2026-11-03",
      validUntil: "2026-12-03",
      customerName: "Seven quoted K customer",
      customerContact: "",
      productName: "evidence pouch",
      sizeSummary: "50x60mm / 1",
      quantity: "1000",
      fillingCostPerPiece: "0",
      filmCostPerPiece: "0",
      filmMeterPrice: "0",
      filmOrderLengthM: "0",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "0",
      subtotal: "0",
      tax: "0",
      grandTotal: "0",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "customer-evidence",
      resultHash: "customer-evidence-hash",
      payload: { customerCode: "K-9003" },
    }, seven.id, "user");

    await reconcileLegacyCustomerOwnershipForTest();

    expect((await listCustomers("", 10, "seven")).map((row) => row.customerCode)).toEqual(["K-9003"]);
    expect((await listCustomers("", 10, "kanei")).map((row) => row.customerCode)).toEqual([
      "K-9001",
      "K-9002",
      "K-9004",
    ]);
  });

  it("merges duplicate legacy Seven K customers into their Kanei owner", async () => {
    await saveCustomer("seven", {
      customerCode: "K-9005",
      customerName: "Old duplicate name",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await saveCustomer("kanei", {
      customerCode: "K-9005",
      customerName: "Current Kanei name",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });

    await reconcileLegacyCustomerOwnershipForTest();

    expect((await listCustomers("", 10, "seven")).some((row) => row.customerCode === "K-9005")).toBe(false);
    const merged = await listCustomers("", 10, "kanei");
    expect(merged.find((row) => row.customerCode === "K-9005")?.customerName).toBe("Current Kanei name");
  });
});
