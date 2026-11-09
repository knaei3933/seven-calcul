import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SqlClient } from "@/lib/db";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-creation-policy-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.ADMIN_EMAIL = "admin@creation-policy.test";
process.env.ADMIN_PASSWORD = "creation-policy-admin-password";
process.env.ADMIN_NAME = "Creation Policy Admin";

const { createUser } = await import("@/lib/auth-store");
const {
  getDatabaseForTest,
  QuotationActionForbiddenError,
  saveIssuedQuotation,
  saveQuotation,
} = await import("@/lib/quotation-store");
const {
  allocateQuotationNumberInTransaction,
  NEW_QUOTATION_OWNER_DOMAIN,
  QuotationNumberAllocationConflictError,
  StaleLegacyQuotationNumberError,
} = await import("@/lib/quotation-creation-policy");
const {
  createPortalQuoteWithMapping,
  getPortalQuoteDatabaseForTest,
  resetPortalQuoteStoreForTest,
} = await import("@/lib/portal/quote-calculation-store");
const { getPortalServiceActorId } = await import("@/lib/portal/identity-store");

const actor = await createUser({
  email: "creator@kanei-trade.co.jp",
  name: "Kanei Creator",
  password: "kanei-creator-password",
  role: "user",
});

function input(quotationNumber = ""): QuotationRecordInput {
  return {
    quotationNumber,
    status: "sent",
    issueDate: "2026-11-09",
    validUntil: "2026-12-09",
    customerName: "Creation Policy Customer",
    customerContact: "Creator",
    productName: "Policy Pouch",
    sizeSummary: "50x90mm / 1連",
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
    calculationVersion: "creation-policy-test",
    resultHash: "creation-policy-hash",
    payload: { revision: 1 },
  };
}

afterAll(async () => {
  await resetPortalQuoteStoreForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("centralized quotation creation policy", () => {
  it("assigns every human-created record to durable Kanei ownership with a KT number", async () => {
    const pdf = Buffer.from("%PDF-kanei-creation", "utf8");
    const issued = await saveIssuedQuotation(input(), actor.id, "user", pdf, "kanei.pdf", null);
    const draft = await saveQuotation(input(), actor.id);
    expect(issued.record.ownerDomain).toBe(NEW_QUOTATION_OWNER_DOMAIN);
    expect(issued.record.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/);
    expect(draft.ownerDomain).toBe(NEW_QUOTATION_OWNER_DOMAIN);
    expect(draft.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/);
  });

  it("rejects an unpersisted S7 number without creating a row or PDF", async () => {
    const db = await getDatabaseForTest();
    const before = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
    await expect(saveIssuedQuotation(
      input("S7-STALE-CUTOVER"),
      actor.id,
      "user",
      Buffer.from("%PDF-stale", "utf8"),
      "stale.pdf",
      null,
    )).rejects.toBeInstanceOf(StaleLegacyQuotationNumberError);
    const after = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
    expect(Number(after?.count)).toBe(Number(before?.count));
    expect(await db.get("SELECT pdf_data FROM quotations WHERE quotation_number = ?", ["S7-STALE-CUTOVER"])).toBeUndefined();
  });

  it("preserves durable Seven ownership and prefix on an existing S7 update", async () => {
    const created = await saveQuotation(input(), actor.id);
    const db = await getDatabaseForTest();
    await db.run(
      "UPDATE quotations SET owner_domain = 'seven', quotation_number = ? WHERE id = ?",
      ["S7-DURABLE-COMPATIBILITY", created.id],
    );
    const updated = await saveQuotation({
      ...input("S7-DURABLE-COMPATIBILITY"),
      status: "approved",
      payload: { revision: 2 },
    }, actor.id);
    expect(updated).toMatchObject({
      id: created.id,
      ownerDomain: "seven",
      quotationNumber: "S7-DURABLE-COMPATIBILITY",
      status: "approved",
    });
  });

  it("uses the allocation-time JST month and rejects Seven allocation for new records", async () => {
    const db = await getDatabaseForTest();
    await db.transaction(async (tx: SqlClient) => {
      expect(await allocateQuotationNumberInTransaction(tx, "kanei", new Date("2026-12-31T14:59:00Z")))
        .toMatch(/^KT-202612-\d{3}$/);
    });
    await db.transaction(async (tx: SqlClient) => {
      expect(await allocateQuotationNumberInTransaction(tx, "kanei", new Date("2026-12-31T15:00:00Z")))
        .toMatch(/^KT-202701-\d{3}$/);
    });
    await expect(db.transaction(async (tx: SqlClient) => {
      await allocateQuotationNumberInTransaction(tx, "seven", new Date("2026-11-09T00:00:00Z"));
    })).rejects.toThrow("new_quotation_owner_policy_violation");
  });

  it("shares one serialized KT sequence across concurrent portal and human creation", async () => {
    const db = await getPortalQuoteDatabaseForTest();
    const actorId = await getPortalServiceActorId();
    expect(actorId).not.toBeNull();
    const base = input();
    const [portal, human] = await Promise.all([
      createPortalQuoteWithMapping({
        quotation: { ...base, quotationNumber: undefined } as Omit<QuotationRecordInput, "quotationNumber">,
        actorId: actorId!,
        portalUserId: 1001,
        ownerDomain: "kanei",
        customerCode: "PORTAL-POLICY",
        idempotencyKey: "portal-policy-race",
        requestFingerprint: "portal-policy-race",
        buildResponse: ({ publicId, quotationNumber }) => ({ publicId, quotationNumber }),
      }),
      saveIssuedQuotation(
        { ...input(), customerName: "Human Policy Customer" },
        actor.id,
        "user",
        Buffer.from("%PDF-human-policy", "utf8"),
        "human-policy.pdf",
        null,
      ),
    ]);
    expect(portal.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/);
    expect(human.record.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/);
    expect(portal.quotationNumber).not.toBe(human.record.quotationNumber);
    const rows = await db.all<{ owner_domain: string; quotation_number: string }>(
      "SELECT owner_domain, quotation_number FROM quotations WHERE quotation_number IN (?, ?)",
      [portal.quotationNumber, human.record.quotationNumber],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.owner_domain === "kanei")).toBe(true);
    expect(new Set(rows.map((row) => row.quotation_number)).size).toBe(2);
    const mappings = await db.all(
      "SELECT quotation_id FROM portal_quote_mappings WHERE idempotency_key = ?",
      ["portal-policy-race"],
    );
    expect(mappings).toHaveLength(1);
  });

  it("returns a structured terminal conflict after bounded allocation retries", async () => {
    const db = await getPortalQuoteDatabaseForTest();
    const actorId = await getPortalServiceActorId();
    const actualTransaction = db.transaction.bind(db);
    Object.defineProperty(db, "transaction", {
      configurable: true,
      writable: true,
      value: async <T>(operation: (tx: SqlClient) => Promise<T>) => actualTransaction(async (tx) => {
        forcedAllocatorTx = Object.create(tx) as SqlClient;
        forcedAllocatorTx.all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
          if (sql.includes("FROM quotations") && String(params[0]).startsWith("KT-")) {
            return [{ quotation_number: "KT-197001-001" }] as T[];
          }
          return tx.all<T>(sql, params);
        };
        return operation(forcedAllocatorTx);
      }),
    });
    let forcedAllocatorTx: SqlClient;
    try {
      await expect(createPortalQuoteWithMapping({
        quotation: input() as Omit<QuotationRecordInput, "quotationNumber">,
        actorId: actorId!,
        portalUserId: 1002,
        ownerDomain: "kanei",
        customerCode: "PORTAL-CONFLICT",
        idempotencyKey: "portal-policy-conflict",
        requestFingerprint: "portal-policy-conflict",
        buildResponse: ({ publicId, quotationNumber }) => ({ publicId, quotationNumber }),
      })).rejects.toBeInstanceOf(QuotationNumberAllocationConflictError);
      const rows = await db.all(
        "SELECT * FROM portal_quote_mappings WHERE idempotency_key = ?",
        ["portal-policy-conflict"],
      );
      expect(rows).toHaveLength(0);
    } finally {
      Object.defineProperty(db, "transaction", {
        configurable: true,
        writable: true,
        value: actualTransaction,
      });
    }
  });
});
