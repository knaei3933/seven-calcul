import { withLegacySevenQuotationSave } from "./helpers/legacy-quotation-fixture";
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";


const databaseDirectory = await mkdtemp(join(tmpdir(), "g002-intake-projection-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-g002-password";
process.env.ADMIN_NAME = "Seven G002";

const { createUser, createSession, closeDatabaseForTest } = await import("@/lib/auth-store");
const { GET: dataIntakeRoute } = await import("@/app/api/data-intake/route");
const { getDatabaseForTest, saveQuotation: directSaveQuotation } = await import("@/lib/quotation-store");
const saveQuotation = withLegacySevenQuotationSave(directSaveQuotation);
const { syncFilmOrdersFromQuotations } = await import("@/lib/film-orders");
const { listFilmOrderIntakePage } = await import("@/lib/film-order-intake");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function input(quotationNumber: string): QuotationRecordInput {
  return {
    quotationNumber,
    status: "approved",
    issueDate: "2026-11-06",
    validUntil: "2099-12-31",
    customerName: `G002 ${quotationNumber}`,
    customerContact: "",
    productName: "共有進捗パウチ",
    sizeSummary: "",
    quantity: "12000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "1700",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "240000",
    tax: "24000",
    grandTotal: "264000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g002-projection",
    resultHash: "",
    payload: { customerEmail: "customer@example.test" },
  };
}

const sevenUser = await createUser({
  email: "seven-owner@727.co.jp",
  name: "Seven Owner",
  password: "seven-g002-owner-password",
  role: "user",
});
const kaneiUser = await createUser({
  email: "kanei-owner@kanei-trade.co.jp",
  name: "Kanei Owner",
  password: "kanei-g002-owner-password",
  role: "user",
});
const outsideUser = await createUser({
  email: "outside@example.test",
  name: "Outside User",
  password: "outside-g002-password",
  role: "user",
});
const neutralAdmin = await createUser({
  email: "neutral-admin@example.test",
  name: "Neutral Admin",
  password: "neutral-admin-g002-password",
  role: "admin",
});
const sevenQuote = await saveQuotation(input("S7-G002-LINKED"), sevenUser.id, "user");
const kaneiQuote = await saveQuotation(input("KT-G002-PO"), kaneiUser.id, "user");
const unresolvedQuote = await saveQuotation(input("UNRESOLVED-G002"), outsideUser.id, "user");
const db = await getDatabaseForTest();
await db.run("UPDATE quotations SET owner_domain='kanei', quotation_number='KT-G002-PO' WHERE id=?", [kaneiQuote.id]);
await db.run("UPDATE quotations SET owner_domain='unresolved' WHERE id=?", [unresolvedQuote.id]);
await syncFilmOrdersFromQuotations("seven-owner@727.co.jp");
await db.run("UPDATE quotations SET internal_approved_at = ? WHERE id = ?", [
  "2026-11-06T09:00:00.000Z",
  sevenQuote.id,
]);
await db.run("UPDATE quotations SET internal_approved_at = ? WHERE id = ?", [
  "2026-11-06T08:30:00.000Z",
  kaneiQuote.id,
]);
await db.run("UPDATE quotations SET internal_approved_at = ? WHERE id = ?", [
  "2026-11-06T08:00:00.000Z",
  unresolvedQuote.id,
]);
await db.run(`
  UPDATE film_orders
  SET receiving_registered_at = ?, customer_proof_status = 'requested',
      buyer_approval_status = 'approved', supplier_approval_status = 'pending'
  WHERE quotation_id = ?
`, ["2026-11-06T10:00:00.000Z", sevenQuote.id]);
await db.run(`
  UPDATE film_orders
  SET po_sent_at = ?, customer_proof_status = 'pending',
      buyer_approval_status = 'pending', supplier_approval_status = 'pending'
  WHERE quotation_id = ?
`, ["2026-11-06T11:00:00.000Z", kaneiQuote.id]);
async function entryFor(
  quotationNumber: string,
  viewer: Parameters<typeof listFilmOrderIntakePage>[1] = null,
) {
  const result = await listFilmOrderIntakePage({ search: quotationNumber }, viewer);
  expect(result.entries).toHaveLength(1);
  return result.entries[0]!;
}

function authorization(entry: Awaited<ReturnType<typeof entryFor>>) {
  return Object.fromEntries(entry.actions.map((action) => [action.kind, action.authorized]));
}

describe("G002 data intake projection", () => {
  it("derives bounded workflow statuses from existing film_orders without parallel storage", async () => {
    const seven = await entryFor("S7-G002-LINKED");
    expect(seven).toMatchObject({
      ownerDomain: "seven",
      state: "linked",
      makerHandoffStatus: "registered",
      proofStatus: "requested",
      dualApprovalStatus: "owner_approved",
      poStatus: "not_sent",
    });
    const kanei = await entryFor("KT-G002-PO");
    expect(kanei).toMatchObject({
      ownerDomain: "kanei",
      state: "linked",
      makerHandoffStatus: "not_registered",
      proofStatus: "pending",
      dualApprovalStatus: "pending",
      poStatus: "sent",
    });
    const unresolved = await entryFor("UNRESOLVED-G002");
    expect(unresolved).toMatchObject({
      ownerDomain: "unresolved",
      state: "unresolved_owner",
      makerHandoffStatus: "unavailable",
      proofStatus: "unavailable",
      dualApprovalStatus: "pending",
      poStatus: "unavailable",
    });
  });

  it("supports search, every bounded filter, and stable bounded pagination", async () => {
    const firstPage = await listFilmOrderIntakePage({ page: 1, pageSize: 2 }, null);
    expect(firstPage).toMatchObject({ total: 3, page: 1, pageSize: 2, pageCount: 2, hasNext: true, hasPrevious: false });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.entries.map((entry) => entry.quotationId)).toEqual([sevenQuote.id, kaneiQuote.id]);

    const secondPage = await listFilmOrderIntakePage({ page: 2, pageSize: 2 }, null);
    expect(secondPage).toMatchObject({ total: 3, page: 2, pageCount: 2, hasNext: false, hasPrevious: true });
    expect(secondPage.entries.map((entry) => entry.quotationId)).toEqual([unresolvedQuote.id]);

    await expect(listFilmOrderIntakePage({ search: "S7-G002-LINKED" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: sevenQuote.id }] });
    await expect(listFilmOrderIntakePage({ owner: "kanei" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: kaneiQuote.id }] });
    await expect(listFilmOrderIntakePage({ intakeState: "unresolved_owner" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: unresolvedQuote.id }] });
    await expect(listFilmOrderIntakePage({ makerHandoff: "registered" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: sevenQuote.id }] });
    await expect(listFilmOrderIntakePage({ proof: "requested" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: sevenQuote.id }] });
    await expect(listFilmOrderIntakePage({ dualApproval: "owner_approved" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: sevenQuote.id }] });
    await expect(listFilmOrderIntakePage({ po: "sent" }, null))
      .resolves.toMatchObject({ total: 1, entries: [{ quotationId: kaneiQuote.id }] });
    await expect(listFilmOrderIntakePage({ page: 99, pageSize: 200 }, null))
      .resolves.toMatchObject({ page: 99, pageSize: 100, entries: [] });
  });

  it("projects owner-specific actions with implemented and future boundaries", async () => {
    const sevenActions = authorization(await entryFor("S7-G002-LINKED", sevenUser));
    expect(sevenActions).toEqual({
      intake_upload: true,
      maker_handoff: false,
      proof_round: false,
      owner_approval: true,
      kanei_approval: false,
      purchase_order: false,
      delivery_note: false,
    });

    const kaneiActions = authorization(await entryFor("KT-G002-PO", kaneiUser));
    expect(kaneiActions).toEqual({
      intake_upload: true,
      maker_handoff: true,
      proof_round: true,
      owner_approval: true,
      kanei_approval: true,
      purchase_order: true,
      delivery_note: true,
    });

    const seven = await entryFor("S7-G002-LINKED", sevenUser);
    for (const action of seven.actions) {
      if (["intake_upload"].includes(action.kind)) {
        expect(action.enabled).toBe(true);
      } else if (action.kind === "proof_round") {
        expect(action.enabled).toBe(true);
      } else if (action.kind === "owner_approval") {
        expect(action.enabled).toBe(false);
      } else if (action.kind === "kanei_approval") {
        expect(action.enabled).toBe(true);
      } else {
        expect(action.enabled).toBe(false);
      }
    }
  });

  it("keeps API access owner-shared and neutral-admin read-only", async () => {
    const request = async (token?: string, search = "?pageSize=2") => dataIntakeRoute(new Request(`http://localhost/api/data-intake${search}`, {
      headers: token ? { cookie: `pouch_session=${token}` } : {},
    }));
    const unauthorized = await request();
    expect(unauthorized.status).toBe(401);

    const outsideSession = await createSession(outsideUser.id);
    const forbidden = await request(outsideSession.token);
    expect(forbidden.status).toBe(403);

    const sevenSession = await createSession(sevenUser.id);
    const kaneiSession = await createSession(kaneiUser.id);
    const sevenResponse = await request(sevenSession.token, "?owner=seven");
    const kaneiResponse = await request(kaneiSession.token, "?owner=seven");
    expect(sevenResponse.status).toBe(200);
    expect(kaneiResponse.status).toBe(200);
    const sevenPayload = await sevenResponse.json();
    const kaneiPayload = await kaneiResponse.json();
    expect(sevenPayload.entries).toHaveLength(1);
    expect(kaneiPayload.entries).toHaveLength(1);
    expect(kaneiPayload.entries[0].actions.find((action: { kind: string }) => action.kind === "intake_upload").authorized).toBe(false);
    expect(JSON.stringify(kaneiPayload)).not.toContain("makerEmail");

    const neutralSession = await createSession(neutralAdmin.id);
    const neutralResponse = await request(neutralSession.token, "?pageSize=2");
    expect(neutralResponse.status).toBe(200);
    const neutralPayload = await neutralResponse.json();
    expect(neutralPayload.entries).toHaveLength(2);
    expect(neutralPayload.entries.every((entry: { actions: Array<{ authorized: boolean }> }) =>
      entry.actions.every((action) => !action.authorized),
    )).toBe(true);

    const badQuery = await request(sevenSession.token, "?page=0");
    expect(badQuery.status).toBe(400);
  });
});
