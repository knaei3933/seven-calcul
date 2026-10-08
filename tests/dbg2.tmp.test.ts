import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
const d = await mkdtemp(join(tmpdir(), "dbg2-"));
process.env.POUCH_QUOTATION_DB = join(d, "q.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-dbg-password";
const { saveQuotation } = await import("@/lib/quotation-store");
const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const { syncFilmOrdersFromQuotations } = await import("@/lib/film-orders");
describe("dbg2", () => {
  it("syncs", async () => {
    const aid = await ensureAdministratorSeed();
    await saveQuotation({
      quotationNumber: "S7-DBG2", status: "approved", issueDate: "2026-10-08", validUntil: "2026-11-08",
      customerName: "c", customerContact: "", productName: "p", sizeSummary: "s", quantity: "1",
      fillingCostPerPiece: "0", filmCostPerPiece: "0", filmMeterPrice: "0", filmOrderLengthM: "0",
      targetMargin: "0", taxRatePercent: "0", pricePerPiece: "0", subtotal: "0", tax: "0", grandTotal: "0",
      deliveryDate: "", paymentTerms: "", notes: "", calculationVersion: "x", resultHash: "", payload: {},
    }, aid, "admin");
    try {
      const n = await syncFilmOrdersFromQuotations("a@b.c");
      console.log("SYNC OK:", n);
    } catch (e) {
      console.log("SYNC ERR:", e instanceof Error ? e.message : String(e));
    }
    expect(true).toBe(true);
  });
});
