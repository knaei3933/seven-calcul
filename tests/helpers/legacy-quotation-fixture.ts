import type { QuotationRecord, QuotationRecordInput } from "@/lib/quotation-shared";
import type { UserRole } from "@/lib/auth-store";

export type LegacyQuotationSave = (
  value: QuotationRecordInput,
  actorId: number,
  actorRole?: UserRole,
) => Promise<QuotationRecord>;

/**
 * Existing suites intentionally seed pre-cutover durable rows. Production never
 * calls this wrapper: new records remain on the centralized Kanei/KT path.
 */
export function withLegacySevenQuotationSave(saveQuotationDirect: LegacyQuotationSave): LegacyQuotationSave {
  return async (value, actorId, actorRole = "user") => {
    if (!/^S7-/i.test(value.quotationNumber)) return saveQuotationDirect(value, actorId, actorRole);
    const quotationNumber = value.quotationNumber;
    const { getQuotationByNumber } = await import("@/lib/quotation-store");
    if (await getQuotationByNumber(quotationNumber)) {
      return saveQuotationDirect(value, actorId, actorRole);
    }
    const assigned = await saveQuotationDirect({ ...value, quotationNumber: "" }, actorId, actorRole);
    const { getDatabaseForTest, getQuotation } = await import("@/lib/quotation-store");
    const db = await getDatabaseForTest();
    await db.run(
      "UPDATE quotations SET owner_domain = 'seven', quotation_number = ?, payload_json = ? WHERE id = ?",
      [
        quotationNumber,
        JSON.stringify({ ...value.payload, ownerDomain: "seven" }),
        assigned.id,
      ],
    );
    return (await getQuotation(assigned.id))!;
  };
}
